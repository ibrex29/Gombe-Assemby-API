import { Prisma } from '@electromon/db';

export type OcrVerificationStatus = 'MATCH' | 'MISMATCH' | 'UNREADABLE' | 'PENDING';
export type OcrRecommendation = 'APPROVE' | 'RETURN' | 'CHECK_PHOTO';
export type OcrVerificationEngine = 'ARITHMETIC' | 'OCR';

export interface OcrVerificationDiff {
  field: string;
  label: string;
  typed: number | null;
  expected: number | null;
  message: string;
}

export interface OcrVerification {
  status: OcrVerificationStatus;
  recommendation: OcrRecommendation;
  engine: OcrVerificationEngine;
  confidence: number | null;
  arithmeticFlags: string[];
  diffs: OcrVerificationDiff[];
  suggestedRejectReason: string | null;
  photoCount: number;
  verifiedAt: string;
  ocrError?: string | null;
  ocrFields?: Record<string, number | null>;
}

export interface CollationFigures {
  registeredVoters?: number | null;
  accreditedVoters?: number | null;
  ballotPapersIssued?: number | null;
  unusedBallotPapers?: number | null;
  spoiledBallotPapers?: number | null;
  invalidVotes?: number | null;
  votesCast?: number | null;
  usedBallotPapers?: number | null;
  partyResults?: unknown;
  ec8aPhotoUrls?: string[] | null;
  ocrVerification?: unknown;
}

const RECOMMENDATION_RANK: Record<OcrRecommendation, number> = {
  RETURN: 0,
  CHECK_PHOTO: 1,
  APPROVE: 2,
};

export function partyVotesSum(partyResults: unknown): number | null {
  if (!partyResults || typeof partyResults !== 'object' || Array.isArray(partyResults)) {
    return null;
  }
  let sum = 0;
  let any = false;
  for (const value of Object.values(partyResults as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    sum += value;
    any = true;
  }
  return any ? sum : null;
}

export function hasAnyFigures(input: CollationFigures): boolean {
  return [
    input.registeredVoters,
    input.accreditedVoters,
    input.ballotPapersIssued,
    input.unusedBallotPapers,
    input.spoiledBallotPapers,
    input.invalidVotes,
    input.votesCast,
    input.usedBallotPapers,
    partyVotesSum(input.partyResults),
  ].some((value) => value != null);
}

function addDiff(
  diffs: OcrVerificationDiff[],
  flags: string[],
  field: string,
  label: string,
  typed: number | null,
  expected: number | null,
  message: string,
  flag: string,
) {
  diffs.push({ field, label, typed, expected, message });
  flags.push(flag);
}

export function arithmeticVerification(input: CollationFigures): OcrVerification {
  const verifiedAt = new Date().toISOString();
  const photoCount = input.ec8aPhotoUrls?.length ?? 0;
  const partySum = partyVotesSum(input.partyResults);
  const diffs: OcrVerificationDiff[] = [];
  const arithmeticFlags: string[] = [];

  if (!hasAnyFigures(input)) {
    return {
      status: 'PENDING',
      recommendation: 'CHECK_PHOTO',
      engine: 'ARITHMETIC',
      confidence: null,
      arithmeticFlags: ['FIGURES_INCOMPLETE'],
      diffs: [],
      suggestedRejectReason: null,
      photoCount,
      verifiedAt,
    };
  }

  const registered = input.registeredVoters ?? null;
  const accredited = input.accreditedVoters ?? null;
  const issued = input.ballotPapersIssued ?? null;
  const unused = input.unusedBallotPapers ?? null;
  const spoiled = input.spoiledBallotPapers ?? null;
  const rejected = input.invalidVotes ?? null;
  const valid = input.votesCast ?? null;
  const used = input.usedBallotPapers ?? null;

  if (accredited != null && registered != null && accredited > registered) {
    addDiff(
      diffs,
      arithmeticFlags,
      'accreditedVoters',
      'Accredited voters',
      accredited,
      registered,
      `Accredited voters (${accredited}) exceed voters on the register (${registered}).`,
      'ACCREDITED_GT_REGISTERED',
    );
  }

  if (partySum != null && valid != null && partySum !== valid) {
    addDiff(
      diffs,
      arithmeticFlags,
      'votesCast',
      'Total valid votes',
      valid,
      partySum,
      `Party scores total ${partySum}, but total valid votes is ${valid}. On EC8A these should match.`,
      'PARTY_SUM_NE_VALID',
    );
  }

  const usedFromParts =
    spoiled != null || rejected != null || valid != null
      ? (spoiled ?? 0) + (rejected ?? 0) + (valid ?? 0)
      : null;
  if (used != null && usedFromParts != null && used !== usedFromParts) {
    addDiff(
      diffs,
      arithmeticFlags,
      'usedBallotPapers',
      'Used ballot papers',
      used,
      usedFromParts,
      `Used ballot papers is ${used}, but spoiled + rejected + valid = ${usedFromParts}.`,
      'USED_NE_SPOILED_REJECTED_VALID',
    );
  }

  const issuedFromParts =
    used != null || unused != null ? (used ?? 0) + (unused ?? 0) : null;
  if (issued != null && issuedFromParts != null && issued !== issuedFromParts) {
    addDiff(
      diffs,
      arithmeticFlags,
      'ballotPapersIssued',
      'Ballot papers issued',
      issued,
      issuedFromParts,
      `Issued ballots is ${issued}, but used + unused = ${issuedFromParts}.`,
      'ISSUED_NE_USED_UNUSED',
    );
  }

  if (accredited != null && used != null && accredited !== used) {
    addDiff(
      diffs,
      arithmeticFlags,
      'accreditedVoters',
      'Accredited vs used ballots',
      accredited,
      used,
      `Accredited voters (${accredited}) should equal used ballot papers (${used}).`,
      'ACCREDITED_NE_USED',
    );
  }

  const mismatch = diffs.length > 0;
  const suggestedRejectReason = mismatch
    ? diffs
        .slice(0, 2)
        .map((diff) => diff.message)
        .join(' ')
    : null;

  return {
    status: mismatch ? 'MISMATCH' : 'MATCH',
    recommendation: mismatch ? 'RETURN' : 'APPROVE',
    engine: 'ARITHMETIC',
    confidence: mismatch ? 1 : 1,
    arithmeticFlags,
    diffs,
    suggestedRejectReason,
    photoCount,
    verifiedAt,
  };
}

export function parseOcrVerification(value: unknown): OcrVerification | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const status = row.status;
  const recommendation = row.recommendation;
  if (
    status !== 'MATCH' &&
    status !== 'MISMATCH' &&
    status !== 'UNREADABLE' &&
    status !== 'PENDING'
  ) {
    return null;
  }
  if (
    recommendation !== 'APPROVE' &&
    recommendation !== 'RETURN' &&
    recommendation !== 'CHECK_PHOTO'
  ) {
    return null;
  }
  return {
    status,
    recommendation,
    engine: row.engine === 'OCR' ? 'OCR' : 'ARITHMETIC',
    confidence: typeof row.confidence === 'number' ? row.confidence : null,
    arithmeticFlags: Array.isArray(row.arithmeticFlags)
      ? row.arithmeticFlags.filter((flag): flag is string => typeof flag === 'string')
      : [],
    diffs: Array.isArray(row.diffs)
      ? row.diffs
          .filter((diff): diff is Record<string, unknown> => !!diff && typeof diff === 'object')
          .map((diff) => ({
            field: typeof diff.field === 'string' ? diff.field : 'unknown',
            label: typeof diff.label === 'string' ? diff.label : 'Field',
            typed: typeof diff.typed === 'number' ? diff.typed : null,
            expected: typeof diff.expected === 'number' ? diff.expected : null,
            message: typeof diff.message === 'string' ? diff.message : '',
          }))
      : [],
    suggestedRejectReason:
      typeof row.suggestedRejectReason === 'string' ? row.suggestedRejectReason : null,
    photoCount: typeof row.photoCount === 'number' ? row.photoCount : 0,
    verifiedAt: typeof row.verifiedAt === 'string' ? row.verifiedAt : new Date().toISOString(),
    ocrError: typeof row.ocrError === 'string' ? row.ocrError : null,
    ocrFields:
      row.ocrFields && typeof row.ocrFields === 'object' && !Array.isArray(row.ocrFields)
        ? Object.fromEntries(
            Object.entries(row.ocrFields as Record<string, unknown>).map(([key, value]) => [
              key,
              typeof value === 'number' ? value : null,
            ]),
          )
        : undefined,
  };
}

/** Prefer stored JSON; otherwise compute arithmetic so seeded rows still show chips. */
export function resolveOcrVerification(input: CollationFigures): OcrVerification | null {
  const stored = parseOcrVerification(input.ocrVerification);
  if (stored) return stored;
  if (!hasAnyFigures(input)) return null;
  return arithmeticVerification(input);
}

export function ocrVerificationWrite(
  input: CollationFigures,
  options: { awaitingOcr?: boolean } = {},
): { ocrVerification: Prisma.InputJsonValue; ocrVerifiedAt: Date } {
  let verification = arithmeticVerification(input);
  const hasPhotos = (input.ec8aPhotoUrls?.length ?? 0) > 0;
  if (
    options.awaitingOcr &&
    hasPhotos &&
    verification.recommendation !== 'RETURN'
  ) {
    verification = {
      ...verification,
      status: 'PENDING',
      recommendation: 'CHECK_PHOTO',
      arithmeticFlags: [...verification.arithmeticFlags, 'OCR_PENDING'],
    };
  }
  return {
    ocrVerification: verification as unknown as Prisma.InputJsonValue,
    ocrVerifiedAt: new Date(verification.verifiedAt),
  };
}

export function persistOcrVerification(verification: OcrVerification): {
  ocrVerification: Prisma.InputJsonValue;
  ocrVerifiedAt: Date;
} {
  return {
    ocrVerification: verification as unknown as Prisma.InputJsonValue,
    ocrVerifiedAt: new Date(verification.verifiedAt),
  };
}

export function verificationSortRank(verification: OcrVerification | null | undefined): number {
  if (!verification) return 3;
  return RECOMMENDATION_RANK[verification.recommendation] ?? 3;
}

export function emptyPuVerificationCounts() {
  return {
    verifyMatched: 0,
    verifyFlagged: 0,
    verifyCheckPhoto: 0,
    verifyPending: 0,
  };
}

export function countPuVerifications(
  rows: Array<CollationFigures & { status?: string | null }>,
) {
  const counts = emptyPuVerificationCounts();
  for (const row of rows) {
    const verification = resolveOcrVerification(row);
    if (!verification) {
      counts.verifyPending += 1;
      continue;
    }
    if (verification.recommendation === 'RETURN') counts.verifyFlagged += 1;
    else if (verification.recommendation === 'CHECK_PHOTO') counts.verifyCheckPhoto += 1;
    else if (verification.recommendation === 'APPROVE') counts.verifyMatched += 1;
    else counts.verifyPending += 1;
  }
  return counts;
}
