import {
  catalogRowsForWard,
  findIrevPuByCode,
  inecCodeCompact,
  irevDocumentHash,
  irevDocumentUrl,
  isOcrEligibleDocumentUrl,
  isStaleIrevDocumentUrl,
  matchIrevPu,
  normalizeGeoName,
} from './irev-mapper';
import { inecStateIdForCode } from './irev-inec-state-codes';
import { compareAgentToIrev, isIrevDocumentSubstitution, isIrevQaMismatch } from './irev-verification';

describe('irev-mapper', () => {
  it('normalizes geo names for matching', () => {
    expect(normalizeGeoName("  Shiyar  Galadima ")).toBe('SHIYAR GALADIMA');
  });

  it('matches delimitation codes across slash and dash formats', () => {
    const pu = {
      _id: 'x',
      pu_code: '36/12/09/058',
      pu_code_string: '361209058',
    };
    expect(matchIrevPu('36-12-09-058', pu)).toBe(true);
    expect(inecCodeCompact('36-12-09-058')).toBe('361209058');
    expect(findIrevPuByCode([pu], '36/12/09/058')?._id).toBe('x');
  });

  it('catalogs every matching ward PU with its official document URL', () => {
    const rows = catalogRowsForWard(
      [
        { id: 'local-1', code: '36-12-09-001' },
        { id: 'local-2', code: '36-12-09-002' },
        { id: 'local-3', code: '36-12-09-003' },
      ],
      [
        {
          _id: 'irev-1',
          pu_code: '36/12/09/001',
          document: { url: 'https://irev.example/a.jpg', updated_at: '2026-09-01T10:00:00.000Z' },
        },
        {
          _id: 'irev-2',
          pu_code: '36/12/09/002',
          document: { url: 'https://irev.example/b.jpg' },
        },
        { _id: 'irev-unmatched', pu_code: '36/12/09/999' },
      ],
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      pollingUnitId: 'local-1',
      irevPuId: 'irev-1',
      documentUrl: 'https://irev.example/a.jpg',
      documentHash: irevDocumentHash('https://irev.example/a.jpg'),
    });
    expect(rows[1]).toMatchObject({
      pollingUnitId: 'local-2',
      documentUrl: 'https://irev.example/b.jpg',
    });
    expect(rows.find((row) => row.pollingUnitId === 'local-3')).toBeUndefined();
  });

  it('prefers live CDN document_url over dead legacy hosts', () => {
    const url = irevDocumentUrl({
      _id: 'irev-1',
      document: {
        url: 'https://docs.inecelectionresults.net/elections_prod/2763/43147.pdf',
        document_url:
          'https://irev-results.lon1.digitaloceanspaces.com/2763/elections_prod/2763/43147.pdf',
      },
    });
    expect(url).toBe(
      'https://irev-results.lon1.digitaloceanspaces.com/2763/elections_prod/2763/43147.pdf',
    );
    expect(isStaleIrevDocumentUrl(url)).toBe(false);
    expect(isOcrEligibleDocumentUrl(url)).toBe(true);
  });
});

describe('irev-inec-state-codes', () => {
  it('maps Jigawa and FCT to live IReV API state ids', () => {
    expect(inecStateIdForCode('JI')).toBe(18);
    expect(inecStateIdForCode('FC')).toBe(15);
    expect(inecStateIdForCode('GO')).toBe(16);
  });
});

describe('irev-verification', () => {
  it('flags party vote mismatch', () => {
    const verification = compareAgentToIrev({
      agent: { partyResults: { APC: 120, PDP: 80 }, votesCast: 200 },
      irevExtract: {
        fields: { votesCast: 200 },
        partyResults: { APC: 119, PDP: 80 },
        confidence: 0.9,
        unreadable: false,
      },
      partyCodes: ['APC', 'PDP'],
      documentUrl: 'https://example.com/scan.jpg',
    });
    expect(verification.status).toBe('MISMATCH');
    expect(verification.recommendation).toBe('INVESTIGATE');
    expect(verification.diffs.some((diff) => diff.field === 'party:APC')).toBe(true);
    expect(verification.ocrConfidence).toBe(0.9);
    expect(verification.severity).toBe('MISMATCH_IMMATERIAL');
  });

  it('treats agent zero and missing IReV party as aligned', () => {
    const verification = compareAgentToIrev({
      agent: {
        partyResults: { APC: 179, NNPP: 73, PDP: 10, AAC: 0, AA: 0 },
        votesCast: 262,
      },
      irevExtract: {
        fields: { votesCast: 262 },
        partyResults: { APC: 179, NNPP: 73, PDP: 10 },
        confidence: 0.9,
        unreadable: false,
      },
      partyCodes: ['APC', 'NNPP', 'PDP', 'AAC', 'AA'],
      documentUrl: 'https://example.com/scan.jpg',
    });
    expect(verification.status).toBe('MATCH');
    expect(verification.diffs).toHaveLength(0);
  });

  it('returns WAIT_IREV when official scan is missing', () => {
    const verification = compareAgentToIrev({
      agent: { partyResults: { APC: 10 } },
      irevExtract: null,
      partyCodes: ['APC'],
      documentUrl: null,
      missingOnIrev: true,
    });
    expect(verification.status).toBe('IREV_MISSING');
    expect(verification.recommendation).toBe('WAIT_IREV');
  });

  it('flags accredited and used-ballot mismatches, not only valid votes', () => {
    const verification = compareAgentToIrev({
      agent: {
        partyResults: { APC: 74 },
        votesCast: 172,
        accreditedVoters: 181,
        usedBallotPapers: 181,
      },
      irevExtract: {
        fields: { votesCast: 172, accreditedVoters: 200, usedBallotPapers: 190 },
        partyResults: { APC: 74 },
        confidence: 1,
        unreadable: false,
      },
      partyCodes: ['APC'],
      documentUrl: 'https://example.com/scan.jpg',
    });
    expect(verification.status).toBe('MISMATCH');
    expect(verification.diffs.map((diff) => diff.field)).toEqual(
      expect.arrayContaining(['accreditedVoters', 'usedBallotPapers']),
    );
  });

  it('marks a hash change as substitution', () => {
    expect(isIrevDocumentSubstitution('aaa', 'bbb')).toBe(true);
    expect(isIrevDocumentSubstitution('aaa', 'aaa')).toBe(false);
    expect(isIrevDocumentSubstitution(null, 'bbb')).toBe(false);
  });

  it('sets REPLACED when the official scan changes, even if the agent now matches', () => {
    const verification = compareAgentToIrev({
      agent: { partyResults: { APC: 40 }, votesCast: 140 },
      irevExtract: {
        fields: { votesCast: 140 },
        partyResults: { APC: 40 },
        confidence: 1,
        unreadable: false,
      },
      previousIrevExtract: {
        fields: { votesCast: 172 },
        partyResults: { APC: 74 },
        confidence: 1,
        unreadable: false,
      },
      partyCodes: ['APC'],
      documentUrl: 'https://example.com/new.jpg',
      previousDocumentUrl: 'https://example.com/old.jpg',
      replacedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(verification.status).toBe('REPLACED');
    expect(verification.recommendation).toBe('INVESTIGATE');
    expect(verification.diffs).toHaveLength(0);
    expect(verification.ocrConfidence).toBe(1);
    expect(verification.severity).toBe('REPLACED');
    expect(verification.substitutionDiffs?.some((diff) => diff.field === 'party:APC')).toBe(true);
    expect(verification.substitutionDiffs?.find((diff) => diff.field === 'party:APC')).toMatchObject({
      agent: 74,
      irev: 40,
    });
    expect(verification.previousIrevDocumentUrl).toBe('https://example.com/old.jpg');
  });
});

describe('isIrevQaMismatch', () => {
  it('matches IReV QA mismatch rows (mismatch, investigate, replaced)', () => {
    expect(isIrevQaMismatch({ status: 'MISMATCH', recommendation: 'INVESTIGATE' })).toBe(true);
    expect(isIrevQaMismatch({ status: 'REPLACED', recommendation: 'ALIGNED' })).toBe(true);
    expect(isIrevQaMismatch({ status: 'MATCH', recommendation: 'INVESTIGATE' })).toBe(true);
    expect(isIrevQaMismatch({ status: 'PENDING', recommendation: 'WAIT_IREV' })).toBe(false);
    expect(isIrevQaMismatch({ status: 'MATCH', recommendation: 'ALIGNED' })).toBe(false);
    expect(isIrevQaMismatch(null)).toBe(false);
  });
});
