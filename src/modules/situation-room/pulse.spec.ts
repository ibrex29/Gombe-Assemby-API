import {
  ElectionDayPhase,
  IncidentType,
  PulseAtmosphere,
  PulseBvasStatus,
  RivalMobilization,
  RivalTactic,
  SituationStatus,
  WhoLooksAhead,
  isMaterialPulseChange,
  isPulseSilent,
  laterElectionDayPhase,
  mapPhaseToStatus,
  mapStatusToPhase,
  observedLead,
  parseObservedPartyResults,
  pulsePatchFromIncident,
} from '@electromon/shared';

describe('pulse mapping', () => {
  it('maps legacy statuses onto election-day phases', () => {
    expect(mapStatusToPhase(SituationStatus.OPEN)).toBe(ElectionDayPhase.VOTING);
    expect(mapStatusToPhase(SituationStatus.REPORTING)).toBe(ElectionDayPhase.COUNTING);
    expect(mapStatusToPhase(SituationStatus.CLOSED)).toBe(ElectionDayPhase.CLOSED);
    expect(mapPhaseToStatus(ElectionDayPhase.COUNTING)).toBe(SituationStatus.REPORTING);
    expect(mapPhaseToStatus(ElectionDayPhase.CHECKED_IN)).toBe(SituationStatus.OPEN);
  });

  it('treats missing or stale non-closed pulses as silent', () => {
    expect(isPulseSilent({ phase: null, lastPulseAt: null })).toBe(true);
    expect(
      isPulseSilent({
        phase: ElectionDayPhase.VOTING,
        lastPulseAt: new Date('2026-08-27T08:00:00Z'),
        now: new Date('2026-08-27T09:00:00Z'),
      }),
    ).toBe(true);
    expect(
      isPulseSilent({
        phase: ElectionDayPhase.CLOSED,
        lastPulseAt: new Date('2026-08-27T08:00:00Z'),
        now: new Date('2026-08-27T10:00:00Z'),
      }),
    ).toBe(false);
  });

  it('computes observed lead without treating a tie as a win', () => {
    expect(observedLead({ APC: 100, PDP: 80 }, 'APC')).toBe(WhoLooksAhead.US);
    expect(observedLead({ APC: 80, PDP: 100 }, 'APC')).toBe(WhoLooksAhead.RIVAL);
    expect(observedLead({ APC: 90, PDP: 90 }, 'APC')).toBe(WhoLooksAhead.UNCLEAR);
  });

  it('parses observed totals against tracked parties', () => {
    expect(parseObservedPartyResults({ APC: 12, PDP: 4, FAKE: 9 }, ['APC', 'PDP'])).toEqual({
      APC: 12,
      PDP: 4,
    });
    expect(() => parseObservedPartyResults({ APC: -1 }, ['APC'])).toThrow(/Invalid observed total/);
  });

  it('flags material pulse changes', () => {
    const previous = {
      phase: ElectionDayPhase.VOTING,
      atmosphere: PulseAtmosphere.CALM,
      bvasStatus: PulseBvasStatus.WORKING,
      rivalMobilization: RivalMobilization.NONE,
      observedPartyResults: null as Record<string, number> | null,
    };
    expect(isMaterialPulseChange(null, { ...previous, phase: ElectionDayPhase.CHECKED_IN })).toBe(true);
    expect(isMaterialPulseChange(previous, previous)).toBe(false);
    expect(
      isMaterialPulseChange(previous, { ...previous, bvasStatus: PulseBvasStatus.DOWN }),
    ).toBe(true);
    expect(
      isMaterialPulseChange(
        { ...previous, phase: ElectionDayPhase.COUNTING, observedPartyResults: { APC: 10, PDP: 4 } },
        { ...previous, phase: ElectionDayPhase.COUNTING, observedPartyResults: { APC: 4, PDP: 10 } },
        'APC',
      ),
    ).toBe(true);
  });

  it('never lets inferred writes move the phase backwards', () => {
    expect(laterElectionDayPhase(ElectionDayPhase.VOTING, ElectionDayPhase.CHECKED_IN)).toBe(
      ElectionDayPhase.VOTING,
    );
    expect(laterElectionDayPhase(null, ElectionDayPhase.CHECKED_IN)).toBe(ElectionDayPhase.CHECKED_IN);
    expect(laterElectionDayPhase(ElectionDayPhase.VOTING, ElectionDayPhase.COUNTING)).toBe(
      ElectionDayPhase.COUNTING,
    );
  });

  it('maps incidents onto the pulse fields HQ actually watches', () => {
    expect(pulsePatchFromIncident(IncidentType.BVAS_MALFUNCTION)).toEqual({
      bvasStatus: PulseBvasStatus.DOWN,
      isUrgent: true,
    });
    expect(pulsePatchFromIncident(IncidentType.OPPOSITION_DISRUPTION)).toEqual({
      atmosphere: PulseAtmosphere.DISRUPTED,
      rivalMobilization: RivalMobilization.HEAVY,
      rivalTactics: [RivalTactic.DISRUPTION],
      isUrgent: true,
    });
    expect(pulsePatchFromIncident(IncidentType.OTHERS)).toEqual({ heartbeatOnly: true });
  });
});
