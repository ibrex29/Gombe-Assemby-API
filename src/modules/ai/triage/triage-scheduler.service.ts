import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CampaignRole,
  CollationLevel,
  TriageRiskLevel,
} from '@electromon/shared';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { TriageService } from './triage.service';
import { TriageTriggerService } from './triage-trigger.service';

/** Sweep cadence when nothing is configured. Election day wants far tighter. */
const DEFAULT_INTERVAL_SECONDS = 900;
/** A sweep must never be considered stuck for longer than this. */
const LOCK_TTL_SECONDS = 600;

/**
 * How many of the worst LGAs get their wards scored each sweep.
 *
 * A full ward sweep is 8,809 scopes and extrapolates to roughly two minutes;
 * the wards that matter are the ones under an LGA already in trouble. Capped so
 * a bad night cannot turn the sweep into a long-running job.
 */
const HOT_LGA_WARD_SWEEP_LIMIT = 20;

/** How often pending dirty scopes are drained. Far tighter than the full sweep. */
const DEFAULT_DRAIN_SECONDS = 45;
const MIN_DRAIN_SECONDS = 15;

/** Polling-unit snapshots older than this are pruned once a day. */
const DEFAULT_PU_RETENTION_DAYS = 14;

/**
 * Runs the risk sweep on a timer.
 *
 * A plain interval rather than @nestjs/schedule: the repo already drives its
 * metrics refresh this way and there is exactly one job here, so a scheduling
 * dependency would earn nothing.
 *
 * Two guards, because a sweep that overlaps itself would double the database
 * load precisely when the system is busiest:
 *  - an in-process flag, so a slow sweep is never re-entered;
 *  - a Redis lock, so two API instances do not both sweep. With no Redis the
 *    lock is skipped and the sweep still runs, which is right for a single
 *    instance and is logged so it is not a silent assumption.
 */
@Injectable()
export class TriageSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TriageSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
  private running = false;
  private draining = false;
  /** UTC day the retention prune last ran, so it happens once per day. */
  private lastRetentionDay: string | null = null;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private redis: RedisService,
    private triage: TriageService,
    private trigger: TriageTriggerService,
  ) {}

  onModuleInit() {
    if (!this.isEnabled()) {
      this.logger.log(
        'Risk sweep disabled (set TRIAGE_SWEEP_ENABLED=true to run it)',
      );
      return;
    }

    const seconds = this.intervalSeconds();
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    // Do not hold shutdown open waiting for the next tick.
    this.timer.unref?.();

    const drainSeconds = this.drainSeconds();
    this.drainTimer = setInterval(() => void this.drainTick(), drainSeconds * 1000);
    this.drainTimer.unref?.();

    this.logger.log(
      `Risk sweep every ${seconds}s, dirty drain every ${drainSeconds}s (election mode: ${this.electionMode()})`,
    );
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.timer = null;
    this.drainTimer = null;
  }

  private isEnabled(): boolean {
    return (
      (this.config.get<string>('TRIAGE_SWEEP_ENABLED') ?? '').toLowerCase() ===
      'true'
    );
  }

  private electionMode(): boolean {
    // Defaults on: the time-sensitive components are the point of a live sweep.
    return (
      (
        this.config.get<string>('TRIAGE_ELECTION_MODE') ?? 'true'
      ).toLowerCase() !== 'false'
    );
  }

  private drainSeconds(): number {
    const raw = Number(this.config.get<string>('TRIAGE_DIRTY_DRAIN_SEC'));
    if (!Number.isFinite(raw) || raw < MIN_DRAIN_SECONDS) {
      return DEFAULT_DRAIN_SECONDS;
    }
    return Math.floor(raw);
  }

  private retentionDays(): number {
    const raw = Number(
      this.config.get<string>('TRIAGE_PU_SNAPSHOT_RETENTION_DAYS'),
    );
    if (!Number.isFinite(raw) || raw < 0) return DEFAULT_PU_RETENTION_DAYS;
    return Math.floor(raw);
  }

  private intervalSeconds(): number {
    const raw = Number(this.config.get<string>('TRIAGE_SWEEP_INTERVAL_SEC'));
    if (!Number.isFinite(raw) || raw < 60) return DEFAULT_INTERVAL_SECONDS;
    return Math.floor(raw);
  }

  /** Exposed so a sweep can be triggered directly in tests. */
  async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn('Previous risk sweep still running; skipping this tick');
      return;
    }

    if (this.redis.isConnected()) {
      const acquired = await this.redis.acquireLock(
        'triage:sweep',
        LOCK_TTL_SECONDS,
      );
      if (!acquired) {
        this.logger.debug(
          'Another instance holds the risk sweep lock; skipping',
        );
        return;
      }
    }

    this.running = true;
    const startedAt = Date.now();
    try {
      const campaigns = await this.prisma.campaign.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
      });

      for (const campaign of campaigns) {
        // States first: the board most people are watching updates soonest.
        for (const level of [
          CollationLevel.STATE,
          CollationLevel.LGA,
        ] as const) {
          const result = await this.triage.rescore(
            campaign.id,
            level,
            this.electionMode(),
            await this.sweepActor(campaign.id),
          );
          for (const transition of result.transitions) {
            this.logger.warn(
              `Risk ${transition.from} -> ${transition.to}: ${transition.name} (${campaign.name})`,
            );
          }
        }

        // Deliberately isolated: the state and LGA boards are already saved by
        // this point, and a ward-pass failure must not report the whole sweep
        // as failed or skip the campaigns still queued behind it.
        try {
          await this.sweepHotWards(campaign.id);
        } catch (error) {
          this.logger.error(
            { err: error instanceof Error ? error.message : String(error) },
            `Ward sweep failed for ${campaign.name}`,
          );
        }
      }

      await this.pruneSnapshots();
      this.logger.log(`Risk sweep finished in ${Date.now() - startedAt}ms`);
    } catch (error) {
      // A failed sweep must not kill the timer; the next tick retries.
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Risk sweep failed',
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Scores the wards beneath the LGAs currently at HIGH or CRITICAL.
   *
   * This is the compromise that makes ward-level risk affordable: the whole
   * country is not swept, but anywhere already in trouble is resolved one level
   * deeper without an operator having to ask. Everywhere else stays on demand.
   */
  private async sweepHotWards(campaignId: string): Promise<void> {
    const hot = await this.prisma.triageScore.findMany({
      where: {
        campaignId,
        level: CollationLevel.LGA,
        riskLevel: { in: [TriageRiskLevel.HIGH, TriageRiskLevel.CRITICAL] },
      },
      orderBy: { compositeScore: 'desc' },
      take: HOT_LGA_WARD_SWEEP_LIMIT,
      select: { scopeId: true },
    });
    if (hot.length === 0) return;

    let wards = 0;
    for (const lga of hot) {
      const result = await this.triage.rescoreChildren(
        campaignId,
        CollationLevel.WARD,
        lga.scopeId,
        this.electionMode(),
      );
      wards += result.scored;
    }
    this.logger.log(
      `Ward sweep: ${wards} wards under ${hot.length} at-risk LGAs`,
    );
  }

  /**
   * Rescore whatever the triggers marked, grouped per campaign and level.
   *
   * Not Redis-locked: rescoring is idempotent and duplicated work across
   * instances is cheaper than coordinating it. The in-process flag is enough to
   * stop a slow drain from overlapping itself.
   */
  async drainTick(): Promise<void> {
    if (this.draining) return;
    const batches = this.trigger.takeDirty();
    if (batches.length === 0) return;

    this.draining = true;
    const startedAt = Date.now();
    try {
      for (const batch of batches) {
        if (
          batch.level !== CollationLevel.STATE &&
          batch.level !== CollationLevel.LGA
        ) {
          continue;
        }
        const actor = await this.sweepActor(batch.campaignId);
        const result = await this.triage.rescoreScopes(
          batch.campaignId,
          batch.level,
          batch.scopeIds,
          this.electionMode(),
          actor,
        );
        if (result.changed > 0) {
          this.logger.log(
            `Drain ${batch.level}: ${result.changed} of ${result.scored} changed`,
          );
        }
      }
      this.logger.debug(`Dirty drain finished in ${Date.now() - startedAt}ms`);
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Dirty drain failed',
      );
    } finally {
      this.draining = false;
    }
  }

  /**
   * Who a scheduled sweep acts as.
   *
   * Nothing in the system is "the system", and notifications need an actor to
   * exclude from their own recipients. The campaign director is the closest
   * honest answer; it shows in audit trails, which is why it is a deliberate
   * choice rather than an arbitrary user.
   */
  private async sweepActor(campaignId: string): Promise<string | undefined> {
    const membership = await this.prisma.campaignMembership.findFirst({
      where: {
        campaignId,
        isActive: true,
        role: CampaignRole.CAMPAIGN_DIRECTOR,
      },
      select: { userId: true },
    });
    return membership?.userId;
  }

  /**
   * Prune polling-unit snapshot history once a day.
   *
   * Ward and above are the sparkline history and are never deleted. Polling
   * units only snapshot on a transition, but at 176,623 units even that
   * accumulates; this keeps the table a log rather than a landfill.
   */
  private async pruneSnapshots(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    if (this.lastRetentionDay === today) return;

    const days = this.retentionDays();
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const deleted = await this.prisma.triageSnapshot.deleteMany({
      where: {
        level: CollationLevel.POLLING_UNIT,
        computedAt: { lt: cutoff },
      },
    });
    this.lastRetentionDay = today;
    if (deleted.count > 0) {
      this.logger.log(
        `Pruned ${deleted.count} polling-unit snapshots older than ${days}d`,
      );
    }
  }
}
