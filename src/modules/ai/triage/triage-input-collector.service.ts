import { Injectable } from '@nestjs/common';
import { Prisma } from '@electromon/db';
import {
  CollationLevel,
  FieldReportType,
  ScopeType,
  SocialSentiment,
} from '@electromon/shared';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { normalizeTrackedParties, getPartyCodes } from '@electromon/shared';
import { TriageInputs } from './scoring/triage-scoring';

/** One scope to score, and the geography it covers. */
export interface TriageTarget {
  level: CollationLevel;
  scopeType: ScopeType;
  scopeId: string;
  name: string;
  stateId: string | null;
  /** LGAs beneath this scope. For an LGA target, itself. */
  lgaIds: string[];
}

/**
 * Turns raw campaign data into scoring inputs.
 *
 * Written to collect for *many* scopes in one pass rather than per scope: at
 * national scale a per-scope query would mean 774 round trips for the LGA sweep
 * alone. Everything here is grouped or aggregated in the database; nothing walks
 * 176,000 polling units into memory.
 */
@Injectable()
export class TriageInputCollectorService {
  constructor(private prisma: PrismaService) {}

  /** Campaign-level facts every scope needs. */
  async loadCampaignContext(campaignId: string) {
    const campaign = await this.prisma.campaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: {
        id: true,
        stateId: true,
        isNational: true,
        clientPartyCode: true,
        trackedParties: true,
      },
    });
    const partyColumns = getPartyCodes(
      normalizeTrackedParties(campaign.trackedParties),
    );
    return { ...campaign, partyColumns };
  }

  /**
   * Targets for a sweep. STATE on a national campaign, otherwise LGA — those
   * are the levels a command room actually reads.
   */
  async listTargets(
    campaignId: string,
    level: CollationLevel.STATE | CollationLevel.LGA,
  ): Promise<TriageTarget[]> {
    const context = await this.loadCampaignContext(campaignId);

    if (level === CollationLevel.STATE) {
      const states = await this.prisma.state.findMany({
        where: context.isNational ? {} : { id: context.stateId },
        select: { id: true, name: true, lgas: { select: { id: true } } },
        orderBy: { name: 'asc' },
      });
      return states.map((state) => ({
        level: CollationLevel.STATE,
        scopeType: ScopeType.STATE,
        scopeId: state.id,
        name: state.name,
        stateId: state.id,
        lgaIds: state.lgas.map((lga) => lga.id),
      }));
    }

    const lgas = await this.prisma.lGA.findMany({
      where: context.isNational ? {} : { stateId: context.stateId },
      select: { id: true, name: true, stateId: true },
      orderBy: { name: 'asc' },
    });
    return lgas.map((lga) => ({
      level: CollationLevel.LGA,
      scopeType: ScopeType.LGA,
      scopeId: lga.id,
      name: lga.name,
      stateId: lga.stateId,
      lgaIds: [lga.id],
    }));
  }

  /**
   * Collects inputs for every target in one batch.
   *
   * @param electionMode enables the time-sensitive components (coverage, staleness)
   */
  async collect(
    campaignId: string,
    targets: TriageTarget[],
    electionMode: boolean,
  ): Promise<Map<string, TriageInputs>> {
    const context = await this.loadCampaignContext(campaignId);
    const allLgaIds = [...new Set(targets.flatMap((target) => target.lgaIds))];

    const [puCounts, results, incidents, lastSignals, sentiment] =
      await Promise.all([
        this.countPollingUnitsByLga(allLgaIds),
        this.loadPuResultsByLga(campaignId, allLgaIds),
        this.loadOpenIncidentsByLga(campaignId, allLgaIds),
        this.loadLastSignalByLga(campaignId, allLgaIds),
        this.loadSentimentByScope(campaignId, targets),
      ]);

    const now = Date.now();
    const out = new Map<string, TriageInputs>();

    for (const target of targets) {
      let pollingUnitsTotal = 0;
      let pollingUnitsReported = 0;
      let clientVotes = 0;
      let totalVotes = 0;
      let registeredVoters = 0;
      let accreditedVoters = 0;
      let resultsScored = 0;
      let resultsFlagged = 0;
      let resultsCheckPhoto = 0;
      const partyTotals: Record<string, number> = {};
      const scopeIncidents: TriageInputs['incidents'] = [];
      let lastSignal: Date | null = null;

      for (const lgaId of target.lgaIds) {
        pollingUnitsTotal += puCounts.get(lgaId) ?? 0;

        const bucket = results.get(lgaId);
        if (bucket) {
          pollingUnitsReported += bucket.reported;
          totalVotes += bucket.totalVotes;
          registeredVoters += bucket.registeredVoters;
          accreditedVoters += bucket.accreditedVoters;
          resultsScored += bucket.scored;
          resultsFlagged += bucket.flagged;
          resultsCheckPhoto += bucket.checkPhoto;
          for (const [code, votes] of Object.entries(bucket.partyTotals)) {
            partyTotals[code] = (partyTotals[code] ?? 0) + votes;
          }
        }

        for (const incident of incidents.get(lgaId) ?? []) {
          scopeIncidents.push({
            severity: incident.severity,
            urgent: incident.urgent,
            ageHours: (now - incident.createdAt.getTime()) / 3_600_000,
          });
        }

        const signal = lastSignals.get(lgaId);
        if (signal && (!lastSignal || signal > lastSignal)) lastSignal = signal;
      }

      const scopeSentiment = sentiment.get(target.scopeId) ?? {
        negativeShare: null,
        postCount: 0,
      };

      if (context.clientPartyCode) {
        clientVotes = partyTotals[context.clientPartyCode] ?? 0;
      }
      // The rival that matters is whoever is actually leading against us.
      const rivalVotes = Math.max(
        0,
        ...Object.entries(partyTotals)
          .filter(([code]) => code !== context.clientPartyCode)
          .map(([, votes]) => votes),
      );

      out.set(target.scopeId, {
        level: target.level,
        pollingUnitsTotal,
        pollingUnitsReported,
        clientVotes,
        rivalVotes,
        totalVotes,
        clientPartyCode: context.clientPartyCode,
        registeredVoters,
        accreditedVoters,
        incidents: scopeIncidents,
        resultsScored,
        resultsFlagged,
        resultsCheckPhoto,
        minutesSinceLastSignal: lastSignal
          ? (now - lastSignal.getTime()) / 60_000
          : null,
        negativeSentimentShare: scopeSentiment.negativeShare,
        sentimentPostCount: scopeSentiment.postCount,
        electionMode,
      });
    }

    return out;
  }

  /**
   * Polling units per LGA.
   *
   * These aggregates are raw SQL on purpose. The obvious Prisma version resolves
   * polling units to ids and passes them as `id: { in: [...] }`, which at national
   * scale is an IN list of 176,000 values — that blows Prisma's query interpreter
   * stack outright. The database does the grouping and returns one row per LGA.
   */
  private async countPollingUnitsByLga(
    lgaIds: string[],
  ): Promise<Map<string, number>> {
    if (lgaIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<
      Array<{ lgaId: string; total: bigint }>
    >`
      SELECT w."lgaId" AS "lgaId", count(pu.id)::bigint AS total
      FROM polling_units pu
      JOIN wards w ON w.id = pu."wardId"
      WHERE w."lgaId" = ANY(${lgaIds})
      GROUP BY w."lgaId"
    `;
    return new Map(rows.map((row) => [row.lgaId, Number(row.total)]));
  }

  private async loadPuResultsByLga(campaignId: string, lgaIds: string[]) {
    const out = new Map<
      string,
      {
        reported: number;
        totalVotes: number;
        registeredVoters: number;
        accreditedVoters: number;
        scored: number;
        flagged: number;
        checkPhoto: number;
        partyTotals: Record<string, number>;
      }
    >();
    if (lgaIds.length === 0) return out;

    const empty = () => ({
      reported: 0,
      totalVotes: 0,
      registeredVoters: 0,
      accreditedVoters: 0,
      scored: 0,
      flagged: 0,
      checkPhoto: 0,
      partyTotals: {} as Record<string, number>,
    });

    // EC8A figures and verification verdicts, grouped by LGA.
    const totals = await this.prisma.$queryRaw<
      Array<{
        lgaId: string;
        reported: bigint;
        registered: bigint;
        accredited: bigint;
        scored: bigint;
        flagged: bigint;
        checkPhoto: bigint;
      }>
    >`
      SELECT w."lgaId" AS "lgaId",
             count(*)::bigint AS reported,
             coalesce(sum(cr."registeredVoters"), 0)::bigint AS registered,
             coalesce(sum(cr."accreditedVoters"), 0)::bigint AS accredited,
             count(cr."ocrVerification")::bigint AS scored,
             coalesce(sum(CASE WHEN cr."ocrVerification"->>'recommendation' = 'RETURN'
                               THEN 1 ELSE 0 END), 0)::bigint AS "flagged",
             coalesce(sum(CASE WHEN cr."ocrVerification"->>'recommendation' = 'CHECK_PHOTO'
                               THEN 1 ELSE 0 END), 0)::bigint AS "checkPhoto"
      FROM collation_results cr
      JOIN polling_units pu ON pu.id = cr."scopeId"
      JOIN wards w ON w.id = pu."wardId"
      WHERE cr."campaignId" = ${campaignId}
        AND cr.level = 'POLLING_UNIT'
        AND cr.status IN ('SUBMITTED', 'APPROVED', 'REJECTED')
        AND w."lgaId" = ANY(${lgaIds})
      GROUP BY w."lgaId"
    `;

    for (const row of totals) {
      const bucket = empty();
      bucket.reported = Number(row.reported);
      bucket.registeredVoters = Number(row.registered);
      bucket.accreditedVoters = Number(row.accredited);
      bucket.scored = Number(row.scored);
      bucket.flagged = Number(row.flagged);
      bucket.checkPhoto = Number(row.checkPhoto);
      out.set(row.lgaId, bucket);
    }

    // Party votes live in a JSONB map with dynamic keys, so they are expanded
    // and summed per party in the database rather than parsed row by row.
    const parties = await this.prisma.$queryRaw<
      Array<{ lgaId: string; party: string; votes: bigint }>
    >`
      SELECT w."lgaId" AS "lgaId", kv.key AS party, sum(kv.value::numeric)::bigint AS votes
      FROM collation_results cr
      JOIN polling_units pu ON pu.id = cr."scopeId"
      JOIN wards w ON w.id = pu."wardId"
      CROSS JOIN LATERAL jsonb_each_text(cr."partyResults") AS kv(key, value)
      WHERE cr."campaignId" = ${campaignId}
        AND cr.level = 'POLLING_UNIT'
        AND cr.status IN ('SUBMITTED', 'APPROVED', 'REJECTED')
        AND cr."partyResults" IS NOT NULL
        AND w."lgaId" = ANY(${lgaIds})
        AND kv.value ~ '^[0-9]+$'
      GROUP BY w."lgaId", kv.key
    `;

    for (const row of parties) {
      const bucket = out.get(row.lgaId) ?? empty();
      const votes = Number(row.votes);
      bucket.partyTotals[row.party] =
        (bucket.partyTotals[row.party] ?? 0) + votes;
      bucket.totalVotes += votes;
      out.set(row.lgaId, bucket);
    }

    return out;
  }

  private async loadOpenIncidentsByLga(campaignId: string, lgaIds: string[]) {
    const out = new Map<
      string,
      Array<{ severity: string | null; urgent: boolean; createdAt: Date }>
    >();
    if (lgaIds.length === 0) return out;

    const reports = await this.prisma.fieldReport.findMany({
      where: {
        campaignId,
        type: {
          in: [FieldReportType.INCIDENT, FieldReportType.SECURITY_CONCERN],
        },
        status: { not: 'RESOLVED' },
        OR: [
          { ward: { lgaId: { in: lgaIds } } },
          { pollingUnit: { ward: { lgaId: { in: lgaIds } } } },
        ],
      },
      select: {
        incidentSeverity: true,
        isUrgent: true,
        createdAt: true,
        ward: { select: { lgaId: true } },
        pollingUnit: { select: { ward: { select: { lgaId: true } } } },
      },
    });

    for (const report of reports) {
      const lgaId = report.ward?.lgaId ?? report.pollingUnit?.ward?.lgaId;
      if (!lgaId) continue;
      const severity = report.incidentSeverity ?? null;
      const list = out.get(lgaId) ?? [];
      list.push({
        severity,
        urgent:
          report.isUrgent || severity === 'HIGH' || severity === 'CRITICAL',
        createdAt: report.createdAt,
      });
      out.set(lgaId, list);
    }
    return out;
  }

  /** Most recent submission/approval per LGA — the liveness signal for staleness. */
  private async loadLastSignalByLga(campaignId: string, lgaIds: string[]) {
    const out = new Map<string, Date>();
    if (lgaIds.length === 0) return out;

    const rows = await this.prisma.$queryRaw<
      Array<{ lgaId: string; lastAt: Date | null }>
    >`
      SELECT w."lgaId" AS "lgaId",
             max(coalesce(cr."approvedAt", cr."submittedAt")) AS "lastAt"
      FROM collation_results cr
      JOIN polling_units pu ON pu.id = cr."scopeId"
      JOIN wards w ON w.id = pu."wardId"
      WHERE cr."campaignId" = ${campaignId}
        AND cr.level = 'POLLING_UNIT'
        AND cr."submittedAt" IS NOT NULL
        AND w."lgaId" = ANY(${lgaIds})
      GROUP BY w."lgaId"
    `;

    for (const row of rows) {
      if (row.lastAt) out.set(row.lgaId, row.lastAt);
    }
    return out;
  }

  /**
   * Campaign-wide sentiment from the latest snapshot. Returns nulls when social
   * listening has produced nothing, so the component is skipped rather than
   * scoring a reassuring zero.
   */
  /**
   * Sentiment for a set of scopes, nearest reading first.
   *
   * A single campaign-wide number applied to all 774 LGAs would make the
   * factor useless: every place would carry the same mood no matter what was
   * being said about it. Each scope takes its own snapshot where one exists,
   * falls back to its state, then to the campaign, and reports nothing at all
   * when there is no reading anywhere -- which the engine renders as "not
   * measured" rather than as calm.
   */
  private async loadSentimentByScope(
    campaignId: string,
    targets: TriageTarget[],
  ): Promise<Map<string, { negativeShare: number | null; postCount: number }>> {
    const scopeIds = [...new Set(targets.map((t) => t.scopeId))];
    const stateIds = [
      ...new Set(
        targets.map((t) => t.stateId).filter((id): id is string => !!id),
      ),
    ];

    const snapshots = await this.prisma.sentimentSnapshot.findMany({
      where: {
        campaignId,
        OR: [
          { scopeId: { in: [...scopeIds, ...stateIds] } },
          { scopeType: ScopeType.CAMPAIGN, scopeId: campaignId },
        ],
      },
      orderBy: { windowEnd: 'desc' },
      select: {
        scopeId: true,
        scopeType: true,
        postCount: true,
        negativeCount: true,
        unknownCount: true,
      },
    });

    // Newest first, so the first row seen for a scope is the current one.
    const latest = new Map<string, (typeof snapshots)[number]>();
    for (const row of snapshots) {
      if (!latest.has(row.scopeId)) latest.set(row.scopeId, row);
    }

    const read = (scopeId?: string | null) => {
      if (!scopeId) return null;
      const row = latest.get(scopeId);
      if (!row) return null;
      const classified = row.postCount - row.unknownCount;
      if (classified <= 0) return null;
      return {
        negativeShare: row.negativeCount / classified,
        postCount: classified,
      };
    };

    const out = new Map<
      string,
      { negativeShare: number | null; postCount: number }
    >();

    // A scope gets its own reading or none. Inheriting the national figure was
    // the first thing tried and it was wrong: every state without upstream
    // coverage displayed the country's mood as though it were local, so Rivers
    // and Anambra reported "44.6% of social posts are negative" on the strength
    // of posts about Kaduna. Absent must stay absent -- the engine already
    // renormalises the remaining factors and says the mood was not measured.
    for (const target of targets) {
      out.set(
        target.scopeId,
        read(target.scopeId) ?? { negativeShare: null, postCount: 0 },
      );
    }
    return out;
  }

  /* ---------------------------------------------------------------------- *
   * Drill-down: wards inside an LGA, polling units inside a ward.
   *
   * These are scored on demand rather than swept. There are 8,809 wards and
   * 176,623 polling units nationally; a full ward sweep extrapolates to roughly
   * two minutes and a polling-unit sweep is not viable at all. Drilling touches
   * one parent's children, which is tens of rows.
   *
   * The queries mirror the LGA ones and differ only in what they group by and
   * which parent they filter on, so the grouping is parameterised rather than
   * copied. Both fragments come from the closed branch below, never from user
   * input -- interpolating a request value as SQL would be an injection hole.
   * ---------------------------------------------------------------------- */

  /**
   * Children of a scope, with their inputs, in one batch.
   *
   * @param parentId an LGA id when level is WARD, a ward id when POLLING_UNIT
   */
  async collectChildren(
    campaignId: string,
    level: CollationLevel.WARD | CollationLevel.POLLING_UNIT,
    parentId: string,
    electionMode: boolean,
  ): Promise<Array<{ target: TriageTarget; inputs: TriageInputs }>> {
    const context = await this.loadCampaignContext(campaignId);
    const targets = await this.listChildTargets(level, parentId);
    if (targets.length === 0) return [];

    const isWard = level === CollationLevel.WARD;
    const groupBy = isWard ? Prisma.sql`pu."wardId"` : Prisma.sql`cr."scopeId"`;
    const parentWhere = isWard
      ? Prisma.sql`w."lgaId" = ${parentId}`
      : Prisma.sql`pu."wardId" = ${parentId}`;

    const [totals, results, incidents, lastSignals, sentiment] =
      await Promise.all([
        this.countUnitsByChild(level, parentId),
        this.loadResultsByChild(campaignId, groupBy, parentWhere),
        this.loadOpenIncidentsByChild(campaignId, level, parentId),
        this.loadLastSignalByChild(campaignId, groupBy, parentWhere),
        this.loadSentimentByScope(campaignId, targets),
      ]);

    const now = Date.now();

    return targets.map((target) => {
      const bucket = results.get(target.scopeId);
      const partyTotals = bucket?.partyTotals ?? {};
      const clientVotes = context.clientPartyCode
        ? (partyTotals[context.clientPartyCode] ?? 0)
        : 0;
      const rivalVotes = Math.max(
        0,
        ...Object.entries(partyTotals)
          .filter(([code]) => code !== context.clientPartyCode)
          .map(([, votes]) => votes),
      );
      const lastSignal = lastSignals.get(target.scopeId) ?? null;
      const childSentiment = sentiment.get(target.scopeId) ?? {
        negativeShare: null,
        postCount: 0,
      };

      const inputs: TriageInputs = {
        level,
        pollingUnitsTotal: totals.get(target.scopeId) ?? 0,
        pollingUnitsReported: bucket?.reported ?? 0,
        clientVotes,
        rivalVotes,
        totalVotes: bucket?.totalVotes ?? 0,
        clientPartyCode: context.clientPartyCode,
        registeredVoters: bucket?.registeredVoters ?? 0,
        accreditedVoters: bucket?.accreditedVoters ?? 0,
        incidents: (incidents.get(target.scopeId) ?? []).map((incident) => ({
          severity: incident.severity,
          urgent: incident.urgent,
          ageHours: (now - incident.createdAt.getTime()) / 3_600_000,
        })),
        resultsScored: bucket?.scored ?? 0,
        resultsFlagged: bucket?.flagged ?? 0,
        resultsCheckPhoto: bucket?.checkPhoto ?? 0,
        minutesSinceLastSignal: lastSignal
          ? (now - lastSignal.getTime()) / 60_000
          : null,
        negativeSentimentShare: childSentiment.negativeShare,
        sentimentPostCount: childSentiment.postCount,
        electionMode,
      };
      return { target, inputs };
    });
  }

  /** The child scopes themselves, named and ordered for a drill list. */
  private async listChildTargets(
    level: CollationLevel.WARD | CollationLevel.POLLING_UNIT,
    parentId: string,
  ): Promise<TriageTarget[]> {
    if (level === CollationLevel.WARD) {
      const wards = await this.prisma.ward.findMany({
        where: { lgaId: parentId },
        select: { id: true, name: true, lga: { select: { stateId: true } } },
        orderBy: { name: 'asc' },
      });
      return wards.map((ward) => ({
        level: CollationLevel.WARD,
        scopeType: ScopeType.WARD,
        scopeId: ward.id,
        name: ward.name,
        stateId: ward.lga?.stateId ?? null,
        lgaIds: [parentId],
      }));
    }

    const units = await this.prisma.pollingUnit.findMany({
      where: { wardId: parentId },
      select: {
        id: true,
        name: true,
        code: true,
        ward: { select: { lgaId: true, lga: { select: { stateId: true } } } },
      },
      orderBy: { code: 'asc' },
    });
    return units.map((unit) => ({
      level: CollationLevel.POLLING_UNIT,
      scopeType: ScopeType.POLLING_UNIT,
      scopeId: unit.id,
      name: unit.code ? `${unit.code} - ${unit.name}` : unit.name,
      stateId: unit.ward?.lga?.stateId ?? null,
      lgaIds: unit.ward?.lgaId ? [unit.ward.lgaId] : [],
    }));
  }

  /** Registered polling units per child. A polling unit is one of itself. */
  private async countUnitsByChild(
    level: CollationLevel.WARD | CollationLevel.POLLING_UNIT,
    parentId: string,
  ): Promise<Map<string, number>> {
    if (level === CollationLevel.POLLING_UNIT) {
      const units = await this.prisma.pollingUnit.findMany({
        where: { wardId: parentId },
        select: { id: true },
      });
      return new Map(units.map((unit) => [unit.id, 1]));
    }
    const rows = await this.prisma.$queryRaw<
      Array<{ wardId: string; total: bigint }>
    >`
      SELECT pu."wardId" AS "wardId", count(pu.id)::bigint AS total
      FROM polling_units pu
      JOIN wards w ON w.id = pu."wardId"
      WHERE w."lgaId" = ${parentId}
      GROUP BY pu."wardId"
    `;
    return new Map(rows.map((row) => [row.wardId, Number(row.total)]));
  }

  private async loadResultsByChild(
    campaignId: string,
    groupBy: Prisma.Sql,
    parentWhere: Prisma.Sql,
  ) {
    const out = new Map<
      string,
      {
        reported: number;
        totalVotes: number;
        registeredVoters: number;
        accreditedVoters: number;
        scored: number;
        flagged: number;
        checkPhoto: number;
        partyTotals: Record<string, number>;
      }
    >();

    const empty = () => ({
      reported: 0,
      totalVotes: 0,
      registeredVoters: 0,
      accreditedVoters: 0,
      scored: 0,
      flagged: 0,
      checkPhoto: 0,
      partyTotals: {} as Record<string, number>,
    });

    const totals = await this.prisma.$queryRaw<
      Array<{
        childId: string;
        reported: bigint;
        registered: bigint;
        accredited: bigint;
        scored: bigint;
        flagged: bigint;
        checkPhoto: bigint;
      }>
    >`
      SELECT ${groupBy} AS "childId",
             count(*)::bigint AS reported,
             coalesce(sum(cr."registeredVoters"), 0)::bigint AS registered,
             coalesce(sum(cr."accreditedVoters"), 0)::bigint AS accredited,
             count(cr."ocrVerification")::bigint AS scored,
             coalesce(sum(CASE WHEN cr."ocrVerification"->>'recommendation' = 'RETURN'
                               THEN 1 ELSE 0 END), 0)::bigint AS "flagged",
             coalesce(sum(CASE WHEN cr."ocrVerification"->>'recommendation' = 'CHECK_PHOTO'
                               THEN 1 ELSE 0 END), 0)::bigint AS "checkPhoto"
      FROM collation_results cr
      JOIN polling_units pu ON pu.id = cr."scopeId"
      JOIN wards w ON w.id = pu."wardId"
      WHERE cr."campaignId" = ${campaignId}
        AND cr.level = 'POLLING_UNIT'
        AND cr.status IN ('SUBMITTED', 'APPROVED', 'REJECTED')
        AND ${parentWhere}
      GROUP BY ${groupBy}
    `;

    for (const row of totals) {
      const bucket = empty();
      bucket.reported = Number(row.reported);
      bucket.registeredVoters = Number(row.registered);
      bucket.accreditedVoters = Number(row.accredited);
      bucket.scored = Number(row.scored);
      bucket.flagged = Number(row.flagged);
      bucket.checkPhoto = Number(row.checkPhoto);
      out.set(row.childId, bucket);
    }

    const parties = await this.prisma.$queryRaw<
      Array<{ childId: string; party: string; votes: bigint }>
    >`
      SELECT ${groupBy} AS "childId", kv.key AS party,
             sum(kv.value::numeric)::bigint AS votes
      FROM collation_results cr
      JOIN polling_units pu ON pu.id = cr."scopeId"
      JOIN wards w ON w.id = pu."wardId"
      CROSS JOIN LATERAL jsonb_each_text(cr."partyResults") AS kv(key, value)
      WHERE cr."campaignId" = ${campaignId}
        AND cr.level = 'POLLING_UNIT'
        AND cr.status IN ('SUBMITTED', 'APPROVED', 'REJECTED')
        AND cr."partyResults" IS NOT NULL
        AND ${parentWhere}
        AND kv.value ~ '^[0-9]+$'
      GROUP BY ${groupBy}, kv.key
    `;

    for (const row of parties) {
      const bucket = out.get(row.childId) ?? empty();
      const votes = Number(row.votes);
      bucket.partyTotals[row.party] =
        (bucket.partyTotals[row.party] ?? 0) + votes;
      bucket.totalVotes += votes;
      out.set(row.childId, bucket);
    }

    return out;
  }

  private async loadOpenIncidentsByChild(
    campaignId: string,
    level: CollationLevel.WARD | CollationLevel.POLLING_UNIT,
    parentId: string,
  ) {
    const out = new Map<
      string,
      Array<{ severity: string | null; urgent: boolean; createdAt: Date }>
    >();

    const isWard = level === CollationLevel.WARD;
    const reports = await this.prisma.fieldReport.findMany({
      where: {
        campaignId,
        type: {
          in: [FieldReportType.INCIDENT, FieldReportType.SECURITY_CONCERN],
        },
        status: { not: 'RESOLVED' },
        ...(isWard
          ? {
              OR: [
                { ward: { lgaId: parentId } },
                { pollingUnit: { ward: { lgaId: parentId } } },
              ],
            }
          : { pollingUnit: { wardId: parentId } }),
      },
      select: {
        incidentSeverity: true,
        isUrgent: true,
        createdAt: true,
        wardId: true,
        pollingUnitId: true,
        pollingUnit: { select: { wardId: true } },
      },
    });

    for (const report of reports) {
      // A ward-level report carries no polling unit, so it lands on the ward and
      // is simply absent when drilling into polling units -- correct, because it
      // was never attributed to one.
      const key = isWard
        ? (report.wardId ?? report.pollingUnit?.wardId)
        : report.pollingUnitId;
      if (!key) continue;
      const severity = report.incidentSeverity ?? null;
      const list = out.get(key) ?? [];
      list.push({
        severity,
        urgent:
          report.isUrgent || severity === 'HIGH' || severity === 'CRITICAL',
        createdAt: report.createdAt,
      });
      out.set(key, list);
    }
    return out;
  }

  private async loadLastSignalByChild(
    campaignId: string,
    groupBy: Prisma.Sql,
    parentWhere: Prisma.Sql,
  ) {
    const out = new Map<string, Date>();
    const rows = await this.prisma.$queryRaw<
      Array<{ childId: string; lastAt: Date | null }>
    >`
      SELECT ${groupBy} AS "childId",
             max(coalesce(cr."approvedAt", cr."submittedAt")) AS "lastAt"
      FROM collation_results cr
      JOIN polling_units pu ON pu.id = cr."scopeId"
      JOIN wards w ON w.id = pu."wardId"
      WHERE cr."campaignId" = ${campaignId}
        AND cr."submittedAt" IS NOT NULL
        AND cr.level = 'POLLING_UNIT'
        AND ${parentWhere}
      GROUP BY ${groupBy}
    `;
    for (const row of rows) {
      if (row.lastAt) out.set(row.childId, row.lastAt);
    }
    return out;
  }
}

/** Re-exported so the module can reference the sentiment enum without a second import. */
export { SocialSentiment };
