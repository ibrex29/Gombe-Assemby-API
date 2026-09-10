export type OperationalStatus =
  | 'WINNING'
  | 'LOSING'
  | 'COMPETITIVE'
  | 'INSUFFICIENT_DATA'
  | 'AWAITING_APPROVAL'
  | 'INCIDENT_FLAGGED';

export type ScopeReporting = {
  pollingUnitsTotal: number;
  pollingUnitsReported: number;
  pollingUnitsApproved: number;
  percent: number;
  percentSubmitted: number;
  percentApproved: number;
};

export type ScopeVelocity = {
  newlyReported: number;
  newlyApproved: number;
  windowMinutes: number;
};

export type ApprovalPipeline = {
  pollingUnits: {
    total: number;
    submitted: number;
    wardVerified: number;
    lgaApproved: number;
    stateApproved: number;
    rejected: number;
    notStarted: number;
  };
};

export type DelayedPollingUnits = {
  count: number;
  thresholdMinutes: number;
};

export const INSUFFICIENT_DATA_THRESHOLD = 50;

export function isEarlyOperationalLead(
  percentSubmitted: number,
  status: OperationalStatus,
): boolean {
  return (
    (status === 'WINNING' || status === 'LOSING') &&
    percentSubmitted < INSUFFICIENT_DATA_THRESHOLD
  );
}
export const AWAITING_APPROVAL_GAP_PERCENT = 20;
export const COMPETITIVE_MARGIN_RATIO = 0.05;
export const STALE_REPORTING_MINUTES = 30;
export const DELAYED_PU_THRESHOLD_MINUTES = 90;

export type MapPartySelection = {
  parties: Record<string, number>;
  resultStatus: 'APPROVED' | 'SUBMITTED' | 'REJECTED' | 'NOT_STARTED';
  pendingValidation: boolean;
};

function partiesTotal(parties: Record<string, number>) {
  return Object.values(parties).reduce((sum, n) => sum + n, 0);
}

/**
 * Prefer approved vote totals. If none, fall back to unapproved PU totals
 * (submitted awaiting approval, or returned for correction).
 */
export function selectMapParties(
  approved: Record<string, number>,
  unapproved: Record<string, number>,
  unapprovedStatus: 'SUBMITTED' | 'REJECTED' = 'SUBMITTED',
): MapPartySelection {
  if (partiesTotal(approved) > 0) {
    return { parties: approved, resultStatus: 'APPROVED', pendingValidation: false };
  }
  if (partiesTotal(unapproved) > 0) {
    return { parties: unapproved, resultStatus: unapprovedStatus, pendingValidation: true };
  }
  return { parties: approved, resultStatus: 'NOT_STARTED', pendingValidation: false };
}

export function reportingStatsExtended(
  total: number,
  submitted: number,
  approved: number,
): ScopeReporting {
  return {
    pollingUnitsTotal: total,
    pollingUnitsReported: submitted,
    pollingUnitsApproved: approved,
    percent: total > 0 ? Math.round((submitted / total) * 1000) / 10 : 0,
    percentSubmitted: total > 0 ? Math.round((submitted / total) * 1000) / 10 : 0,
    percentApproved: total > 0 ? Math.round((approved / total) * 1000) / 10 : 0,
  };
}

export function computeOperationalStatus(input: {
  outcome: 'WIN' | 'LOSS' | 'TIE' | 'PENDING';
  margin: number;
  totalVotes: number;
  percentSubmitted: number;
  incidentUrgentCount: number;
  incidentCount: number;
  maxSeverity: string | null;
  approval?: ApprovalPipeline;
}): OperationalStatus {
  const urgentSeverity =
    input.maxSeverity === 'HIGH' || input.maxSeverity === 'CRITICAL';
  if (input.incidentUrgentCount > 0 || (input.incidentCount > 0 && urgentSeverity)) {
    return 'INCIDENT_FLAGGED';
  }

  if (input.totalVotes <= 0 || input.outcome === 'PENDING') {
    return 'INSUFFICIENT_DATA';
  }

  const lowReporting = input.percentSubmitted < INSUFFICIENT_DATA_THRESHOLD;
  if (lowReporting) {
    // Show an early trail the same way we show an early lead — grey is for no votes.
    if (input.outcome === 'WIN') return 'WINNING';
    if (input.outcome === 'LOSS') return 'LOSING';
    if (input.outcome === 'TIE') return 'COMPETITIVE';
  }

  const submitted = input.approval?.pollingUnits.submitted ?? 0;
  const wardVerified = input.approval?.pollingUnits.wardVerified ?? 0;
  const total = input.approval?.pollingUnits.total ?? 0;
  if (total > 0 && submitted > 0) {
    const submittedPct = (submitted / total) * 100;
    const approvedPct = (wardVerified / total) * 100;
    if (submittedPct - approvedPct >= AWAITING_APPROVAL_GAP_PERCENT) {
      return 'AWAITING_APPROVAL';
    }
  }

  const marginRatio = Math.abs(input.margin) / input.totalVotes;
  if (marginRatio < COMPETITIVE_MARGIN_RATIO) {
    return 'COMPETITIVE';
  }

  if (input.outcome === 'WIN') return 'WINNING';
  if (input.outcome === 'LOSS') return 'LOSING';
  if (input.outcome === 'TIE') return 'COMPETITIVE';
  return 'INSUFFICIENT_DATA';
}

export function computeScopeVelocity(
  puResults: Array<{
    scopeId: string;
    submittedAt: Date | null;
    approvedAt: Date | null;
    createdAt: Date;
  }>,
  scopePuIds: Set<string>,
  windowMinutes = 15,
): ScopeVelocity {
  const windowStart = Date.now() - windowMinutes * 60 * 1000;
  let newlyReported = 0;
  let newlyApproved = 0;
  for (const row of puResults) {
    if (!scopePuIds.has(row.scopeId)) continue;
    const reportedAt = row.submittedAt ?? row.createdAt;
    if (reportedAt.getTime() >= windowStart) newlyReported += 1;
    if (row.approvedAt && row.approvedAt.getTime() >= windowStart) newlyApproved += 1;
  }
  return { newlyReported, newlyApproved, windowMinutes };
}

export function computeDelayedPollingUnits(
  puResults: Array<{ scopeId: string; status: string; submittedAt: Date | null; createdAt: Date }>,
  allPuIds: string[],
  thresholdMinutes = DELAYED_PU_THRESHOLD_MINUTES,
): DelayedPollingUnits {
  const reported = new Set(
    puResults
      .filter(
        (r) =>
          r.status === 'SUBMITTED' ||
          r.status === 'APPROVED' ||
          r.status === 'REJECTED',
      )
      .map((r) => r.scopeId),
  );
  const stuckSubmitted = puResults.filter((r) => {
    if (r.status !== 'SUBMITTED') return false;
    const at = r.submittedAt ?? r.createdAt;
    return Date.now() - at.getTime() > thresholdMinutes * 60 * 1000;
  }).length;
  const missing = allPuIds.filter((id) => !reported.has(id)).length;
  return {
    count: missing + stuckSubmitted,
    thresholdMinutes,
  };
}
