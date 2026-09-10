import {
  computeOperationalStatus,
  INSUFFICIENT_DATA_THRESHOLD,
  selectMapParties,
} from './collation-map-intelligence';

describe('selectMapParties', () => {
  const approved = { APC: 120, PDP: 80 };
  const submitted = { APC: 40, PDP: 90 };

  it('uses approved totals when any approved votes exist', () => {
    expect(selectMapParties(approved, submitted)).toEqual({
      parties: approved,
      resultStatus: 'APPROVED',
      pendingValidation: false,
    });
  });

  it('falls back to submitted totals when nothing is approved yet', () => {
    expect(selectMapParties({ APC: 0, PDP: 0 }, submitted)).toEqual({
      parties: submitted,
      resultStatus: 'SUBMITTED',
      pendingValidation: true,
    });
  });

  it('falls back to returned totals when nothing is approved and status is REJECTED', () => {
    const returned = { APC: 10, PDP: 20 };
    expect(selectMapParties({ APC: 0 }, returned, 'REJECTED')).toEqual({
      parties: returned,
      resultStatus: 'REJECTED',
      pendingValidation: true,
    });
  });

  it('returns NOT_STARTED when both approved and submitted are empty', () => {
    expect(selectMapParties({ APC: 0 }, { PDP: 0 })).toEqual({
      parties: { APC: 0 },
      resultStatus: 'NOT_STARTED',
      pendingValidation: false,
    });
  });

  it('does not treat rejected-only (empty) rows as pending validation', () => {
    expect(selectMapParties({}, {})).toEqual({
      parties: {},
      resultStatus: 'NOT_STARTED',
      pendingValidation: false,
    });
  });
});

describe('computeOperationalStatus', () => {
  it('returns LOSING when reporting is low but the client already trails', () => {
    const status = computeOperationalStatus({
      outcome: 'LOSS',
      margin: -681,
      totalVotes: 1523,
      percentSubmitted: 22,
      incidentUrgentCount: 0,
      incidentCount: 0,
      maxSeverity: null,
      approval: {
        pollingUnits: {
          total: 109,
          submitted: 24,
          wardVerified: 20,
          lgaApproved: 10,
          stateApproved: 5,
          rejected: 0,
          notStarted: 85,
        },
      },
    });
    expect(status).toBe('LOSING');
    expect(status).not.toBe('INSUFFICIENT_DATA');
  });

  it('returns INSUFFICIENT_DATA when there are no votes yet', () => {
    const status = computeOperationalStatus({
      outcome: 'PENDING',
      margin: 0,
      totalVotes: 0,
      percentSubmitted: 0,
      incidentUrgentCount: 0,
      incidentCount: 0,
      maxSeverity: null,
    });
    expect(status).toBe('INSUFFICIENT_DATA');
  });

  it('returns AWAITING_APPROVAL when many PUs are submitted but not ward-verified', () => {
    const status = computeOperationalStatus({
      outcome: 'WIN',
      margin: 2000,
      totalVotes: 10000,
      percentSubmitted: 80,
      incidentUrgentCount: 0,
      incidentCount: 0,
      maxSeverity: null,
      approval: {
        pollingUnits: {
          total: 100,
          submitted: 80,
          wardVerified: 20,
          lgaApproved: 20,
          stateApproved: 20,
          rejected: 0,
          notStarted: 20,
        },
      },
    });
    expect(status).toBe('AWAITING_APPROVAL');
  });

  it('returns WINNING when reporting is low but client leads (e.g. state rollup)', () => {
    const status = computeOperationalStatus({
      outcome: 'WIN',
      margin: 16884,
      totalVotes: 91728,
      percentSubmitted: 0,
      incidentUrgentCount: 0,
      incidentCount: 0,
      maxSeverity: null,
    });
    expect(status).toBe('WINNING');
    expect(status).not.toBe('INSUFFICIENT_DATA');
  });

  it('returns LOSING when reporting meets threshold and client trails', () => {
    const status = computeOperationalStatus({
      outcome: 'LOSS',
      margin: -2000,
      totalVotes: 15230,
      percentSubmitted: INSUFFICIENT_DATA_THRESHOLD,
      incidentUrgentCount: 0,
      incidentCount: 0,
      maxSeverity: null,
    });
    expect(status).toBe('LOSING');
  });

  it('still flags urgent incidents as INCIDENT_FLAGGED for non-Results consumers', () => {
    const status = computeOperationalStatus({
      outcome: 'WIN',
      margin: 2000,
      totalVotes: 10000,
      percentSubmitted: 80,
      incidentUrgentCount: 2,
      incidentCount: 2,
      maxSeverity: 'CRITICAL',
    });
    expect(status).toBe('INCIDENT_FLAGGED');
  });
});
