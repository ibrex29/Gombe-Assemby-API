import {
  CampaignRole,
  ElectionDayPhase,
  IncidentType,
  PULSE_SILENT_MINUTES,
  PulseAtmosphere,
  PulseBvasStatus,
  RivalMobilization,
  RivalTactic,
  SituationStatus,
  WhoLooksAhead,
} from './enums';

export { PULSE_SILENT_MINUTES };

const PHASES_AFTER_OPEN = new Set<ElectionDayPhase>([
  ElectionDayPhase.OPENED,
  ElectionDayPhase.VOTING,
  ElectionDayPhase.CLOSED,
  ElectionDayPhase.COUNTING,
]);

export function mapStatusToPhase(status: SituationStatus): ElectionDayPhase {
  switch (status) {
    case SituationStatus.REPORTING:
      return ElectionDayPhase.COUNTING;
    case SituationStatus.CLOSED:
      return ElectionDayPhase.CLOSED;
    case SituationStatus.OPEN:
    case SituationStatus.INCIDENT:
    default:
      return ElectionDayPhase.VOTING;
  }
}

export function mapPhaseToStatus(phase: ElectionDayPhase): SituationStatus {
  switch (phase) {
    case ElectionDayPhase.COUNTING:
      return SituationStatus.REPORTING;
    case ElectionDayPhase.CLOSED:
      return SituationStatus.CLOSED;
    default:
      return SituationStatus.OPEN;
  }
}

export function hasOpened(phase: string | null | undefined): boolean {
  return phase != null && PHASES_AFTER_OPEN.has(phase as ElectionDayPhase);
}

export function isPulseSilent(input: {
  phase: string | null | undefined;
  lastPulseAt: Date | string | null | undefined;
  now?: Date;
}): boolean {
  if (!input.lastPulseAt || !input.phase) return true;
  if (input.phase === ElectionDayPhase.CLOSED || input.phase === 'CLOSED') return false;
  const at = input.lastPulseAt instanceof Date ? input.lastPulseAt : new Date(input.lastPulseAt);
  const now = input.now ?? new Date();
  return now.getTime() - at.getTime() > PULSE_SILENT_MINUTES * 60 * 1000;
}

export type PulseSnapshotLike = {
  phase: string;
  atmosphere?: string | null;
  bvasStatus?: string | null;
  rivalMobilization?: string | null;
  observedPartyResults?: Record<string, number> | null;
};

export function observedLead(
  observed: Record<string, number> | null | undefined,
  clientPartyCode: string | null | undefined,
): WhoLooksAhead {
  if (!observed || !clientPartyCode) return WhoLooksAhead.UNCLEAR;
  const client = observed[clientPartyCode] ?? 0;
  let rival = 0;
  for (const [code, votes] of Object.entries(observed)) {
    if (code === clientPartyCode) continue;
    if (votes > rival) rival = votes;
  }
  if (client === rival) return WhoLooksAhead.UNCLEAR;
  return client > rival ? WhoLooksAhead.US : WhoLooksAhead.RIVAL;
}

export function isMaterialPulseChange(
  previous: PulseSnapshotLike | null | undefined,
  next: PulseSnapshotLike,
  clientPartyCode?: string | null,
): boolean {
  if (!previous) return true;
  if (previous.phase !== next.phase) return true;
  if (next.bvasStatus === PulseBvasStatus.DOWN && previous.bvasStatus !== PulseBvasStatus.DOWN) {
    return true;
  }
  if (next.atmosphere === PulseAtmosphere.DISRUPTED && previous.atmosphere !== PulseAtmosphere.DISRUPTED) {
    return true;
  }
  if (
    next.rivalMobilization === RivalMobilization.HEAVY &&
    previous.rivalMobilization !== RivalMobilization.HEAVY
  ) {
    return true;
  }
  const prevLead = observedLead(previous.observedPartyResults, clientPartyCode);
  const nextLead = observedLead(next.observedPartyResults, clientPartyCode);
  return prevLead !== nextLead && next.observedPartyResults != null;
}

export type PulseReminderAudience = 'agent' | 'ward' | 'lga';

export const PULSE_REMINDER_TIMEZONE = 'Africa/Lagos';

export function minutesInTimeZone(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

export function calendarDateInTimeZone(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** One reminder bucket per clock hour, e.g. `hour-14`. */
export function pulseReminderHourId(now: Date, timeZone = PULSE_REMINDER_TIMEZONE): string {
  const hour = Math.floor(minutesInTimeZone(now, timeZone) / 60);
  return `hour-${String(hour).padStart(2, '0')}`;
}

export function pulseReminderAudienceFromRole(
  role?: CampaignRole | null,
): PulseReminderAudience | null {
  switch (role) {
    case CampaignRole.POLLING_AGENT:
    case CampaignRole.POLLING_UNIT_OFFICER:
      return 'agent';
    case CampaignRole.WARD_RA_OFFICER:
    case CampaignRole.WARD_COORDINATOR:
      return 'ward';
    case CampaignRole.LGA_COLLATION_OFFICER:
    case CampaignRole.LGA_COORDINATOR:
      return 'lga';
    default:
      return null;
  }
}

export function pulseReminderSourceEventId(input: {
  campaignId: string;
  dateKey: string;
  slotId: string;
  audience: PulseReminderAudience;
  scopeId?: string;
}): string {
  const scope = input.scopeId ? `:${input.scopeId}` : '';
  return `pulse-reminder:${input.campaignId}:${input.dateKey}:${input.slotId}:${input.audience}${scope}`;
}

export function parseObservedPartyResults(
  input: unknown,
  allowedCodes: string[],
): Record<string, number> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const allowed = new Set(allowedCodes.map((code) => code.toUpperCase()));
  const result: Record<string, number> = {};
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const code = rawKey.toUpperCase();
    if (!allowed.has(code)) continue;
    if (typeof rawValue !== 'number' || !Number.isFinite(rawValue) || rawValue < 0) {
      throw new Error(`Invalid observed total for ${code}`);
    }
    result[code] = Math.round(rawValue);
  }
  return Object.keys(result).length ? result : null;
}

const PHASE_RANK: Record<ElectionDayPhase, number> = {
  [ElectionDayPhase.CHECKED_IN]: 1,
  [ElectionDayPhase.MATERIALS_READY]: 2,
  [ElectionDayPhase.OPENED]: 3,
  [ElectionDayPhase.VOTING]: 4,
  [ElectionDayPhase.CLOSED]: 5,
  [ElectionDayPhase.COUNTING]: 6,
};

export function laterElectionDayPhase(
  current: ElectionDayPhase | string | null | undefined,
  next: ElectionDayPhase,
): ElectionDayPhase {
  if (!current) return next;
  const currentRank = PHASE_RANK[current as ElectionDayPhase];
  if (currentRank == null) return next;
  return PHASE_RANK[next] >= currentRank ? next : (current as ElectionDayPhase);
}

export type IncidentPulsePatch = {
  atmosphere?: PulseAtmosphere;
  bvasStatus?: PulseBvasStatus;
  materialsComplete?: boolean;
  rivalMobilization?: RivalMobilization;
  rivalTactics?: RivalTactic[];
  isUrgent?: boolean;
  heartbeatOnly?: boolean;
};

export function pulsePatchFromIncident(
  type: IncidentType | string | null | undefined,
): IncidentPulsePatch {
  switch (type) {
    case IncidentType.BVAS_MALFUNCTION:
      return { bvasStatus: PulseBvasStatus.DOWN, isUrgent: true };
    case IncidentType.MATERIALS_SHORTAGE:
    case IncidentType.LATE_OR_FAILED_OPENING:
      return { materialsComplete: false };
    case IncidentType.VOTER_INTIMIDATION:
      return {
        atmosphere: PulseAtmosphere.DISRUPTED,
        rivalTactics: [RivalTactic.INTIMIDATION],
        isUrgent: true,
      };
    case IncidentType.VIOLENCE_THUGGERY:
      return {
        atmosphere: PulseAtmosphere.DISRUPTED,
        rivalTactics: [RivalTactic.DISRUPTION],
        isUrgent: true,
      };
    case IncidentType.VOTE_BUYING:
      return { rivalTactics: [RivalTactic.INDUCEMENT] };
    case IncidentType.UNAUTHORIZED_PERSONNEL:
      return { rivalTactics: [RivalTactic.UNAUTHORIZED_PERSONNEL] };
    case IncidentType.OPPOSITION_DISRUPTION:
      return {
        atmosphere: PulseAtmosphere.DISRUPTED,
        rivalMobilization: RivalMobilization.HEAVY,
        rivalTactics: [RivalTactic.DISRUPTION],
        isUrgent: true,
      };
    default:
      return { heartbeatOnly: true };
  }
}

export function mergeRivalTactics(
  previous: RivalTactic[] | string[] | null | undefined,
  extra: RivalTactic[] | null | undefined,
): RivalTactic[] {
  const merged = new Set<RivalTactic>();
  for (const tactic of previous ?? []) {
    if (Object.values(RivalTactic).includes(tactic as RivalTactic)) {
      merged.add(tactic as RivalTactic);
    }
  }
  for (const tactic of extra ?? []) merged.add(tactic);
  return [...merged];
}
