import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CollationLevel } from '@electromon/shared';
import { RedisService } from '../../../common/redis/redis.service';
import { TRIAGE_DIRTY_EVENT, type TriageDirtyPayload } from './triage.events';
import { TriageService } from './triage.service';

/**
 * Marks scopes as needing a rescore when reality moves.
 *
 * Before this, the board only changed on the sweep timer: a CRITICAL incident
 * at 20:01 was invisible until the sweep at 20:15. Producers now emit a dirty
 * event and this service records which scopes are stale; the scheduler drains
 * them on a short cadence, and genuinely urgent ward-level changes skip the
 * queue entirely.
 *
 * The registry is in-process on purpose. Rescoring is idempotent, the full
 * sweep is already Redis-locked, and duplicated micro-work across instances is
 * cheaper than the coordination needed to avoid it — the same argument the
 * queue fallback documents.
 */

/** Seconds an LGA is left alone after an urgent ward pass. */
const URGENT_COOLDOWN_SECONDS = 60;

@Injectable()
export class TriageTriggerService {
  private readonly logger = new Logger(TriageTriggerService.name);

  /** campaignId -> set of "LEVEL:scopeId" */
  private readonly dirty = new Map<string, Set<string>>();

  /** Fallback cooldown clock for when Redis is absent. */
  private readonly localCooldown = new Map<string, number>();

  constructor(
    private redis: RedisService,
    private triage: TriageService,
  ) {}

  @OnEvent(TRIAGE_DIRTY_EVENT, { async: true })
  async handle(payload: TriageDirtyPayload): Promise<void> {
    try {
      const { campaignId } = payload;
      if (!campaignId) return;

      const set = this.dirty.get(campaignId) ?? new Set<string>();
      if (payload.stateId) set.add(`${CollationLevel.STATE}:${payload.stateId}`);
      if (payload.lgaId) set.add(`${CollationLevel.LGA}:${payload.lgaId}`);
      this.dirty.set(campaignId, set);

      if (payload.urgent && payload.lgaId) {
        await this.urgentWardPass(campaignId, payload.lgaId);
      }
    } catch (error) {
      // A trigger must never take down the request that produced it.
      this.logger.warn(
        `Triage trigger failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Immediate ward rescore under an LGA, at most once a minute per LGA.
   *
   * The cooldown matters on election night: a burst of incidents in one LGA
   * would otherwise rescore its wards once per report.
   */
  private async urgentWardPass(campaignId: string, lgaId: string) {
    const key = `triage:cooldown:ward:${lgaId}`;

    if (this.redis.isConnected()) {
      const acquired = await this.redis.acquireLock(key, URGENT_COOLDOWN_SECONDS);
      if (!acquired) return;
    } else {
      const now = Date.now();
      const until = this.localCooldown.get(key) ?? 0;
      if (now < until) return;
      this.localCooldown.set(key, now + URGENT_COOLDOWN_SECONDS * 1000);
    }

    const result = await this.triage.rescoreChildren(
      campaignId,
      CollationLevel.WARD,
      lgaId,
      true,
    );
    this.logger.log(
      `Urgent ward pass for LGA ${lgaId}: ${result.scored} wards, ${result.changed} changed`,
    );
  }

  /**
   * Hands the pending work to the caller and clears it.
   *
   * Taking rather than reading means a drain that fails loses that round's
   * marks — acceptable, because the full sweep is the backstop and the next
   * event re-marks anything still moving.
   */
  takeDirty(): Array<{
    campaignId: string;
    level: CollationLevel;
    scopeIds: string[];
  }> {
    const batches: Array<{
      campaignId: string;
      level: CollationLevel;
      scopeIds: string[];
    }> = [];

    for (const [campaignId, keys] of this.dirty) {
      const byLevel = new Map<CollationLevel, string[]>();
      for (const key of keys) {
        const [level, scopeId] = key.split(':') as [CollationLevel, string];
        const list = byLevel.get(level) ?? [];
        list.push(scopeId);
        byLevel.set(level, list);
      }
      for (const [level, scopeIds] of byLevel) {
        batches.push({ campaignId, level, scopeIds });
      }
    }

    this.dirty.clear();
    return batches;
  }

  /** Exposed for tests and diagnostics. */
  pendingCount(): number {
    let total = 0;
    for (const set of this.dirty.values()) total += set.size;
    return total;
  }
}
