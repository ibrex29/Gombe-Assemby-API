import {
  attachAttention,
  clusterAttentionRows,
  explainIrevAttention,
  formatSummaryDiffHeadline,
  irevAttentionSortRank,
  severityFor,
  summaryFieldDiffLines,
  summarizeVotesAtRisk,
} from './irev-attention';
import { compareAgentToIrev, irevVerificationSortRank } from './irev-verification';

describe('irev-attention', () => {
  it('ranks replaced material mismatches ahead of low-confidence OCR noise', () => {
    expect(severityFor('REPLACED', true, 0.9)).toBe('REPLACED_MATERIAL');
    expect(severityFor('MISMATCH', true, 0.9)).toBe('MISMATCH_HIGH_CONF');
    expect(severityFor('MISMATCH', true, 0.4)).toBe('MISMATCH_LOW_CONF');
    expect(severityFor('MISMATCH', false, 0.9)).toBe('MISMATCH_IMMATERIAL');
    expect(irevAttentionSortRank({ status: 'REPLACED', severity: 'REPLACED_MATERIAL' })).toBeLessThan(
      irevAttentionSortRank({ status: 'MISMATCH', severity: 'MISMATCH_HIGH_CONF' }),
    );
    expect(irevAttentionSortRank({ status: 'MISMATCH', severity: 'MISMATCH_HIGH_CONF' })).toBeLessThan(
      irevAttentionSortRank({ status: 'MISMATCH', severity: 'MISMATCH_LOW_CONF' }),
    );
  });

  it('treats a 2-vote accredited mismatch as immaterial when the client party matches', () => {
    const verification = compareAgentToIrev({
      agent: { partyResults: { APC: 74 }, votesCast: 172, accreditedVoters: 181 },
      irevExtract: {
        fields: { votesCast: 172, accreditedVoters: 183 },
        partyResults: { APC: 74 },
        confidence: 0.95,
        unreadable: false,
      },
      partyCodes: ['APC'],
      documentUrl: 'https://example.com/scan.jpg',
      clientPartyCode: 'APC',
    });
    expect(verification.status).toBe('MISMATCH');
    expect(verification.material).toBe(false);
    expect(verification.severity).toBe('MISMATCH_IMMATERIAL');
    expect(verification.clientPartyDelta).toBe(0);
    expect(verification.ocrConfidence).toBe(0.95);
  });

  it('marks a large client-party gap with high OCR confidence as material', () => {
    const verification = compareAgentToIrev({
      agent: { partyResults: { APC: 421 }, votesCast: 468 },
      irevExtract: {
        fields: { votesCast: 468 },
        partyResults: { APC: 468 },
        confidence: 0.96,
        unreadable: false,
      },
      partyCodes: ['APC'],
      documentUrl: 'https://example.com/scan.jpg',
      clientPartyCode: 'APC',
    });
    expect(verification.status).toBe('MISMATCH');
    expect(verification.material).toBe(true);
    expect(verification.severity).toBe('MISMATCH_HIGH_CONF');
    expect(verification.clientPartyDelta).toBe(-47);
    expect(irevVerificationSortRank(verification)).toBeLessThan(
      irevVerificationSortRank({ ...verification, severity: 'MISMATCH_LOW_CONF' }),
    );
  });

  it('surfaces summary field diffs when the client party matches', () => {
    const lines = summaryFieldDiffLines(
      [
        { field: 'accreditedVoters', label: 'Accredited voters', agent: 288, irev: 786 },
        { field: 'ballotPapersIssued', label: 'Ballot papers issued', agent: 293, irev: 793 },
      ],
      0,
    );
    expect(lines).toHaveLength(2);
    expect(formatSummaryDiffHeadline(lines)).toContain('Accredited voters: agent 288, official 786');

    const text = explainIrevAttention({
      status: 'MISMATCH',
      partyCode: 'PDP',
      agent: 173,
      irev: 173,
      delta: 0,
      ocrConfidence: 0.85,
      summaryDiffs: [
        { field: 'accreditedVoters', label: 'Accredited voters', agent: 288, irev: 786 },
        { field: 'ballotPapersIssued', label: 'Ballot papers issued', agent: 293, irev: 793 },
      ],
    });
    expect(text).toContain('The two figures match');
    expect(text).toContain('Other fields differ on the official scan');
    expect(text).toContain('Accredited voters: agent 288, official 786');
  });

  it('explains a hold sheet without implying fraud', () => {
    const text = explainIrevAttention({
      status: 'MISMATCH',
      partyCode: 'APC',
      agent: 421,
      irev: 468,
      delta: -47,
      ocrConfidence: 0.96,
      submittedAt: '2026-09-02T10:00:00.000Z',
      publishedAt: '2026-09-02T10:11:00.000Z',
    });
    expect(text).toContain('Agent recorded 421 APC votes');
    expect(text).toContain('Official scan shows 468');
    expect(text).toContain('Official scan shows 47 more than the agent');
    expect(text).toContain('OCR confidence: 96%');
    expect(text).toContain('11 minutes after the agent submission');
    expect(text.toLowerCase()).not.toContain('fraud');
  });

  it('sums only material client-party deltas as votes at risk', () => {
    const summary = summarizeVotesAtRisk('APC', [
      {
        resultId: 'a',
        pollingUnitId: '1',
        pollingUnitCode: '01-01-01-001',
        pollingUnitName: 'PU 1',
        lgaName: 'LGA',
        stateName: 'State',
        agent: 120,
        irev: 80,
        delta: 40,
        replaced: false,
      },
      {
        resultId: 'b',
        pollingUnitId: '2',
        pollingUnitCode: '01-01-01-002',
        pollingUnitName: 'PU 2',
        lgaName: 'LGA',
        stateName: 'State',
        agent: 10,
        irev: 12,
        delta: -2,
        replaced: false,
      },
      {
        resultId: 'c',
        pollingUnitId: '3',
        pollingUnitCode: '01-01-01-003',
        pollingUnitName: 'PU 3',
        lgaName: 'LGA',
        stateName: 'State',
        agent: 50,
        irev: 70,
        delta: -20,
        replaced: true,
      },
    ]);
    expect(summary.votesAtRisk).toBe(40);
    expect(summary.votesAgainst).toBe(20);
    expect(summary.replacedPus).toBe(1);
    expect(summary.agentHigherPus).toBe(1);
    expect(summary.topPus[0]?.replaced).toBe(true);
  });

  it('clusters mismatched PUs by ward', () => {
    const clusters = clusterAttentionRows([
      {
        wardId: 'w1',
        wardName: 'Ward X',
        lgaName: 'LGA A',
        stateName: 'State',
        mismatch: true,
        replaced: false,
        votesAtRisk: 400,
      },
      {
        wardId: 'w1',
        wardName: 'Ward X',
        lgaName: 'LGA A',
        stateName: 'State',
        mismatch: true,
        replaced: true,
        votesAtRisk: 440,
      },
      {
        wardId: 'w2',
        wardName: 'Ward Y',
        lgaName: 'LGA A',
        stateName: 'State',
        mismatch: true,
        replaced: false,
        votesAtRisk: 10,
      },
    ]);
    expect(clusters[0]?.wardName).toBe('Ward X');
    expect(clusters[0]?.mismatchPus).toBe(2);
    expect(clusters[0]?.replacedPus).toBe(1);
    expect(clusters[0]?.votesAtRisk).toBe(840);
    expect(clusters[0]?.headline).toContain('Ward X');
  });

  it('backfills severity on stored JSON that predates attention fields', () => {
    const attached = attachAttention(
      {
        status: 'MISMATCH' as const,
        diffs: [{ field: 'party:APC', agent: 100, irev: 80 }],
      },
      { clientPartyCode: 'APC' },
    );
    expect(attached.clientPartyDelta).toBe(20);
    expect(attached.material).toBe(true);
    expect(attached.severity).toBe('MISMATCH_LOW_CONF');
  });
});
