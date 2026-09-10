/**
 * Something happened that could move a risk score.
 *
 * Producers emit this rather than calling the triage service, so CollationModule
 * and FieldReportsModule never have to import TriageModule — the same decoupling
 * the notification dispatch event already uses.
 */
export const TRIAGE_DIRTY_EVENT = 'triage.dirty';

export type TriageDirtyPayload = {
  campaignId: string;
  stateId?: string | null;
  lgaId?: string | null;
  wardId?: string | null;
  pollingUnitId?: string | null;
  /**
   * A CRITICAL or urgent source. Earns an immediate ward rescore instead of
   * waiting for the next drain, subject to a cooldown.
   */
  urgent?: boolean;
};
