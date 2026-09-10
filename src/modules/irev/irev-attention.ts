/** Client-party (or total valid) deltas below this are noise, not a hold sheet. */
export const MATERIAL_PARTY_DELTA = 5;
export const MATERIAL_VOTES_CAST_DELTA = 10;
export const HIGH_OCR_CONFIDENCE = 0.75;
export const ATTENTION_FEED_WINDOW_MINUTES = 20;

export type IrevAttentionStatus =
  | 'MATCH'
  | 'MISMATCH'
  | 'IREV_MISSING'
  | 'PENDING'
  | 'UNREADABLE'
  | 'REPLACED';

export interface IrevAttentionDiff {
  field: string;
  label?: string;
  agent: number | null;
  irev: number | null;
}

export interface IrevSummaryDiffLine {
  label: string;
  agent: number;
  irev: number;
}

export interface IrevAttentionRecord {
  status: IrevAttentionStatus;
  recommendation?: string;
  diffs: IrevAttentionDiff[];
  substitutionDiffs?: IrevAttentionDiff[];
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

export type IrevSeverity =
  | 'REPLACED_MATERIAL'
  | 'MISMATCH_HIGH_CONF'
  | 'REPLACED'
  | 'MISMATCH_LOW_CONF'
  | 'UNREADABLE'
  | 'MISMATCH_IMMATERIAL'
  | 'AWAITING'
  | 'ALIGNED';

const SEVERITY_RANK: Record<IrevSeverity, number> = {
  REPLACED_MATERIAL: 0,
  MISMATCH_HIGH_CONF: 1,
  REPLACED: 2,
  MISMATCH_LOW_CONF: 3,
  UNREADABLE: 4,
  MISMATCH_IMMATERIAL: 5,
  AWAITING: 6,
  ALIGNED: 7,
};

export interface IrevPartyDelta {
  agent: number | null;
  irev: number | null;
  delta: number | null;
}

export interface IrevVotesAtRiskPu {
  resultId: string;
  pollingUnitId: string;
  pollingUnitCode: string;
  pollingUnitName: string;
  wardName?: string;
  lgaName: string;
  stateName: string;
  agent: number | null;
  irev: number | null;
  delta: number | null;
  replaced: boolean;
  severity?: IrevSeverity;
}

export interface IrevVotesAtRisk {
  partyCode: string | null;
  votesAtRisk: number;
  votesAgainst: number;
  comparablePus: number;
  agentHigherPus: number;
  irevHigherPus: number;
  replacedPus: number;
  topPus: IrevVotesAtRiskPu[];
}

export interface IrevAttentionCluster {
  wardId: string;
  wardName: string;
  lgaName: string;
  stateName: string;
  comparedPus: number;
  mismatchPus: number;
  replacedPus: number;
  votesAtRisk: number;
  headline: string;
}

export interface IrevAttentionFeed {
  windowMinutes: number;
  newOfficialScans: number;
  newMaterialMismatches: number;
  replacements: number;
  newlyAligned: number;
}

export function isMaterialDelta(delta: number | null | undefined, threshold: number): boolean {
  return typeof delta === 'number' && Number.isFinite(delta) && Math.abs(delta) >= threshold;
}

export function isHighOcrConfidence(confidence: number | null | undefined): boolean {
  return typeof confidence === 'number' && confidence >= HIGH_OCR_CONFIDENCE;
}

export function severityFor(
  status: IrevAttentionStatus,
  material: boolean,
  ocrConfidence: number | null | undefined,
): IrevSeverity {
  if (status === 'MATCH') return 'ALIGNED';
  if (status === 'PENDING' || status === 'IREV_MISSING') return 'AWAITING';
  if (status === 'UNREADABLE') return 'UNREADABLE';
  if (status === 'REPLACED') return material ? 'REPLACED_MATERIAL' : 'REPLACED';
  if (status === 'MISMATCH') {
    if (!material) return 'MISMATCH_IMMATERIAL';
    return isHighOcrConfidence(ocrConfidence) ? 'MISMATCH_HIGH_CONF' : 'MISMATCH_LOW_CONF';
  }
  return 'AWAITING';
}

export function irevAttentionSortRank(
  verification: Pick<IrevAttentionRecord, 'status' | 'severity' | 'recommendation'> | null | undefined,
): number {
  if (!verification) return SEVERITY_RANK.AWAITING;
  if (verification.severity && verification.severity in SEVERITY_RANK) {
    return SEVERITY_RANK[verification.severity];
  }
  return SEVERITY_RANK[severityFor(verification.status, false, null)];
}

export function partyDeltaFromVerification(
  verification: IrevAttentionRecord,
  clientPartyCode: string | null | undefined,
  agentPartyResults?: Record<string, number> | null,
): IrevPartyDelta {
  if (!clientPartyCode) {
    return { agent: null, irev: null, delta: null };
  }
  const code = clientPartyCode.toUpperCase();
  const partyField = `party:${code}`;
  const diff =
    verification.diffs.find((row) => row.field === partyField) ??
    verification.substitutionDiffs?.find((row) => row.field === partyField);

  const agentFromDiff = diff && typeof diff.agent === 'number' ? diff.agent : null;
  const irevFromDiff = diff && typeof diff.irev === 'number' ? diff.irev : null;
  const agentFromParties =
    agentPartyResults && typeof agentPartyResults[code] === 'number'
      ? agentPartyResults[code]
      : agentPartyResults && typeof agentPartyResults[clientPartyCode] === 'number'
        ? agentPartyResults[clientPartyCode]
        : null;
  const irevFromFields =
    verification.irevFields && typeof verification.irevFields[partyField] === 'number'
      ? verification.irevFields[partyField]
      : null;

  const agent =
    typeof verification.clientPartyAgent === 'number'
      ? verification.clientPartyAgent
      : (agentFromDiff ?? agentFromParties);
  const irev =
    typeof verification.clientPartyIrev === 'number'
      ? verification.clientPartyIrev
      : (irevFromDiff ?? irevFromFields);

  if (agent == null && irev == null) {
    return { agent: null, irev: null, delta: null };
  }
  if (agent == null || irev == null) {
    return { agent, irev, delta: null };
  }
  return { agent, irev, delta: agent - irev };
}

function votesCastDeltaFromVerification(verification: IrevAttentionRecord): number | null {
  if (typeof verification.votesCastDelta === 'number') return verification.votesCastDelta;
  const diff = verification.diffs.find((row) => row.field === 'votesCast');
  if (typeof diff?.agent === 'number' && typeof diff.irev === 'number') {
    return diff.agent - diff.irev;
  }
  return null;
}

export function attachAttention<T extends IrevAttentionRecord>(
  verification: T,
  opts: {
    clientPartyCode?: string | null;
    agentPartyResults?: Record<string, number> | null;
    ocrConfidence?: number | null;
  } = {},
): T & {
  ocrConfidence: number | null;
  clientPartyCode: string | null;
  clientPartyAgent: number | null;
  clientPartyIrev: number | null;
  clientPartyDelta: number | null;
  votesCastDelta: number | null;
  material: boolean;
  severity: IrevSeverity;
} {
  const ocrConfidence = opts.ocrConfidence ?? verification.ocrConfidence ?? null;
  const clientPartyCode = opts.clientPartyCode ?? verification.clientPartyCode ?? null;
  const party = partyDeltaFromVerification(verification, clientPartyCode, opts.agentPartyResults);
  const votesCastDelta = votesCastDeltaFromVerification(verification);
  const material =
    isMaterialDelta(party.delta, MATERIAL_PARTY_DELTA) ||
    isMaterialDelta(votesCastDelta, MATERIAL_VOTES_CAST_DELTA);
  return {
    ...verification,
    ocrConfidence,
    clientPartyCode,
    clientPartyAgent: party.agent,
    clientPartyIrev: party.irev,
    clientPartyDelta: party.delta,
    votesCastDelta,
    material,
    severity: severityFor(verification.status, material, ocrConfidence),
  };
}

export function emptyVotesAtRisk(partyCode: string | null): IrevVotesAtRisk {
  return {
    partyCode,
    votesAtRisk: 0,
    votesAgainst: 0,
    comparablePus: 0,
    agentHigherPus: 0,
    irevHigherPus: 0,
    replacedPus: 0,
    topPus: [],
  };
}

export function summarizeVotesAtRisk(
  partyCode: string | null,
  rows: IrevVotesAtRiskPu[],
): IrevVotesAtRisk {
  const summary = emptyVotesAtRisk(partyCode);
  for (const row of rows) {
    const replaced = row.replaced;
    if (replaced) summary.replacedPus += 1;
    if (row.delta == null) continue;
    if (!isMaterialDelta(row.delta, MATERIAL_PARTY_DELTA) && !replaced) continue;
    summary.comparablePus += 1;
    if (row.delta > 0) {
      summary.votesAtRisk += row.delta;
      summary.agentHigherPus += 1;
    } else if (row.delta < 0) {
      summary.votesAgainst += Math.abs(row.delta);
      summary.irevHigherPus += 1;
    }
  }
  summary.topPus = [...rows]
    .filter((row) => row.replaced || isMaterialDelta(row.delta, MATERIAL_PARTY_DELTA))
    .sort((a, b) => {
      if (a.replaced !== b.replaced) return a.replaced ? -1 : 1;
      return Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0);
    })
    .slice(0, 8);
  return summary;
}

export function clusterAttentionRows(
  rows: Array<{
    wardId: string;
    wardName: string;
    lgaName: string;
    stateName: string;
    mismatch: boolean;
    replaced: boolean;
    votesAtRisk: number;
  }>,
): IrevAttentionCluster[] {
  const byWard = new Map<
    string,
    {
      wardId: string;
      wardName: string;
      lgaName: string;
      stateName: string;
      comparedPus: number;
      mismatchPus: number;
      replacedPus: number;
      votesAtRisk: number;
    }
  >();

  for (const row of rows) {
    if (!row.wardId) continue;
    const current = byWard.get(row.wardId) ?? {
      wardId: row.wardId,
      wardName: row.wardName,
      lgaName: row.lgaName,
      stateName: row.stateName,
      comparedPus: 0,
      mismatchPus: 0,
      replacedPus: 0,
      votesAtRisk: 0,
    };
    current.comparedPus += 1;
    if (row.mismatch) current.mismatchPus += 1;
    if (row.replaced) current.replacedPus += 1;
    current.votesAtRisk += Math.max(0, row.votesAtRisk);
    byWard.set(row.wardId, current);
  }

  return [...byWard.values()]
    .filter((row) => row.mismatchPus + row.replacedPus > 0)
    .sort((a, b) => {
      if (b.votesAtRisk !== a.votesAtRisk) return b.votesAtRisk - a.votesAtRisk;
      return b.mismatchPus + b.replacedPus - (a.mismatchPus + a.replacedPus);
    })
    .slice(0, 8)
    .map((row) => ({
      ...row,
      headline: [
        `${row.wardName}: ${row.mismatchPus} of ${row.comparedPus} compared PUs mismatch`,
        row.votesAtRisk > 0 ? `+${row.votesAtRisk.toLocaleString()} votes vs IReV` : null,
        row.replacedPus > 0
          ? `${row.replacedPus} replacement${row.replacedPus === 1 ? '' : 's'}`
          : null,
      ]
        .filter(Boolean)
        .join(' · '),
    }));
}

const SUMMARY_FIELD_LABELS: Record<string, string> = {
  registeredVoters: 'Voters on the register',
  accreditedVoters: 'Accredited voters',
  ballotPapersIssued: 'Ballot papers issued',
  unusedBallotPapers: 'Unused ballot papers',
  spoiledBallotPapers: 'Spoiled ballot papers',
  invalidVotes: 'Rejected ballots',
  votesCast: 'Total valid votes',
  usedBallotPapers: 'Used ballot papers',
};

export function summaryFieldDiffLines(
  diffs: IrevAttentionDiff[] | undefined,
  clientPartyDelta?: number | null,
): IrevSummaryDiffLine[] {
  if (!Array.isArray(diffs) || diffs.length === 0) return [];
  if (clientPartyDelta != null && clientPartyDelta !== 0) return [];
  return diffs
    .filter((diff) => !diff.field.startsWith('party:'))
    .filter((diff) => typeof diff.agent === 'number' && typeof diff.irev === 'number')
    .map((diff) => ({
      label: diff.label ?? SUMMARY_FIELD_LABELS[diff.field] ?? diff.field,
      agent: diff.agent as number,
      irev: diff.irev as number,
    }));
}

export function formatSummaryDiffHeadline(lines: IrevSummaryDiffLine[]): string | null {
  if (lines.length === 0) return null;
  const preview = lines.slice(0, 2).map((line) => {
    const agent = line.agent.toLocaleString();
    const irev = line.irev.toLocaleString();
    return `${line.label}: agent ${agent}, official ${irev}`;
  });
  const suffix = lines.length > 2 ? ` (+${lines.length - 2} more)` : '';
  return `${preview.join(' · ')}${suffix}`;
}

export function explainIrevAttention(input: {
  status: IrevAttentionStatus | string;
  partyCode?: string | null;
  agent: number | null;
  irev: number | null;
  delta: number | null;
  ocrConfidence?: number | null;
  replacedAt?: string | null;
  submittedAt?: string | null;
  publishedAt?: string | null;
  summaryDiffs?: IrevAttentionDiff[];
}): string {
  const party = input.partyCode ? `${input.partyCode} ` : '';
  const parts: string[] = [];

  const summaryLines = summaryFieldDiffLines(input.summaryDiffs, input.delta);

  if (input.agent != null && input.irev != null && input.delta != null) {
    const amount = Math.abs(input.delta).toLocaleString();
    const whoHasMore =
      input.delta > 0
        ? `Agent recorded ${amount} more than the official scan.`
        : input.delta < 0
          ? `Official scan shows ${amount} more than the agent.`
          : 'The two figures match.';
    parts.push(
      `Agent recorded ${input.agent.toLocaleString()} ${party}votes. Official scan shows ${input.irev.toLocaleString()}. ${whoHasMore}`,
    );
    if (input.delta === 0 && summaryLines.length > 0) {
      const headline = formatSummaryDiffHeadline(summaryLines);
      if (headline) {
        parts.push(`Other fields differ on the official scan: ${headline}.`);
      }
    }
  } else if (input.status === 'UNREADABLE') {
    parts.push('Official IReV scan exists but OCR could not extract figures.');
  } else if (input.status === 'IREV_MISSING' || input.status === 'PENDING') {
    parts.push('No comparable official IReV figures yet.');
  } else if (input.status === 'REPLACED') {
    parts.push('INEC replaced the official IReV scan after we already read one.');
  } else if (input.status === 'MATCH') {
    parts.push('Agent figures align with the official IReV scan.');
  }

  if (typeof input.ocrConfidence === 'number') {
    parts.push(`OCR confidence: ${Math.round(input.ocrConfidence * 100)}%.`);
  }
  if (input.replacedAt) {
    parts.push(`Official scan replaced at ${input.replacedAt}.`);
  }
  if (input.submittedAt && input.publishedAt) {
    const submitted = Date.parse(input.submittedAt);
    const published = Date.parse(input.publishedAt);
    if (Number.isFinite(submitted) && Number.isFinite(published)) {
      const minutes = Math.round((published - submitted) / 60_000);
      const abs = Math.abs(minutes);
      if (abs > 0 && abs < 48 * 60) {
        const lag =
          abs < 90
            ? `${abs} minute${abs === 1 ? '' : 's'}`
            : `${Math.round(abs / 60)} hour${Math.round(abs / 60) === 1 ? '' : 's'}`;
        parts.push(
          minutes >= 0
            ? `IReV published ${lag} after the agent submission.`
            : `IReV published ${lag} before the agent submission.`,
        );
      }
    }
  }
  return parts.join(' ');
}
