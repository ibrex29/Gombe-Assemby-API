import { IncidentSeverity, IncidentType } from '@electromon/shared';

export const INCIDENT_TYPE_TITLES: Record<IncidentType, string> = {
  [IncidentType.VOTER_INTIMIDATION]: 'Voter intimidation',
  [IncidentType.BALLOT_SNATCHING]: 'Ballot snatching',
  [IncidentType.BALLOT_STUFFING]: 'Ballot stuffing',
  [IncidentType.VOTE_BUYING]: 'Vote buying',
  [IncidentType.VIOLENCE_THUGGERY]: 'Violence / thuggery',
  [IncidentType.MATERIALS_SHORTAGE]: 'Materials shortage',
  [IncidentType.LATE_OR_FAILED_OPENING]: 'Late or failed opening',
  [IncidentType.BVAS_MALFUNCTION]: 'BVAS malfunction',
  [IncidentType.UNAUTHORIZED_PERSONNEL]: 'Unauthorized personnel',
  [IncidentType.OVERVOTING]: 'Overvoting',
  [IncidentType.OPPOSITION_DISRUPTION]: 'Opposition disruption',
  [IncidentType.OTHERS]: 'Others',
};

const INCIDENT_TYPES = new Set<string>(Object.values(IncidentType));
const INCIDENT_SEVERITIES = new Set<string>(Object.values(IncidentSeverity));

export type VoiceIncidentParseResult =
  | {
      ok: true;
      language: string | null;
      originalTranscript: string;
      englishSummary: string;
      incidentType: IncidentType;
      incidentSeverity: IncidentSeverity;
    }
  | {
      ok: false;
      error: string;
      originalTranscript?: string;
      language?: string | null;
    };

export function parseVoiceIncidentJson(raw: string): VoiceIncidentParseResult {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonText = fence ? fence[1].trim() : trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: 'AI returned invalid JSON for the voice report' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'AI returned an unexpected voice report payload' };
  }

  const body = parsed as Record<string, unknown>;
  const englishSummary = coerceString(body.englishSummary);
  const originalTranscript = coerceString(body.originalTranscript);
  const language = coerceString(body.language) || null;

  if (!englishSummary && !originalTranscript) {
    return { ok: false, error: 'AI returned an empty transcript', language };
  }

  const incidentType = clampIncidentType(body.incidentType);
  const incidentSeverity = clampIncidentSeverity(body.incidentSeverity);

  return {
    ok: true,
    language,
    originalTranscript: originalTranscript || englishSummary,
    englishSummary: englishSummary || originalTranscript,
    incidentType,
    incidentSeverity,
  };
}

function coerceString(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function clampIncidentType(value: unknown): IncidentType {
  const raw = coerceString(value).toUpperCase();
  if (INCIDENT_TYPES.has(raw)) {
    return raw as IncidentType;
  }
  return IncidentType.OTHERS;
}

function clampIncidentSeverity(value: unknown): IncidentSeverity {
  const raw = coerceString(value).toUpperCase();
  if (INCIDENT_SEVERITIES.has(raw)) {
    return raw as IncidentSeverity;
  }
  return IncidentSeverity.MEDIUM;
}
