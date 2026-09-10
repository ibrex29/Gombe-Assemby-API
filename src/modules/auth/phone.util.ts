/**
 * Normalize Nigerian phone numbers for storage and login lookup.
 * Accepts: 0803..., 234803..., +234803..., and formats with spaces/dashes.
 * Returns E.164-style +234… or null if empty/invalid shape.
 */
export function normalizePhoneNumber(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/[^\d+]/g, '');
  if (!digits) return null;

  let normalized = digits;
  if (normalized.startsWith('+')) {
    normalized = `+${normalized.slice(1).replace(/\D/g, '')}`;
  } else {
    const onlyDigits = normalized.replace(/\D/g, '');
    if (onlyDigits.startsWith('234') && onlyDigits.length >= 13) {
      normalized = `+${onlyDigits}`;
    } else if (onlyDigits.startsWith('0') && onlyDigits.length === 11) {
      normalized = `+234${onlyDigits.slice(1)}`;
    } else if (onlyDigits.length === 10) {
      normalized = `+234${onlyDigits}`;
    } else if (onlyDigits.length >= 11) {
      normalized = `+${onlyDigits}`;
    } else {
      return null;
    }
  }

  // Nigeria mobile: +234 + 10 digits
  if (!/^\+234\d{10}$/.test(normalized)) {
    // Allow other international for flexibility, or common seed lengths
    if (!/^\+\d{10,15}$/.test(normalized)) {
      return null;
    }
  }

  return normalized;
}

/** Candidate lookup forms if stored data is slightly inconsistent */
export function phoneLookupCandidates(input: string): string[] {
  const primary = normalizePhoneNumber(input);
  const candidates = new Set<string>();
  if (primary) candidates.add(primary);

  const digits = input.replace(/\D/g, '');
  if (digits) {
    if (digits.startsWith('234')) candidates.add(`+${digits}`);
    if (digits.startsWith('0') && digits.length === 11) candidates.add(`+234${digits.slice(1)}`);
    if (digits.length === 10) candidates.add(`+234${digits}`);
    candidates.add(digits);
    if (digits.startsWith('234')) candidates.add(digits);
  }

  return [...candidates];
}
