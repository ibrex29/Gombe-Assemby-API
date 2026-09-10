import { FIELD_PATTERNS } from './ocr-ec8a-parse';

/**
 * Mirrors Ec8aPhotoReaderService JSON normalization for unit tests without
 * calling OpenRouter.
 */
export function parseAiEc8aJson(
  raw: string,
  partyCodes: string[],
): {
  fields: Record<string, number | null>;
  partyResults: Record<string, number>;
  confidence: number | null;
  unreadable: boolean;
  error?: string;
} {
  const FIELD_KEYS = FIELD_PATTERNS.map((f) => f.field);
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonText = fence ? fence[1].trim() : trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return {
      fields: {},
      partyResults: {},
      confidence: null,
      unreadable: true,
      error: 'AI returned invalid JSON for the EC8A read',
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      fields: {},
      partyResults: {},
      confidence: null,
      unreadable: true,
      error: 'AI returned an unexpected EC8A payload',
    };
  }

  const body = parsed as Record<string, unknown>;
  const fieldsIn =
    body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)
      ? (body.fields as Record<string, unknown>)
      : {};
  const partiesIn =
    body.partyResults &&
    typeof body.partyResults === 'object' &&
    !Array.isArray(body.partyResults)
      ? (body.partyResults as Record<string, unknown>)
      : {};

  const coerceNumber = (value: unknown): number | null => {
    if (value == null || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.round(value));
    }
    if (typeof value === 'string') {
      const cleaned = value.replace(/,/g, '').replace(/[^\d.-]/g, '').trim();
      if (!cleaned) return null;
      const n = Number(cleaned);
      if (!Number.isFinite(n)) return null;
      return Math.max(0, Math.round(n));
    }
    return null;
  };

  const fields: Record<string, number | null> = {};
  for (const key of FIELD_KEYS) {
    fields[key] = coerceNumber(fieldsIn[key]);
  }

  const partyResults: Record<string, number> = {};
  const allowed = new Set(partyCodes.map((c) => c.toUpperCase()));
  for (const [code, value] of Object.entries(partiesIn)) {
    const votes = coerceNumber(value);
    if (votes == null || votes < 0) continue;
    const upper = code.trim().toUpperCase();
    if (!upper) continue;
    if (allowed.size > 0 && !allowed.has(upper)) continue;
    partyResults[upper] = votes;
  }

  const confidence =
    typeof body.confidence === 'number' && Number.isFinite(body.confidence)
      ? Math.min(1, Math.max(0, body.confidence))
      : null;
  const unreadable = body.unreadable === true;
  const readableCount =
    Object.values(fields).filter((n) => n != null).length + Object.keys(partyResults).length;

  if (unreadable || readableCount === 0) {
    return {
      fields,
      partyResults,
      confidence: confidence ?? 0.2,
      unreadable: true,
      error:
        'AI could not read clear figures from the EC8A — retake with better light and fill the frame',
    };
  }

  return {
    fields,
    partyResults,
    confidence: confidence ?? Math.min(0.95, 0.45 + readableCount * 0.04),
    unreadable: false,
  };
}
