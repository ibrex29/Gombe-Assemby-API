import {
  CollationLevel,
  TriageOutlook,
  TriageRiskLevel,
} from '@electromon/shared';

/**
 * Deterministic risk scoring. No model involvement anywhere in this file: the
 * assistant may later *describe* a score, but it never produces one, and the
 * drivers below are generated from the numbers rather than written by an LLM.
 *
 * Pure and dependency-free so the rules can be tested exhaustively without a
 * database.
 */

export const TRIAGE_ENGINE_VERSION = 'triage-v1.3';

/** Raw signals for one scope. Everything is optional-ish: absent data must not
 *  masquerade as good news, and must not invent bad news either. */
export interface TriageInputs {
  level: CollationLevel;
  /** Polling units in this scope, and how many have reported at all. */
  pollingUnitsTotal: number;
  pollingUnitsReported: number;
  /** Our party's votes and the leading rival's, across reported results. */
  clientVotes: number;
  rivalVotes: number;
  totalVotes: number;
  /** Null when the campaign has no client party configured. */
  clientPartyCode: string | null;
  registeredVoters: number;
  accreditedVoters: number;
  /** Unresolved incidents, each with a severity and an age. */
  incidents: Array<{
    severity: string | null;
    ageHours: number;
    urgent: boolean;
  }>;
  /** Results scored by the arithmetic/OCR check. */
  resultsScored: number;
  resultsFlagged: number;
  resultsCheckPhoto: number;
  /** Minutes since the most recent submission/approval/situation signal. */
  minutesSinceLastSignal: number | null;
  /** Share of posts classed negative, and how many posts backed it. */
  negativeSentimentShare: number | null;
  sentimentPostCount: number;
  /** Election day weights incidents and staleness far more heavily. */
  electionMode: boolean;
}

export type TriageComponent =
  | 'resultsMargin'
  | 'reportingCoverage'
  | 'turnout'
  | 'incidentPressure'
  | 'verificationFlags'
  | 'staleness'
  | 'sentiment';

export type ComponentScores = Partial<Record<TriageComponent, number>>;

/**
 * One factor, fully explained.
 *
 * The point of carrying weight, effectiveWeight and contribution separately is
 * that the third is the only one that answers "why is this score what it is",
 * and it is not derivable from the nominal weight alone: components without
 * data are dropped and the rest are renormalised, so a 10% weight becomes a
 * larger share of a scope where half the signals are missing.
 */
export interface TriageFactor {
  key: TriageComponent;
  label: string;
  /** 0-100, higher is worse. Null when the signal was not measurable. */
  score: number | null;
  /** Share of the composite this factor would carry if every signal existed. */
  weight: number;
  /** Share it actually carried, after absent signals were renormalised away. */
  effectiveWeight: number;
  /** Points of the composite contributed. score x effectiveWeight. */
  contribution: number;
  /** Plain reading of the underlying numbers, or why there are none. */
  detail: string;
  measured: boolean;
}

export interface TriageResult {
  outlook: TriageOutlook;
  riskLevel: TriageRiskLevel;
  compositeScore: number;
  componentScores: ComponentScores;
  drivers: string[];
  factors: TriageFactor[];
}

/** Weights sum to 1. Inactive components are renormalised deterministically. */
export const TRIAGE_WEIGHTS: Record<TriageComponent, number> = {
  incidentPressure: 0.3,
  resultsMargin: 0.2,
  verificationFlags: 0.15,
  reportingCoverage: 0.15,
  turnout: 0.1,
  staleness: 0.05,
  sentiment: 0.05,
};

/** Must stay identical to COMPONENT_LABEL in the web app's risk-radar lib. */
export const COMPONENT_LABEL: Record<TriageComponent, string> = {
  incidentPressure: 'Unresolved incidents',
  resultsMargin: 'Vote gap',
  verificationFlags: 'Result sheet errors',
  reportingCoverage: 'How much reported',
  turnout: 'Turnout check',
  staleness: 'Time since last report',
  sentiment: 'Online mood',
};

/**
 * What each factor is actually asking. Shown next to the number so an operator
 * does not have to infer the question from the answer.
 */
export const COMPONENT_QUESTION: Record<TriageComponent, string> = {
  incidentPressure:
    'How much unresolved trouble is reported here, weighted by severity and how recent it is?',
  resultsMargin:
    'Are we behind on the votes counted so far, and is enough counted for that to mean something?',
  verificationFlags:
    'How many submitted result sheets failed their arithmetic or photo check?',
  reportingCoverage: 'How much of this scope has reported at all?',
  turnout:
    'Is turnout inside a believable range, or high enough to suggest stuffing and low enough to suggest suppression?',
  staleness: 'How long since anything was submitted or approved here?',
  sentiment:
    'How negative is the social conversation, and on enough posts to matter?',
};

const SEVERITY_WEIGHT: Record<string, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

/** Incident weight that saturates a scope, by level. */
const INCIDENT_CAP: Record<string, number> = {
  POLLING_UNIT: 6,
  WARD: 12,
  LGA: 30,
  STATE: 80,
  NATIONAL: 300,
};

const RISK_BANDS: Array<{ level: TriageRiskLevel; min: number }> = [
  { level: TriageRiskLevel.CRITICAL, min: 75 },
  { level: TriageRiskLevel.HIGH, min: 50 },
  { level: TriageRiskLevel.MEDIUM, min: 25 },
];

/** Points a score must fall *below* a band edge before it de-escalates. */
export const HYSTERESIS_MARGIN = 8;

const clamp = (value: number, min = 0, max = 100) =>
  Math.min(max, Math.max(min, value));

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Reported share of polling units. This gates almost everything: an early
 * deficit is noise, the same deficit at 80% reporting is the story.
 */
function reportedFraction(inputs: TriageInputs): number {
  if (inputs.pollingUnitsTotal <= 0) return 0;
  return clamp(inputs.pollingUnitsReported / inputs.pollingUnitsTotal, 0, 1);
}

/** Signed margin as a fraction of votes cast. Positive means we are ahead. */
function marginFraction(inputs: TriageInputs): number | null {
  if (!inputs.clientPartyCode) return null;
  if (inputs.totalVotes <= 0) return null;
  return (inputs.clientVotes - inputs.rivalVotes) / inputs.totalVotes;
}

/**
 * The rule from the campaign's own pitch material, encoded: low reporting and
 * trailing means keep counting; high reporting and trailing is a real loss.
 * The lead needed to call it slides from 10% down to 4% as reporting rises.
 */
export function computeOutlook(inputs: TriageInputs): TriageOutlook {
  const r = reportedFraction(inputs);
  const margin = marginFraction(inputs);
  if (margin === null || r < 0.1) return TriageOutlook.UNKNOWN;

  const threshold = 0.1 - 0.06 * clamp(r / 0.7, 0, 1);
  const confident = r >= 0.7;

  if (margin >= threshold) {
    return confident ? TriageOutlook.WINNING : TriageOutlook.LEANING_WIN;
  }
  if (margin <= -threshold) {
    return confident ? TriageOutlook.LOSING : TriageOutlook.LEANING_LOSS;
  }
  return TriageOutlook.TOSSUP;
}

function scoreResultsMargin(inputs: TriageInputs): number | null {
  const margin = marginFraction(inputs);
  if (margin === null) return null;
  const r = reportedFraction(inputs);
  // Deficits beyond 8% score full; leads beyond 8% score zero. Scaled by
  // reporting so an early wobble does not read as a crisis.
  const severity = clamp((0.08 - margin) / 0.16, 0, 1);
  return clamp(100 * severity * (0.4 + 0.6 * r));
}

function scoreReportingCoverage(inputs: TriageInputs): number | null {
  // Only meaningful on election day; otherwise nothing is expected to report.
  if (!inputs.electionMode) return null;
  if (inputs.pollingUnitsTotal <= 0) return null;
  const r = reportedFraction(inputs);
  if (r >= 0.9) return 0;
  return clamp(100 * (1 - r / 0.9));
}

function scoreTurnout(inputs: TriageInputs): number | null {
  if (inputs.registeredVoters <= 0 || inputs.accreditedVoters <= 0) return null;
  const turnout = inputs.accreditedVoters / inputs.registeredVoters;

  // Implausibly high turnout is the ballot-stuffing family of problems.
  if (turnout > 0.95) return 100;
  if (turnout > 0.85) return clamp(40 + ((turnout - 0.85) / 0.1) * 60);
  // Near-zero turnout where plenty has reported suggests suppression.
  if (turnout < 0.1 && reportedFraction(inputs) > 0.3) return 60;
  return 0;
}

function scoreIncidentPressure(inputs: TriageInputs): number | null {
  if (inputs.incidents.length === 0) return 0;

  const halfLife = inputs.electionMode ? 12 : 72;
  let weight = 0;
  for (const incident of inputs.incidents) {
    const severity = incident.severity ?? (incident.urgent ? 'HIGH' : 'LOW');
    const base = SEVERITY_WEIGHT[severity] ?? 1;
    const decay = Math.pow(2, -Math.max(0, incident.ageHours) / halfLife);
    // A CRITICAL incident never decays below half: unresolved is unresolved.
    const floor = severity === 'CRITICAL' ? 0.5 : 0;
    weight += base * Math.max(floor, decay);
  }

  const cap = INCIDENT_CAP[inputs.level] ?? 30;
  return clamp((weight / cap) * 100);
}

function scoreVerificationFlags(inputs: TriageInputs): number | null {
  if (inputs.resultsScored <= 0) return null;
  const flagged = inputs.resultsFlagged + 0.35 * inputs.resultsCheckPhoto;
  const ratio = flagged / inputs.resultsScored;
  // 25% flagged saturates — beyond that it is already an emergency.
  return clamp((ratio / 0.25) * 100);
}

function scoreStaleness(inputs: TriageInputs): number | null {
  if (!inputs.electionMode) return null;
  if (inputs.minutesSinceLastSignal === null) return null;
  const minutes = inputs.minutesSinceLastSignal;
  if (minutes <= 60) return 0;
  if (minutes >= 240) return 100;
  return clamp(((minutes - 60) / 180) * 100);
}

function scoreSentiment(inputs: TriageInputs): number | null {
  // Absent social data is excluded from the weighting entirely, the same rule
  // every other component follows — it must not read as reassurance. Note this
  // means switching social listening on shifts scores slightly even where
  // sentiment is fine, because a present-and-healthy signal legitimately
  // dilutes the average. That is a one-off rollout shift, not drift.
  if (
    inputs.negativeSentimentShare === null ||
    inputs.sentimentPostCount <= 0
  ) {
    return null;
  }
  const excess = clamp((inputs.negativeSentimentShare - 0.3) / 0.4, 0, 1);
  // A handful of posts should not move a state's risk.
  const volume = clamp(inputs.sentimentPostCount / 50, 0, 1);
  return clamp(100 * excess * volume);
}

const SCORERS: Record<
  TriageComponent,
  (inputs: TriageInputs) => number | null
> = {
  resultsMargin: scoreResultsMargin,
  reportingCoverage: scoreReportingCoverage,
  turnout: scoreTurnout,
  incidentPressure: scoreIncidentPressure,
  verificationFlags: scoreVerificationFlags,
  staleness: scoreStaleness,
  sentiment: scoreSentiment,
};

const DRIVER_TEXT: Record<TriageComponent, (inputs: TriageInputs) => string> = {
  resultsMargin: (inputs) => {
    const margin = marginFraction(inputs) ?? 0;
    const pct = Math.abs(round1(margin * 100));
    const direction = margin < 0 ? 'behind by' : 'ahead by only';
    return `${direction} ${pct}% of votes counted so far`;
  },
  reportingCoverage: (inputs) =>
    `only ${round1(reportedFraction(inputs) * 100)}% of polling units have reported`,
  turnout: (inputs) => {
    const turnout =
      inputs.accreditedVoters / Math.max(1, inputs.registeredVoters);
    // The same factor fires at both extremes, so the sentence has to follow the
    // direction: implausibly high is stuffing, near-zero is people kept away.
    const reading =
      turnout < 0.5
        ? 'so low it suggests voters were kept away'
        : 'higher than is believable';
    return `turnout of ${round1(turnout * 100)}% is ${reading}`;
  },
  incidentPressure: (inputs) => {
    const urgent = inputs.incidents.filter(
      (incident) => incident.urgent,
    ).length;
    return `${inputs.incidents.length} unresolved incident${inputs.incidents.length === 1 ? '' : 's'}${urgent > 0 ? `, ${urgent} urgent` : ''}`;
  },
  verificationFlags: (inputs) =>
    `${inputs.resultsFlagged} of ${inputs.resultsScored} results failed their arithmetic check`,
  staleness: (inputs) =>
    `no submissions for ${Math.round(inputs.minutesSinceLastSignal ?? 0)} minutes`,
  sentiment: (inputs) =>
    `${round1((inputs.negativeSentimentShare ?? 0) * 100)}% of social posts are negative`,
};

/** Why a component scored nothing. Absent is never the same as fine. */
function absenceReason(
  component: TriageComponent,
  inputs: TriageInputs,
): string {
  switch (component) {
    case 'resultsMargin':
      if (!inputs.clientPartyCode)
        return 'No party configured for this campaign';
      return 'No votes counted here yet';
    case 'reportingCoverage':
      if (!inputs.electionMode) return 'Only measured on election day';
      return 'No polling units registered here';
    case 'turnout':
      return 'No accreditation figures reported yet';
    case 'verificationFlags':
      return 'No result sheets have been checked yet';
    case 'staleness':
      if (!inputs.electionMode) return 'Only measured on election day';
      return 'Nothing has been submitted here yet';
    case 'sentiment':
      // True whether the integration is off or simply has no posts for this
      // place. Saying "not connected" once it is connected would be wrong.
      return 'No social posts for this place yet';
    default:
      return 'Not measured';
  }
}

/**
 * Every factor, measured or not, with what it contributed.
 *
 * Unmeasured factors are listed rather than hidden: "we have no social data"
 * and "social data looks fine" are very different things to a war room, and a
 * breakdown that silently omits the first reads as the second.
 */
export function buildFactors(
  inputs: TriageInputs,
  componentScores: ComponentScores,
  activeWeight: number,
): TriageFactor[] {
  return (Object.keys(SCORERS) as TriageComponent[])
    .map((key) => {
      const score = componentScores[key] ?? null;
      const weight = TRIAGE_WEIGHTS[key];
      const measured = score !== null;
      const effectiveWeight =
        measured && activeWeight > 0 ? weight / activeWeight : 0;
      return {
        key,
        label: COMPONENT_LABEL[key],
        score,
        weight,
        effectiveWeight: round1(effectiveWeight * 100) / 100,
        contribution: measured ? round1(score * effectiveWeight) : 0,
        detail: measured
          ? DRIVER_TEXT[key](inputs)
          : absenceReason(key, inputs),
        measured,
      };
    })
    .sort((a, b) => b.contribution - a.contribution);
}

function bandFor(score: number): TriageRiskLevel {
  for (const band of RISK_BANDS) {
    if (score >= band.min) return band.level;
  }
  return TriageRiskLevel.LOW;
}

/**
 * Applies hysteresis so a score hovering on a band edge does not flap between
 * risk levels, alerting somebody every sweep.
 */
export function applyHysteresis(
  score: number,
  raw: TriageRiskLevel,
  previous: TriageRiskLevel | null,
): TriageRiskLevel {
  if (!previous) return raw;
  const order = [
    TriageRiskLevel.LOW,
    TriageRiskLevel.MEDIUM,
    TriageRiskLevel.HIGH,
    TriageRiskLevel.CRITICAL,
  ];
  if (order.indexOf(raw) >= order.indexOf(previous)) return raw;

  // De-escalating: only allow it once clearly below the previous band's edge.
  const previousEdge =
    RISK_BANDS.find((band) => band.level === previous)?.min ?? 0;
  return score <= previousEdge - HYSTERESIS_MARGIN ? raw : previous;
}

export function scoreTriage(
  inputs: TriageInputs,
  previousRiskLevel: TriageRiskLevel | null = null,
): TriageResult {
  const componentScores: ComponentScores = {};
  let weighted = 0;
  let activeWeight = 0;

  for (const component of Object.keys(SCORERS) as TriageComponent[]) {
    const value = SCORERS[component](inputs);
    if (value === null) continue;
    componentScores[component] = round1(value);
    weighted += value * TRIAGE_WEIGHTS[component];
    activeWeight += TRIAGE_WEIGHTS[component];
  }

  // Renormalise over the components that actually had data.
  const composite = activeWeight > 0 ? round1(weighted / activeWeight) : 0;

  let risk = bandFor(composite);

  // Floors: some facts are serious regardless of what the average says.
  const criticalIncidents = inputs.incidents.filter(
    (incident) => incident.severity === 'CRITICAL',
  ).length;
  const urgentIncidents = inputs.incidents.filter(
    (incident) => incident.urgent,
  ).length;
  const floored =
    criticalIncidents > 0 || urgentIncidents >= 3 ? TriageRiskLevel.HIGH : null;
  if (floored && bandFor(composite) === TriageRiskLevel.LOW) risk = floored;
  if (floored && risk === TriageRiskLevel.MEDIUM) risk = floored;

  risk = applyHysteresis(composite, risk, previousRiskLevel);

  // Drivers are the top contributors, described from the numbers.
  const drivers = (Object.keys(componentScores) as TriageComponent[])
    .filter((component) => (componentScores[component] ?? 0) >= 20)
    .sort((a, b) => (componentScores[b] ?? 0) - (componentScores[a] ?? 0))
    .slice(0, 3)
    .map((component) => DRIVER_TEXT[component](inputs));

  if (criticalIncidents > 0) {
    drivers.unshift(
      `${criticalIncidents} CRITICAL incident${criticalIncidents === 1 ? '' : 's'} still unresolved`,
    );
  }

  return {
    outlook: computeOutlook(inputs),
    riskLevel: risk,
    compositeScore: composite,
    componentScores,
    drivers: drivers.slice(0, 4),
    factors: buildFactors(inputs, componentScores, activeWeight),
  };
}
