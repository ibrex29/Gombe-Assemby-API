import {
  CollationLevel,
  TriageOutlook,
  TriageRiskLevel,
} from '@electromon/shared';
import {
  HYSTERESIS_MARGIN,
  TriageInputs,
  applyHysteresis,
  computeOutlook,
  scoreTriage,
} from './triage-scoring';

function inputs(overrides: Partial<TriageInputs> = {}): TriageInputs {
  return {
    level: CollationLevel.LGA,
    pollingUnitsTotal: 100,
    pollingUnitsReported: 100,
    clientVotes: 5_000,
    rivalVotes: 5_000,
    totalVotes: 10_000,
    clientPartyCode: 'APC',
    registeredVoters: 20_000,
    accreditedVoters: 10_000,
    incidents: [],
    resultsScored: 0,
    resultsFlagged: 0,
    resultsCheckPhoto: 0,
    minutesSinceLastSignal: null,
    negativeSentimentShare: null,
    sentimentPostCount: 0,
    electionMode: true,
    ...overrides,
  };
}

describe('computeOutlook', () => {
  it('stays UNKNOWN below 10% reporting, however good the margin looks', () => {
    // The core rule: early numbers are not a story.
    const outlook = computeOutlook(
      inputs({
        pollingUnitsReported: 5,
        clientVotes: 9_000,
        rivalVotes: 1_000,
      }),
    );
    expect(outlook).toBe(TriageOutlook.UNKNOWN);
  });

  it('is UNKNOWN when the campaign has no client party', () => {
    expect(computeOutlook(inputs({ clientPartyCode: null }))).toBe(
      TriageOutlook.UNKNOWN,
    );
  });

  it('only leans while reporting is partial, and calls it once confident', () => {
    const partial = inputs({
      pollingUnitsReported: 40,
      clientVotes: 7_000,
      rivalVotes: 3_000,
    });
    expect(computeOutlook(partial)).toBe(TriageOutlook.LEANING_WIN);

    expect(computeOutlook({ ...partial, pollingUnitsReported: 90 })).toBe(
      TriageOutlook.WINNING,
    );
  });

  it('mirrors that for losses', () => {
    const partial = inputs({
      pollingUnitsReported: 40,
      clientVotes: 3_000,
      rivalVotes: 7_000,
    });
    expect(computeOutlook(partial)).toBe(TriageOutlook.LEANING_LOSS);
    expect(computeOutlook({ ...partial, pollingUnitsReported: 90 })).toBe(
      TriageOutlook.LOSING,
    );
  });

  it('calls a narrow race a TOSSUP', () => {
    expect(
      computeOutlook(inputs({ clientVotes: 5_100, rivalVotes: 4_900 })),
    ).toBe(TriageOutlook.TOSSUP);
  });

  it('needs a smaller lead to call it as reporting rises', () => {
    // 6% lead: not enough early, enough once nearly everything is in.
    const early = inputs({
      pollingUnitsReported: 15,
      clientVotes: 5_300,
      rivalVotes: 4_700,
    });
    expect(computeOutlook(early)).toBe(TriageOutlook.TOSSUP);
    expect(computeOutlook({ ...early, pollingUnitsReported: 95 })).toBe(
      TriageOutlook.WINNING,
    );
  });
});

describe('scoreTriage', () => {
  it('scores a quiet, fully-reported, comfortably-won scope as LOW', () => {
    const result = scoreTriage(
      inputs({
        clientVotes: 7_000,
        rivalVotes: 3_000,
        accreditedVoters: 9_000,
      }),
    );
    expect(result.riskLevel).toBe(TriageRiskLevel.LOW);
    expect(result.outlook).toBe(TriageOutlook.WINNING);
  });

  it('does not treat an early deficit as a crisis', () => {
    const early = scoreTriage(
      inputs({
        pollingUnitsReported: 12,
        clientVotes: 3_000,
        rivalVotes: 7_000,
      }),
    );
    const late = scoreTriage(
      inputs({
        pollingUnitsReported: 100,
        clientVotes: 3_000,
        rivalVotes: 7_000,
      }),
    );
    // Same deficit, very different meaning.
    expect(early.componentScores.resultsMargin).toBeLessThan(
      late.componentScores.resultsMargin!,
    );
  });

  describe('turnout', () => {
    it('flags implausibly high turnout as maximum risk', () => {
      const result = scoreTriage(inputs({ accreditedVoters: 19_500 }));
      expect(result.componentScores.turnout).toBe(100);
    });

    it('flags near-zero turnout once enough has reported', () => {
      const result = scoreTriage(
        inputs({ accreditedVoters: 500, pollingUnitsReported: 60 }),
      );
      expect(result.componentScores.turnout).toBe(60);
    });

    it('is silent when there is no register to compare against', () => {
      const result = scoreTriage(inputs({ registeredVoters: 0 }));
      expect(result.componentScores.turnout).toBeUndefined();
    });
  });

  describe('incidents', () => {
    it('decays older incidents', () => {
      const fresh = scoreTriage(
        inputs({
          incidents: [{ severity: 'HIGH', ageHours: 0, urgent: true }],
        }),
      );
      const old = scoreTriage(
        inputs({
          incidents: [{ severity: 'HIGH', ageHours: 48, urgent: true }],
        }),
      );
      expect(old.componentScores.incidentPressure).toBeLessThan(
        fresh.componentScores.incidentPressure!,
      );
    });

    it('never decays a CRITICAL below half — unresolved is unresolved', () => {
      const ancient = scoreTriage(
        inputs({
          level: CollationLevel.POLLING_UNIT,
          incidents: [{ severity: 'CRITICAL', ageHours: 10_000, urgent: true }],
        }),
      );
      // 4 severity * 0.5 floor / cap 6 * 100 = 33.3
      expect(ancient.componentScores.incidentPressure).toBeCloseTo(33.3, 0);
    });

    it('floors risk at HIGH when a CRITICAL incident is open', () => {
      const result = scoreTriage(
        inputs({
          clientVotes: 7_000,
          rivalVotes: 3_000,
          accreditedVoters: 9_000,
          incidents: [{ severity: 'CRITICAL', ageHours: 200, urgent: true }],
        }),
      );
      expect(result.riskLevel).toBe(TriageRiskLevel.HIGH);
      expect(result.drivers[0]).toMatch(/CRITICAL incident/);
    });

    it('floors risk at HIGH on three urgent incidents', () => {
      const result = scoreTriage(
        inputs({
          clientVotes: 7_000,
          rivalVotes: 3_000,
          accreditedVoters: 9_000,
          incidents: Array.from({ length: 3 }, () => ({
            severity: 'HIGH',
            ageHours: 500,
            urgent: true,
          })),
        }),
      );
      expect(result.riskLevel).toBe(TriageRiskLevel.HIGH);
    });

    it('scales by level, so one incident means more in a polling unit than a state', () => {
      const incident = [
        { severity: 'HIGH' as const, ageHours: 0, urgent: true },
      ];
      const pu = scoreTriage(
        inputs({ level: CollationLevel.POLLING_UNIT, incidents: incident }),
      );
      const state = scoreTriage(
        inputs({ level: CollationLevel.STATE, incidents: incident }),
      );
      expect(pu.componentScores.incidentPressure).toBeGreaterThan(
        state.componentScores.incidentPressure!,
      );
    });
  });

  describe('components that must stay silent rather than guess', () => {
    it('omits sentiment entirely when social listening has no data', () => {
      const result = scoreTriage(inputs());
      expect(result.componentScores.sentiment).toBeUndefined();
    });

    it('lets a healthy sentiment signal count in its favour, and a bad one against', () => {
      const base = { clientVotes: 4_000, rivalVotes: 6_000 };
      const absent = scoreTriage(inputs(base));
      const healthy = scoreTriage(
        inputs({
          ...base,
          negativeSentimentShare: 0.3,
          sentimentPostCount: 100,
        }),
      );
      const hostile = scoreTriage(
        inputs({
          ...base,
          negativeSentimentShare: 0.9,
          sentimentPostCount: 100,
        }),
      );

      // A present, healthy signal scores 0 and is included, so it dilutes
      // slightly — absent is not the same as good news.
      expect(healthy.compositeScore).toBeLessThan(absent.compositeScore);
      expect(hostile.compositeScore).toBeGreaterThan(absent.compositeScore);
      expect(hostile.componentScores.sentiment).toBeGreaterThan(0);
    });

    it('ignores a sentiment signal backed by only a handful of posts', () => {
      const loud = scoreTriage(
        inputs({ negativeSentimentShare: 1, sentimentPostCount: 2 }),
      );
      // Volume damping: two angry posts must not move a state's risk.
      expect(loud.componentScores.sentiment).toBeLessThan(10);
    });

    it('omits reporting coverage and staleness outside election mode', () => {
      const result = scoreTriage(
        inputs({
          electionMode: false,
          minutesSinceLastSignal: 600,
          pollingUnitsReported: 10,
        }),
      );
      expect(result.componentScores.reportingCoverage).toBeUndefined();
      expect(result.componentScores.staleness).toBeUndefined();
    });

    it('omits verification flags when nothing has been scored', () => {
      expect(
        scoreTriage(inputs()).componentScores.verificationFlags,
      ).toBeUndefined();
    });
  });

  it('raises risk when results keep failing their arithmetic check', () => {
    const result = scoreTriage(
      inputs({
        resultsScored: 100,
        resultsFlagged: 30,
        clientVotes: 4_500,
        rivalVotes: 5_500,
      }),
    );
    expect(result.componentScores.verificationFlags).toBe(100);
    expect(result.drivers.join(' ')).toMatch(/arithmetic check/);
  });

  it('explains itself with the biggest contributors, worst first', () => {
    const result = scoreTriage(
      inputs({
        clientVotes: 2_000,
        rivalVotes: 8_000,
        incidents: Array.from({ length: 8 }, () => ({
          severity: 'HIGH',
          ageHours: 1,
          urgent: true,
        })),
      }),
    );
    expect(result.drivers.length).toBeGreaterThan(0);
    expect(result.drivers.length).toBeLessThanOrEqual(4);
    expect(result.drivers.join(' ')).toMatch(/unresolved incident/);
  });
});

describe('applyHysteresis', () => {
  it('escalates immediately', () => {
    expect(
      applyHysteresis(80, TriageRiskLevel.CRITICAL, TriageRiskLevel.LOW),
    ).toBe(TriageRiskLevel.CRITICAL);
  });

  it('holds the previous level while a score hovers just under the edge', () => {
    // Without this, a score oscillating around 50 alerts every single sweep.
    expect(
      applyHysteresis(49, TriageRiskLevel.MEDIUM, TriageRiskLevel.HIGH),
    ).toBe(TriageRiskLevel.HIGH);
  });

  it('de-escalates once clearly below the edge', () => {
    expect(
      applyHysteresis(
        50 - HYSTERESIS_MARGIN - 1,
        TriageRiskLevel.MEDIUM,
        TriageRiskLevel.HIGH,
      ),
    ).toBe(TriageRiskLevel.MEDIUM);
  });

  it('does nothing on a first-ever score', () => {
    expect(applyHysteresis(10, TriageRiskLevel.LOW, null)).toBe(
      TriageRiskLevel.LOW,
    );
  });
});

describe('factor breakdown', () => {
  it('contributions sum to the composite score', () => {
    const result = scoreTriage(inputs({ electionMode: true }));
    const summed = result.factors.reduce(
      (total, factor) => total + factor.contribution,
      0,
    );
    // Each contribution is rounded to one decimal, so allow for that drift.
    expect(Math.abs(summed - result.compositeScore)).toBeLessThan(0.6);
  });

  it('effective weights of measured factors sum to 1', () => {
    const result = scoreTriage(inputs({ electionMode: true }));
    const measured = result.factors.filter((factor) => factor.measured);
    const summed = measured.reduce(
      (total, factor) => total + factor.effectiveWeight,
      0,
    );
    expect(Math.abs(summed - 1)).toBeLessThan(0.05);
  });

  it('lists unmeasured factors with a reason rather than hiding them', () => {
    // No social listening configured anywhere yet.
    const result = scoreTriage(
      inputs({ negativeSentimentShare: null, sentimentPostCount: 0 }),
    );
    const sentiment = result.factors.find(
      (factor) => factor.key === 'sentiment',
    );
    expect(sentiment).toBeDefined();
    expect(sentiment?.measured).toBe(false);
    expect(sentiment?.score).toBeNull();
    expect(sentiment?.contribution).toBe(0);
    // Whatever the wording, it must say why there is nothing rather than
    // implying the mood was measured and found calm.
    expect(sentiment?.detail).toMatch(/no social posts/i);
  });

  it('never lets an unmeasured factor score as if it were fine', () => {
    const result = scoreTriage(
      inputs({ negativeSentimentShare: null, sentimentPostCount: 0 }),
    );
    const sentiment = result.factors.find(
      (factor) => factor.key === 'sentiment',
    );
    // A zero score would be indistinguishable from "sentiment is great".
    expect(sentiment?.score).not.toBe(0);
    expect(sentiment?.effectiveWeight).toBe(0);
  });

  it('reports every component, measured or not', () => {
    const result = scoreTriage(inputs({}));
    expect(result.factors).toHaveLength(7);
    expect(new Set(result.factors.map((factor) => factor.key)).size).toBe(7);
  });

  it('orders factors by what actually moved the score', () => {
    const result = scoreTriage(inputs({ electionMode: true }));
    const contributions = result.factors.map((factor) => factor.contribution);
    const sorted = [...contributions].sort((a, b) => b - a);
    expect(contributions).toEqual(sorted);
  });

  it("renormalises so a missing signal raises the others' share", () => {
    const withSocial = scoreTriage(
      inputs({ negativeSentimentShare: 0.5, sentimentPostCount: 100 }),
    );
    const withoutSocial = scoreTriage(
      inputs({ negativeSentimentShare: null, sentimentPostCount: 0 }),
    );
    const share = (result: typeof withSocial) =>
      result.factors.find((factor) => factor.key === 'incidentPressure')
        ?.effectiveWeight ?? 0;
    expect(share(withoutSocial)).toBeGreaterThan(share(withSocial));
  });
});

describe('turnout driver wording', () => {
  it('describes both turnout extremes correctly', () => {
    const stuffed = scoreTriage(
      inputs({ registeredVoters: 10_000, accreditedVoters: 9_800 }),
    ).drivers.join(' ');
    expect(stuffed).toMatch(/higher than is believable/);

    // Near-zero turnout with plenty reported is the suppression case, and must
    // never be described as implausibly high.
    const suppressed = scoreTriage(
      inputs({
        registeredVoters: 10_000,
        accreditedVoters: 400,
        pollingUnitsReported: 80,
      }),
    ).drivers.join(' ');
    expect(suppressed).toMatch(/kept away/);
    expect(suppressed).not.toMatch(/higher than is believable/);
  });
});
