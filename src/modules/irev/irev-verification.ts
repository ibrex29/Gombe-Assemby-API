import { Prisma } from '@electromon/db';
import type { VisionExtract } from '../collation/ocr-ec8a-parse';
import { partyVotesSum, type CollationFigures } from '../collation/ocr-verification';
import {
  attachAttention,
  irevAttentionSortRank,
  type IrevSeverity,
} from './irev-attention';

export type IrevVerificationStatus =
  | 'MATCH'
  | 'MISMATCH'
  | 'IREV_MISSING'
  | 'PENDING'
  | 'UNREADABLE'
  | 'REPLACED';

export type IrevRecommendation = 'ALIGNED' | 'INVESTIGATE' | 'WAIT_IREV';

export interface IrevVerificationDiff {
  field: string;
  label: string;
  agent: number | null;
  irev: number | null;
  message: string;
}

export interface IrevVerification {
  status: IrevVerificationStatus;
  recommendation: IrevRecommendation;
  diffs: IrevVerificationDiff[];
  substitutionDiffs?: IrevVerificationDiff[];
  irevDocumentUrl: string | null;
  previousIrevDocumentUrl?: string | null;
  replacedAt?: string | null;
  verifiedAt: string;
  ocrError?: string | null;
  irevFields?: Record<string, number | null>;
  ocrConfidence?: number | null;
  clientPartyCode?: string | null;
  clientPartyAgent?: number | null;
  clientPartyIrev?: number | null;
  clientPartyDelta?: number | null;
  votesCastDelta?: number | null;
  material?: boolean;
  severity?: IrevSeverity;
}

const SUMMARY_FIELDS: Array<{
  field: keyof Pick<
    CollationFigures,
    | 'registeredVoters'
    | 'accreditedVoters'
    | 'ballotPapersIssued'
    | 'unusedBallotPapers'
    | 'spoiledBallotPapers'
    | 'invalidVotes'
    | 'votesCast'
    | 'usedBallotPapers'
  >;
  label: string;
}> = [
  { field: 'registeredVoters', label: 'Voters on the register' },
  { field: 'accreditedVoters', label: 'Accredited voters' },
  { field: 'ballotPapersIssued', label: 'Ballot papers issued' },
  { field: 'unusedBallotPapers', label: 'Unused ballot papers' },
  { field: 'spoiledBallotPapers', label: 'Spoiled ballot papers' },
  { field: 'invalidVotes', label: 'Rejected ballots' },
  { field: 'votesCast', label: 'Total valid votes' },
  { field: 'usedBallotPapers', label: 'Used ballot papers' },
];

function addDiff(
  diffs: IrevVerificationDiff[],
  field: string,
  label: string,
  agent: number | null,
  irev: number | null,
  message: string,
) {
  diffs.push({ field, label, agent, irev, message });
}

function partyVotesEqual(agent: number | null, irev: number | null): boolean {
  return (agent ?? 0) === (irev ?? 0);
}

function typedNumber(input: CollationFigures, field: string): number | null {
  const value = (input as Record<string, unknown>)[field];
  return typeof value === 'number' ? value : null;
}

function extractAsFigures(extract: VisionExtract): CollationFigures {
  return {
    registeredVoters: extract.fields.registeredVoters ?? null,
    accreditedVoters: extract.fields.accreditedVoters ?? null,
    ballotPapersIssued: extract.fields.ballotPapersIssued ?? null,
    unusedBallotPapers: extract.fields.unusedBallotPapers ?? null,
    spoiledBallotPapers: extract.fields.spoiledBallotPapers ?? null,
    invalidVotes: extract.fields.invalidVotes ?? null,
    votesCast: extract.fields.votesCast ?? null,
    usedBallotPapers: extract.fields.usedBallotPapers ?? null,
    partyResults: extract.partyResults,
  };
}

export function isIrevDocumentSubstitution(
  previousHash: string | null | undefined,
  nextHash: string | null | undefined,
): boolean {
  return Boolean(previousHash && nextHash && previousHash !== nextHash);
}

export function buildIrevDiffs(
  agent: CollationFigures,
  irevExtract: VisionExtract,
  partyCodes: string[],
  message = 'differ from official IReV scan',
): IrevVerificationDiff[] {
  const diffs: IrevVerificationDiff[] = [];

  for (const spec of SUMMARY_FIELDS) {
    const agentValue = typedNumber(agent, spec.field);
    const irevValue =
      typeof irevExtract.fields[spec.field] === 'number' ? irevExtract.fields[spec.field] : null;
    if (agentValue == null || irevValue == null) continue;
    if (agentValue === irevValue) continue;
    addDiff(
      diffs,
      spec.field,
      spec.label,
      agentValue,
      irevValue,
      `${spec.label} ${message}`,
    );
  }

  const agentParties =
    agent.partyResults && typeof agent.partyResults === 'object' && !Array.isArray(agent.partyResults)
      ? (agent.partyResults as Record<string, number>)
      : {};

  for (const code of partyCodes) {
    const upper = code.toUpperCase();
    const agentVotes = agentParties[upper] ?? agentParties[code] ?? null;
    const irevVotes = irevExtract.partyResults[upper] ?? irevExtract.partyResults[code] ?? null;
    if (agentVotes == null && irevVotes == null) continue;
    if (!partyVotesEqual(agentVotes, irevVotes)) {
      addDiff(diffs, `party:${upper}`, `${upper} votes`, agentVotes, irevVotes, `${upper} votes ${message}`);
    }
  }

  return diffs;
}

export function compareAgentToIrev(input: {
  agent: CollationFigures;
  irevExtract: VisionExtract | null;
  partyCodes: string[];
  documentUrl: string | null;
  missingOnIrev?: boolean;
  unreadable?: boolean;
  ocrError?: string | null;
  previousIrevExtract?: VisionExtract | null;
  previousDocumentUrl?: string | null;
  replacedAt?: string | null;
  clientPartyCode?: string | null;
}): IrevVerification {
  const verifiedAt = new Date().toISOString();
  const replaced =
    Boolean(input.previousIrevExtract) || Boolean(input.replacedAt) || Boolean(input.previousDocumentUrl);
  const agentParties =
    input.agent.partyResults && typeof input.agent.partyResults === 'object' && !Array.isArray(input.agent.partyResults)
      ? (input.agent.partyResults as Record<string, number>)
      : null;

  const withAttention = (verification: IrevVerification): IrevVerification =>
    attachAttention(verification, {
      clientPartyCode: input.clientPartyCode,
      agentPartyResults: agentParties,
      ocrConfidence: input.irevExtract?.confidence ?? null,
    });

  if (input.missingOnIrev) {
    return withAttention({
      status: 'IREV_MISSING',
      recommendation: 'WAIT_IREV',
      diffs: [],
      irevDocumentUrl: null,
      verifiedAt,
    });
  }

  if (input.unreadable || !input.irevExtract) {
    return withAttention({
      status: replaced ? 'REPLACED' : 'UNREADABLE',
      recommendation: 'INVESTIGATE',
      diffs: [],
      substitutionDiffs: [],
      irevDocumentUrl: input.documentUrl,
      previousIrevDocumentUrl: input.previousDocumentUrl ?? null,
      replacedAt: input.replacedAt ?? (replaced ? verifiedAt : null),
      verifiedAt,
      ocrError: input.ocrError ?? 'Could not read official IReV scan',
      irevFields: input.irevExtract?.fields,
    });
  }

  const diffs = buildIrevDiffs(input.agent, input.irevExtract, input.partyCodes);
  const substitutionDiffs = input.previousIrevExtract
    ? buildIrevDiffs(
        extractAsFigures(input.previousIrevExtract),
        input.irevExtract,
        input.partyCodes,
        'changed on the official IReV scan',
      )
    : [];
  const mismatch = diffs.length > 0;

  if (replaced) {
    return withAttention({
      status: 'REPLACED',
      recommendation: 'INVESTIGATE',
      diffs,
      substitutionDiffs,
      irevDocumentUrl: input.documentUrl,
      previousIrevDocumentUrl: input.previousDocumentUrl ?? null,
      replacedAt: input.replacedAt ?? verifiedAt,
      verifiedAt,
      irevFields: {
        ...input.irevExtract.fields,
        ...Object.fromEntries(
          Object.entries(input.irevExtract.partyResults).map(([code, votes]) => [`party:${code}`, votes]),
        ),
      },
    });
  }

  return withAttention({
    status: mismatch ? 'MISMATCH' : 'MATCH',
    recommendation: mismatch ? 'INVESTIGATE' : 'ALIGNED',
    diffs,
    irevDocumentUrl: input.documentUrl,
    verifiedAt,
    irevFields: {
      ...input.irevExtract.fields,
      ...Object.fromEntries(
        Object.entries(input.irevExtract.partyResults).map(([code, votes]) => [`party:${code}`, votes]),
      ),
    },
  });
}

export function pendingIrevVerification(): IrevVerification {
  return attachAttention({
    status: 'PENDING',
    recommendation: 'WAIT_IREV',
    diffs: [],
    irevDocumentUrl: null,
    verifiedAt: new Date().toISOString(),
  });
}

function parseDiffs(value: unknown): IrevVerificationDiff[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((diff): diff is Record<string, unknown> => !!diff && typeof diff === 'object')
    .map((diff) => ({
      field: typeof diff.field === 'string' ? diff.field : 'unknown',
      label: typeof diff.label === 'string' ? diff.label : 'Field',
      agent: typeof diff.agent === 'number' ? diff.agent : null,
      irev: typeof diff.irev === 'number' ? diff.irev : null,
      message: typeof diff.message === 'string' ? diff.message : '',
    }));
}

export function parseIrevVerification(value: unknown): IrevVerification | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const status = row.status;
  const recommendation = row.recommendation;
  if (
    status !== 'MATCH' &&
    status !== 'MISMATCH' &&
    status !== 'IREV_MISSING' &&
    status !== 'PENDING' &&
    status !== 'UNREADABLE' &&
    status !== 'REPLACED'
  ) {
    return null;
  }
  if (
    recommendation !== 'ALIGNED' &&
    recommendation !== 'INVESTIGATE' &&
    recommendation !== 'WAIT_IREV'
  ) {
    return null;
  }
  const parsed: IrevVerification = {
    status,
    recommendation,
    diffs: parseDiffs(row.diffs),
    substitutionDiffs: parseDiffs(row.substitutionDiffs),
    irevDocumentUrl: typeof row.irevDocumentUrl === 'string' ? row.irevDocumentUrl : null,
    previousIrevDocumentUrl:
      typeof row.previousIrevDocumentUrl === 'string' ? row.previousIrevDocumentUrl : null,
    replacedAt: typeof row.replacedAt === 'string' ? row.replacedAt : null,
    verifiedAt: typeof row.verifiedAt === 'string' ? row.verifiedAt : new Date().toISOString(),
    ocrError: typeof row.ocrError === 'string' ? row.ocrError : null,
    irevFields:
      row.irevFields && typeof row.irevFields === 'object' && !Array.isArray(row.irevFields)
        ? Object.fromEntries(
            Object.entries(row.irevFields as Record<string, unknown>).map(([key, value]) => [
              key,
              typeof value === 'number' ? value : null,
            ]),
          )
        : undefined,
    ocrConfidence: typeof row.ocrConfidence === 'number' ? row.ocrConfidence : null,
    clientPartyCode: typeof row.clientPartyCode === 'string' ? row.clientPartyCode : null,
    clientPartyAgent: typeof row.clientPartyAgent === 'number' ? row.clientPartyAgent : null,
    clientPartyIrev: typeof row.clientPartyIrev === 'number' ? row.clientPartyIrev : null,
    clientPartyDelta: typeof row.clientPartyDelta === 'number' ? row.clientPartyDelta : null,
    votesCastDelta: typeof row.votesCastDelta === 'number' ? row.votesCastDelta : null,
    material: typeof row.material === 'boolean' ? row.material : undefined,
    severity:
      row.severity === 'REPLACED_MATERIAL' ||
      row.severity === 'MISMATCH_HIGH_CONF' ||
      row.severity === 'REPLACED' ||
      row.severity === 'MISMATCH_LOW_CONF' ||
      row.severity === 'UNREADABLE' ||
      row.severity === 'MISMATCH_IMMATERIAL' ||
      row.severity === 'AWAITING' ||
      row.severity === 'ALIGNED'
        ? row.severity
        : undefined,
  };
  return attachAttention(parsed);
}

export function resolveIrevVerification(input: {
  irevVerification?: unknown;
}): IrevVerification | null {
  return parseIrevVerification(input.irevVerification);
}

/** Confirmed IReV QA mismatches: agent figures differ from the official scan, or the scan was replaced. */
export function isIrevQaMismatch(verification: unknown): boolean {
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) {
    return false;
  }
  const row = verification as { status?: unknown; recommendation?: unknown };
  return (
    row.status === 'MISMATCH' ||
    row.status === 'REPLACED' ||
    row.recommendation === 'INVESTIGATE'
  );
}

export function persistIrevVerification(verification: IrevVerification): {
  irevVerification: Prisma.InputJsonValue;
  irevVerifiedAt: Date;
} {
  return {
    irevVerification: verification as unknown as Prisma.InputJsonValue,
    irevVerifiedAt: new Date(verification.verifiedAt),
  };
}

export function irevVerificationSortRank(
  verification: IrevVerification | null | undefined,
): number {
  return irevAttentionSortRank(verification);
}

export function agentHasComparableFigures(agent: CollationFigures): boolean {
  return partyVotesSum(agent.partyResults) != null || agent.votesCast != null;
}
