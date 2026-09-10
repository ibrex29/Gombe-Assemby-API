import { createHash } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CollationLevel,
  JwtPayload,
  NotificationType,
  ScopeType,
  TriageOutlook,
  TriageRiskLevel,
} from '@electromon/shared';
import { Prisma } from '@electromon/db';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NOTIFICATION_DISPATCH_EVENT,
  type NotificationDispatchPayload,
} from '../../notifications/notification.events';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  TRIAGE_ENGINE_VERSION,
  TriageInputs,
  scoreTriage,
} from './scoring/triage-scoring';
import {
  TriageInputCollectorService,
  type TriageTarget,
} from './triage-input-collector.service';

/**
 * Computes and stores triage scores.
 *
 * Two properties matter at national scale:
 *  - an unchanged inputs hash writes no snapshot, so a quiet sweep costs nothing;
 *  - polling-unit snapshots are written only on a transition, because 176,000
 *    rows per sweep would swamp the history table within an hour.
 */
/** A band or outlook change, as both the caller and the notifier need it. */
export interface TransitionRecord {
  scopeId: string;
  name: string;
  level: CollationLevel;
  scopeType: ScopeType;
  stateId: string | null;
  from: TriageRiskLevel;
  to: TriageRiskLevel;
  compositeScore: number;
  /** Top driver, already generated from the numbers by the engine. */
  driver: string | null;
}

@Injectable()
export class TriageService {
  private readonly logger = new Logger(TriageService.name);

  constructor(
    private prisma: PrismaService,
    private collector: TriageInputCollectorService,
    private eventEmitter: EventEmitter2,
  ) {}

  private async assertCampaignAccess(userId: string, campaignId: string) {
    const membership = await this.prisma.campaignMembership.findFirst({
      where: { userId, campaignId, isActive: true },
    });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this campaign');
    }
    return membership;
  }

  /** Stable fingerprint of the signals, so no-change sweeps are cheap. */
  private hashInputs(inputs: TriageInputs): string {
    const material = JSON.stringify({
      r: inputs.pollingUnitsReported,
      t: inputs.pollingUnitsTotal,
      c: inputs.clientVotes,
      v: inputs.rivalVotes,
      tv: inputs.totalVotes,
      reg: inputs.registeredVoters,
      acc: inputs.accreditedVoters,
      // Incident ages change constantly; only their count and severities matter
      // for deciding whether anything materially moved.
      inc: inputs.incidents
        .map((incident) => incident.severity ?? 'LOW')
        .sort(),
      s: inputs.resultsScored,
      f: inputs.resultsFlagged,
      cp: inputs.resultsCheckPhoto,
      sent: inputs.negativeSentimentShare,
      // Election mode switches whole components on and off, so it changes the
      // score even when the underlying data has not moved.
      em: inputs.electionMode,
    });
    return createHash('sha1').update(material).digest('hex');
  }

  /**
   * Scores every target and upserts the results.
   *
   * @returns how many scores changed, and any risk transitions worth alerting on
   */
  async rescore(
    campaignId: string,
    level: CollationLevel.STATE | CollationLevel.LGA,
    electionMode: boolean,
    /** Whose action this is, for notification attribution. Omit to stay silent. */
    notifyActorId?: string,
  ) {
    const targets = await this.collector.listTargets(campaignId, level);
    const inputsByScope = await this.collector.collect(
      campaignId,
      targets,
      electionMode,
    );
    const items = targets.flatMap((target) => {
      const inputs = inputsByScope.get(target.scopeId);
      return inputs ? [{ target, inputs }] : [];
    });

    const outcome = await this.persistScores(campaignId, level, items);
    if (notifyActorId) {
      await this.notifyTransitions(
        campaignId,
        outcome.transitions,
        notifyActorId,
      );
    }
    this.logger.log(
      `Triage ${level}: ${outcome.changed} changed, ${outcome.unchanged} unchanged, ${outcome.transitions.length} transitions`,
    );
    return { level, scored: targets.length, ...outcome };
  }

  /**
   * Scores the children of one scope on demand.
   *
   * Wards and polling units are never swept wholesale -- see the note on
   * `collectChildren`. Drilling scores just this parent's children, so an
   * operator gets a live answer for the place they are looking at.
   */
  async rescoreChildren(
    campaignId: string,
    level: CollationLevel.WARD | CollationLevel.POLLING_UNIT,
    parentId: string,
    electionMode: boolean,
  ) {
    const items = await this.collector.collectChildren(
      campaignId,
      level,
      parentId,
      electionMode,
    );
    const outcome = await this.persistScores(campaignId, level, items);
    return { level, scored: items.length, ...outcome };
  }

  /**
   * The scoring loop, shared by the sweep and by drill-down.
   *
   * Existing rows are fetched by scope id rather than by level: a ward drill
   * must not pull all 8,809 ward rows to update eleven of them.
   */
  private async persistScores(
    campaignId: string,
    level: CollationLevel,
    items: Array<{ target: TriageTarget; inputs: TriageInputs }>,
  ) {
    const transitions: TransitionRecord[] = [];
    let changed = 0;
    let unchanged = 0;

    if (items.length === 0) return { changed, unchanged, transitions };

    const existing = await this.prisma.triageScore.findMany({
      where: {
        campaignId,
        level,
        scopeId: { in: items.map((item) => item.target.scopeId) },
      },
      select: {
        scopeId: true,
        inputsHash: true,
        engineVersion: true,
        riskLevel: true,
        outlook: true,
        lastTransitionAt: true,
      },
    });
    const existingByScope = new Map(existing.map((row) => [row.scopeId, row]));

    for (const { target, inputs } of items) {
      const previous = existingByScope.get(target.scopeId);
      const hash = this.hashInputs(inputs);

      // Same inputs is not enough: a row written by an older engine build can
      // hold a stale score, or lack outputs this build produces. Without the
      // version check those rows would never be rewritten, because nothing
      // about the campaign has to change for the engine to.
      if (
        previous?.inputsHash === hash &&
        previous.engineVersion === TRIAGE_ENGINE_VERSION
      ) {
        // Nothing material moved; just record that we looked.
        await this.prisma.triageScore.updateMany({
          where: {
            campaignId,
            level,
            scopeType: target.scopeType,
            scopeId: target.scopeId,
          },
          data: { computedAt: new Date() },
        });
        unchanged += 1;
        continue;
      }

      // Prisma generates enums as string unions; the shared enums are nominal TS
      // enums, so they need an explicit cast where the two meet.
      const previousRisk =
        (previous?.riskLevel as TriageRiskLevel | undefined) ?? null;
      const result = scoreTriage(inputs, previousRisk);
      // Prisma's generated enums and the shared package's nominal enums carry the
      // same runtime strings but are distinct types; compare as strings.
      const transitioned =
        !!previous &&
        (String(previous.riskLevel) !== String(result.riskLevel) ||
          String(previous.outlook) !== String(result.outlook));

      await this.prisma.triageScore.upsert({
        where: {
          campaignId_level_scopeType_scopeId: {
            campaignId,
            level: target.level,
            scopeType: target.scopeType,
            scopeId: target.scopeId,
          },
        },
        create: {
          campaignId,
          level: target.level,
          scopeType: target.scopeType,
          scopeId: target.scopeId,
          stateId: target.stateId,
          outlook: result.outlook,
          riskLevel: result.riskLevel,
          compositeScore: result.compositeScore,
          componentScores: result.componentScores,
          drivers: result.drivers,
          factors: result.factors as unknown as Prisma.InputJsonValue,
          inputsHash: hash,
          engineVersion: TRIAGE_ENGINE_VERSION,
        },
        update: {
          stateId: target.stateId,
          outlook: result.outlook,
          riskLevel: result.riskLevel,
          compositeScore: result.compositeScore,
          componentScores: result.componentScores,
          drivers: result.drivers,
          factors: result.factors as unknown as Prisma.InputJsonValue,
          inputsHash: hash,
          engineVersion: TRIAGE_ENGINE_VERSION,
          computedAt: new Date(),
          ...(transitioned
            ? {
                previousOutlook: previous?.outlook,
                previousRiskLevel: previous?.riskLevel,
                lastTransitionAt: new Date(),
              }
            : {}),
        },
      });

      // Ward and above snapshot on any material change; polling units would
      // need a transition (not reachable at these levels, but the rule lives
      // here so it holds when PU scoring is added).
      const snapshotWorthy =
        target.level !== CollationLevel.POLLING_UNIT || transitioned;
      if (snapshotWorthy) {
        await this.prisma.triageSnapshot.create({
          data: {
            campaignId,
            level: target.level,
            scopeType: target.scopeType,
            scopeId: target.scopeId,
            outlook: result.outlook,
            riskLevel: result.riskLevel,
            compositeScore: result.compositeScore,
            componentScores: result.componentScores,
            engineVersion: TRIAGE_ENGINE_VERSION,
          },
        });
      }

      if (transitioned && previous) {
        // Kept rather than logged: the board's movement feed and the risk
        // notifications both read from here, and a transition that was only
        // ever a log line could not be shown to anyone after the fact.
        await this.prisma.triageTransition.create({
          data: {
            campaignId,
            level: target.level,
            scopeType: target.scopeType,
            scopeId: target.scopeId,
            scopeName: target.name,
            stateId: target.stateId,
            fromRisk: previous.riskLevel,
            toRisk: result.riskLevel,
            fromOutlook: previous.outlook,
            toOutlook: result.outlook,
            compositeScore: result.compositeScore,
          },
        });

        transitions.push({
          scopeId: target.scopeId,
          name: target.name,
          level: target.level,
          scopeType: target.scopeType,
          stateId: target.stateId,
          from: previous.riskLevel as TriageRiskLevel,
          to: result.riskLevel,
          compositeScore: result.compositeScore,
          driver: result.drivers[0] ?? null,
        });
      }
      changed += 1;
    }

    return { changed, unchanged, transitions };
  }

  /** Board view: every scored scope at a level, worst first. */
  async overview(
    user: JwtPayload,
    level: CollationLevel.STATE | CollationLevel.LGA,
    riskLevel?: TriageRiskLevel,
  ) {
    if (!user.campaignId)
      throw new ForbiddenException('Campaign membership required');
    await this.assertCampaignAccess(user.sub, user.campaignId);

    const scores = await this.prisma.triageScore.findMany({
      where: {
        campaignId: user.campaignId,
        level,
        ...(riskLevel ? { riskLevel } : {}),
      },
      orderBy: [{ compositeScore: 'desc' }],
      take: 800,
    });

    const scopeIds = scores.map((score) => score.scopeId);
    const [meta, trends, acks, recentTransitions] = await Promise.all([
      this.resolveScopeMeta(level, scopeIds),
      this.loadTrends(user.campaignId, level),
      this.loadAcks(user.campaignId, scopeIds),
      this.transitions(user, { limit: 5, direction: 'RAISED' }),
    ]);

    const rows = scores.map((score) => {
      const trend = trends.get(score.scopeId) ?? [];
      // Direction matters more than level in a war room, so the delta is
      // computed here rather than left for the client to infer.
      const delta =
        trend.length >= 2
          ? Math.round((trend[trend.length - 1] - trend[0]) * 10) / 10
          : 0;
      return {
        scopeId: score.scopeId,
        trend,
        delta,
        name: meta.get(score.scopeId)?.name ?? score.scopeId,
        stateCode: meta.get(score.scopeId)?.stateCode ?? null,
        // An ack only counts while it postdates the last move; a fresh
        // transition means the acknowledged situation no longer exists.
        ack: (() => {
          const ack = acks.get(score.scopeId);
          if (!ack) return null;
          if (score.lastTransitionAt && ack.at <= score.lastTransitionAt) {
            return null;
          }
          return { by: ack.by, at: ack.at, note: ack.note };
        })(),
        outlook: score.outlook,
        riskLevel: score.riskLevel,
        compositeScore: score.compositeScore,
        componentScores: score.componentScores,
        drivers: score.drivers,
        factors: score.factors,
        previousRiskLevel: score.previousRiskLevel,
        lastTransitionAt: score.lastTransitionAt,
        computedAt: score.computedAt,
      };
    });

    const tally = (value: TriageRiskLevel) =>
      rows.filter((row) => String(row.riskLevel) === String(value)).length;
    const outlookTally = (value: TriageOutlook) =>
      rows.filter((row) => String(row.outlook) === String(value)).length;

    return {
      level,
      unitLabel: level === CollationLevel.STATE ? 'States' : 'LGAs',
      engineVersion: TRIAGE_ENGINE_VERSION,
      recentTransitions: recentTransitions.rows,
      summary: {
        scored: rows.length,
        // The number a war room drives to zero: hot and nobody has it.
        needsAttention: rows.filter(
          (row) =>
            (String(row.riskLevel) === 'HIGH' ||
              String(row.riskLevel) === 'CRITICAL') &&
            row.ack === null,
        ).length,
        critical: tally(TriageRiskLevel.CRITICAL),
        high: tally(TriageRiskLevel.HIGH),
        medium: tally(TriageRiskLevel.MEDIUM),
        low: tally(TriageRiskLevel.LOW),
        winning:
          outlookTally(TriageOutlook.WINNING) +
          outlookTally(TriageOutlook.LEANING_WIN),
        losing:
          outlookTally(TriageOutlook.LOSING) +
          outlookTally(TriageOutlook.LEANING_LOSS),
        tossup: outlookTally(TriageOutlook.TOSSUP),
        unknown: outlookTally(TriageOutlook.UNKNOWN),
      },
      rows,
    };
  }

  /**
   * Drill into a scope: score its children on demand and return them.
   *
   * Scored on the way in rather than read from a sweep, because wards and
   * polling units are not swept -- an operator opening an LGA should see the
   * position as it stands now, not whenever a sweep last reached it.
   */
  async children(
    user: JwtPayload,
    level: CollationLevel.WARD | CollationLevel.POLLING_UNIT,
    parentId: string,
    electionMode: boolean,
  ) {
    if (!user.campaignId)
      throw new ForbiddenException('Campaign membership required');
    await this.assertCampaignAccess(user.sub, user.campaignId);

    const parent = await this.describeParent(level, parentId);
    await this.rescoreChildren(user.campaignId, level, parentId, electionMode);

    const targets = await this.collector.collectChildren(
      user.campaignId,
      level,
      parentId,
      electionMode,
    );
    const names = new Map(
      targets.map((item) => [item.target.scopeId, item.target.name]),
    );
    const scopeIds = [...names.keys()];
    if (scopeIds.length === 0) {
      return {
        level,
        unitLabel: level === CollationLevel.WARD ? 'Wards' : 'Polling units',
        parent,
        engineVersion: TRIAGE_ENGINE_VERSION,
        rows: [],
      };
    }

    const [scores, trends] = await Promise.all([
      this.prisma.triageScore.findMany({
        where: {
          campaignId: user.campaignId,
          level,
          scopeId: { in: scopeIds },
        },
        orderBy: [{ compositeScore: 'desc' }],
      }),
      this.loadTrends(user.campaignId, level, scopeIds),
    ]);

    const rows = scores.map((score) => {
      const trend = trends.get(score.scopeId) ?? [];
      const delta =
        trend.length >= 2
          ? Math.round((trend[trend.length - 1] - trend[0]) * 10) / 10
          : 0;
      return {
        scopeId: score.scopeId,
        trend,
        delta,
        name: names.get(score.scopeId) ?? score.scopeId,
        stateCode: null,
        outlook: score.outlook,
        riskLevel: score.riskLevel,
        compositeScore: score.compositeScore,
        componentScores: score.componentScores,
        drivers: score.drivers,
        factors: score.factors,
        previousRiskLevel: score.previousRiskLevel,
        lastTransitionAt: score.lastTransitionAt,
        computedAt: score.computedAt,
      };
    });

    return {
      level,
      unitLabel: level === CollationLevel.WARD ? 'Wards' : 'Polling units',
      parent,
      engineVersion: TRIAGE_ENGINE_VERSION,
      rows,
    };
  }

  /** Breadcrumb for the scope being drilled into. */
  private async describeParent(
    level: CollationLevel.WARD | CollationLevel.POLLING_UNIT,
    parentId: string,
  ) {
    if (level === CollationLevel.WARD) {
      const lga = await this.prisma.lGA.findUnique({
        where: { id: parentId },
        select: {
          id: true,
          name: true,
          state: { select: { id: true, name: true } },
        },
      });
      if (!lga) throw new NotFoundException('LGA not found');
      return {
        scopeType: ScopeType.LGA,
        scopeId: lga.id,
        name: lga.name,
        stateId: lga.state?.id ?? null,
        stateName: lga.state?.name ?? null,
        lgaId: lga.id,
        lgaName: lga.name,
      };
    }

    const ward = await this.prisma.ward.findUnique({
      where: { id: parentId },
      select: {
        id: true,
        name: true,
        lga: {
          select: {
            id: true,
            name: true,
            state: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!ward) throw new NotFoundException('Ward not found');
    return {
      scopeType: ScopeType.WARD,
      scopeId: ward.id,
      name: ward.name,
      stateId: ward.lga?.state?.id ?? null,
      stateName: ward.lga?.state?.name ?? null,
      lgaId: ward.lga?.id ?? null,
      lgaName: ward.lga?.name ?? null,
    };
  }

  /** One scope, with its recent history. */
  async scopeDetail(user: JwtPayload, scopeType: ScopeType, scopeId: string) {
    if (!user.campaignId)
      throw new ForbiddenException('Campaign membership required');
    await this.assertCampaignAccess(user.sub, user.campaignId);

    const score = await this.prisma.triageScore.findFirst({
      where: { campaignId: user.campaignId, scopeType, scopeId },
    });
    const history = await this.prisma.triageSnapshot.findMany({
      where: { campaignId: user.campaignId, scopeType, scopeId },
      orderBy: { computedAt: 'desc' },
      take: 50,
      select: {
        outlook: true,
        riskLevel: true,
        compositeScore: true,
        computedAt: true,
      },
    });

    return { score, history };
  }

  /**
   * Recent score history per scope, oldest first, for sparklines.
   *
   * A window function keeps this to one bounded query: fetching all snapshots
   * and slicing in JS would grow without limit as sweeps accumulate.
   */
  private async loadTrends(
    campaignId: string,
    level: CollationLevel,
    scopeIds?: string[],
  ): Promise<Map<string, number[]>> {
    const rows = await this.prisma.$queryRaw<
      Array<{ scopeId: string; compositeScore: number }>
    >`
      SELECT "scopeId", "compositeScore"
      FROM (
        SELECT "scopeId", "compositeScore", "computedAt",
               row_number() OVER (PARTITION BY "scopeId" ORDER BY "computedAt" DESC) AS rn
        FROM triage_snapshots
        WHERE "campaignId" = ${campaignId} AND level = ${level}::"CollationLevel"
        AND (${scopeIds ?? null}::text[] IS NULL OR "scopeId" = ANY(${scopeIds ?? null}::text[]))
      ) recent
      WHERE rn <= 12
      ORDER BY "scopeId", "computedAt" ASC
    `;

    const out = new Map<string, number[]>();
    for (const row of rows) {
      const series = out.get(row.scopeId) ?? [];
      series.push(Number(row.compositeScore));
      out.set(row.scopeId, series);
    }
    return out;
  }

  /**
   * Names plus the state code each scope belongs to.
   *
   * The code is what the client needs to load that state's LGA geometry
   * (`/geo/lgas/{CODE}.geojson`); deriving it from the name in the browser
   * would mean a hardcoded 37-entry map, which the national rules rule out.
   */
  private async resolveScopeMeta(
    level: CollationLevel,
    scopeIds: string[],
  ): Promise<Map<string, { name: string; stateCode: string | null }>> {
    if (scopeIds.length === 0) return new Map();
    if (level === CollationLevel.STATE) {
      const states = await this.prisma.state.findMany({
        where: { id: { in: scopeIds } },
        select: { id: true, name: true, code: true },
      });
      return new Map(
        states.map((state) => [
          state.id,
          { name: state.name, stateCode: state.code },
        ]),
      );
    }
    const lgas = await this.prisma.lGA.findMany({
      where: { id: { in: scopeIds } },
      select: {
        id: true,
        name: true,
        state: { select: { name: true, code: true } },
      },
    });
    return new Map(
      lgas.map((lga) => [
        lga.id,
        {
          name: `${lga.name} (${lga.state.name})`,
          stateCode: lga.state.code ?? null,
        },
      ]),
    );
  }

  /* ---------------------------------------------------------------------- *
   * Movement feed and acknowledgements.
   * ---------------------------------------------------------------------- */

  /** RAISED means the band got worse; ordering is the band ladder, not the score. */
  private static readonly RISK_RANK: Record<string, number> = {
    LOW: 0,
    MEDIUM: 1,
    HIGH: 2,
    CRITICAL: 3,
  };

  private static rose(from: string, to: string): boolean {
    return (
      (TriageService.RISK_RANK[to] ?? 0) > (TriageService.RISK_RANK[from] ?? 0)
    );
  }

  /**
   * Latest acknowledgement per scope, but only where it still stands.
   *
   * An ack is voided by any transition that happened after it: the thing that
   * was acknowledged is no longer the thing on screen. Deriving that here means
   * no flag has to be reset anywhere when a score moves.
   */
  private async loadAcks(campaignId: string, scopeIds: string[]) {
    const out = new Map<
      string,
      { by: string; at: Date; note: string | null; riskLevel: string }
    >();
    if (scopeIds.length === 0) return out;

    const acks = await this.prisma.triageAcknowledgement.findMany({
      where: { campaignId, scopeId: { in: scopeIds } },
      orderBy: { createdAt: 'desc' },
      select: {
        scopeId: true,
        note: true,
        createdAt: true,
        riskLevel: true,
        createdBy: { select: { firstName: true, lastName: true } },
      },
    });

    // Newest first, so the first row seen per scope is the current one.
    for (const ack of acks) {
      if (out.has(ack.scopeId)) continue;
      out.set(ack.scopeId, {
        by: `${ack.createdBy.firstName} ${ack.createdBy.lastName}`.trim(),
        at: ack.createdAt,
        note: ack.note,
        riskLevel: ack.riskLevel,
      });
    }
    return out;
  }

  /** Recent band movements, worst-first within newest-first. */
  async transitions(
    user: JwtPayload,
    options: { limit?: number; direction?: 'ALL' | 'RAISED' | 'CLEARED' } = {},
  ) {
    if (!user.campaignId)
      throw new ForbiddenException('Campaign membership required');
    await this.assertCampaignAccess(user.sub, user.campaignId);

    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const direction = options.direction ?? 'ALL';

    // Filtering by direction needs the rank comparison, which the database does
    // not know about, so a slightly wider page is read and trimmed here.
    const rows = await this.prisma.triageTransition.findMany({
      where: { campaignId: user.campaignId },
      orderBy: { createdAt: 'desc' },
      take: direction === 'ALL' ? limit : limit * 4,
    });

    const filtered = rows.filter((row) => {
      if (direction === 'ALL') return true;
      const rose = TriageService.rose(row.fromRisk, row.toRisk);
      return direction === 'RAISED' ? rose : !rose;
    });

    const page = filtered.slice(0, limit);
    const [acks, states] = await Promise.all([
      this.loadAcks(user.campaignId, [...new Set(page.map((r) => r.scopeId))]),
      this.prisma.state.findMany({ select: { id: true, code: true } }),
    ]);
    const codeById = new Map(states.map((s) => [s.id, s.code]));

    return {
      rows: page.map((row) => {
        const ack = acks.get(row.scopeId);
        return {
          id: row.id,
          scopeId: row.scopeId,
          scopeType: row.scopeType,
          level: row.level,
          name: row.scopeName,
          stateCode: row.stateId ? (codeById.get(row.stateId) ?? null) : null,
          fromRisk: row.fromRisk,
          toRisk: row.toRisk,
          fromOutlook: row.fromOutlook,
          toOutlook: row.toOutlook,
          raised: TriageService.rose(row.fromRisk, row.toRisk),
          compositeScore: row.compositeScore,
          at: row.createdAt,
          acknowledged: Boolean(ack && ack.at > row.createdAt),
        };
      }),
    };
  }

  /**
   * Take responsibility for a hot scope.
   *
   * Snapshots the band and score being acknowledged, so a later reader can tell
   * whether the ack was about the situation they are looking at.
   */
  async acknowledge(
    user: JwtPayload,
    scopeType: ScopeType,
    scopeId: string,
    note?: string,
  ) {
    if (!user.campaignId)
      throw new ForbiddenException('Campaign membership required');
    await this.assertCampaignAccess(user.sub, user.campaignId);

    const score = await this.prisma.triageScore.findFirst({
      where: { campaignId: user.campaignId, scopeType, scopeId },
    });
    if (!score) {
      throw new NotFoundException('That place has no risk score to acknowledge');
    }

    const ack = await this.prisma.triageAcknowledgement.create({
      data: {
        campaignId: user.campaignId,
        level: score.level,
        scopeType,
        scopeId,
        riskLevel: score.riskLevel,
        compositeScore: score.compositeScore,
        note: note?.trim() || null,
        createdById: user.sub,
      },
      select: {
        createdAt: true,
        note: true,
        createdBy: { select: { firstName: true, lastName: true } },
      },
    });

    return {
      scopeId,
      acknowledged: true,
      by: `${ack.createdBy.firstName} ${ack.createdBy.lastName}`.trim(),
      at: ack.createdAt,
      note: ack.note,
    };
  }

  /**
   * Turn band movements into notifications.
   *
   * Only upward moves into HIGH or CRITICAL raise an alarm, and only CRITICAL
   * pushes to a phone; everything else is in-app. The sourceEventId is built
   * from the transition itself, so re-running a sweep cannot page anyone twice
   * — the notifications service dedupes on it.
   *
   * Drill-down rescoring passes `notify: false`: an operator browsing polling
   * units must not page the war room as a side effect of looking.
   */
  private async notifyTransitions(
    campaignId: string,
    transitions: TransitionRecord[],
    actorUserId: string,
  ) {
    if (transitions.length === 0 || !actorUserId) return;

    const stateIds = [
      ...new Set(
        transitions
          .map((t) => t.stateId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const states = stateIds.length
      ? await this.prisma.state.findMany({
          where: { id: { in: stateIds } },
          select: { id: true, code: true },
        })
      : [];
    const codeById = new Map(states.map((row) => [row.id, row.code]));

    for (const transition of transitions) {
      const rose = TriageService.rose(transition.from, transition.to);
      const hot =
        String(transition.to) === 'HIGH' || String(transition.to) === 'CRITICAL';
      const wasHot =
        String(transition.from) === 'HIGH' ||
        String(transition.from) === 'CRITICAL';

      // Raised into the hot bands, or cleared out of them. A move between LOW
      // and MEDIUM is real but not worth interrupting anyone for.
      if (rose && !hot) continue;
      if (!rose && !wasHot) continue;

      const critical = String(transition.to) === 'CRITICAL';
      const payload: NotificationDispatchPayload = {
        type: rose
          ? NotificationType.TRIAGE_RISK_RAISED
          : NotificationType.TRIAGE_RISK_CLEARED,
        campaignId,
        actorUserId,
        entityType: 'TRIAGE_SCORE',
        entityId: transition.scopeId,
        sourceEventId: `triage:${transition.scopeId}:${transition.from}->${transition.to}:${transition.compositeScore}`,
        sendPush: rose && critical,
        scopeName: transition.name,
        triage: {
          level: String(transition.level),
          scopeType: String(transition.scopeType),
          scopeId: transition.scopeId,
          fromRisk: String(transition.from),
          toRisk: String(transition.to),
          compositeScore: transition.compositeScore,
          driver: transition.driver,
          stateId: transition.stateId,
          stateCode: transition.stateId
            ? (codeById.get(transition.stateId) ?? null)
            : null,
        },
      };
      this.eventEmitter.emit(NOTIFICATION_DISPATCH_EVENT, payload);
    }
  }

  /**
   * Rescore only the scopes named, rather than a whole level.
   *
   * The drain path: an incident in one LGA should cost one LGA of work, not a
   * 774-row sweep. Unknown ids are ignored rather than erroring, because a
   * scope can legitimately disappear between being marked dirty and drained.
   */
  async rescoreScopes(
    campaignId: string,
    level: CollationLevel.STATE | CollationLevel.LGA,
    scopeIds: string[],
    electionMode: boolean,
    notifyActorId?: string,
  ) {
    if (scopeIds.length === 0) {
      return { level, scored: 0, changed: 0, unchanged: 0, transitions: [] };
    }

    const wanted = new Set(scopeIds);
    const all = await this.collector.listTargets(campaignId, level);
    const targets = all.filter((target) => wanted.has(target.scopeId));
    if (targets.length === 0) {
      return { level, scored: 0, changed: 0, unchanged: 0, transitions: [] };
    }

    const inputsByScope = await this.collector.collect(
      campaignId,
      targets,
      electionMode,
    );
    const items = targets.flatMap((target) => {
      const inputs = inputsByScope.get(target.scopeId);
      return inputs ? [{ target, inputs }] : [];
    });

    const outcome = await this.persistScores(campaignId, level, items);
    if (notifyActorId) {
      await this.notifyTransitions(
        campaignId,
        outcome.transitions,
        notifyActorId,
      );
    }
    return { level, scored: targets.length, ...outcome };
  }
}
