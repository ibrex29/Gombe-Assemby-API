import {
  arithmeticVerification,
  countPuVerifications,
  parseOcrVerification,
  partyVotesSum,
  resolveOcrVerification,
} from './ocr-verification';

describe('ocr-verification arithmetic', () => {
  const validSheet = {
    registeredVoters: 289,
    accreditedVoters: 210,
    ballotPapersIssued: 289,
    unusedBallotPapers: 79,
    spoiledBallotPapers: 0,
    invalidVotes: 3,
    votesCast: 207,
    usedBallotPapers: 210,
    partyResults: { PDP: 159, APC: 40, ADC: 8 },
    ec8aPhotoUrls: ['/uploads/ec8a.jpg'],
  };

  it('sums party results', () => {
    expect(partyVotesSum({ PDP: 10, APC: 5 })).toBe(15);
    expect(partyVotesSum(null)).toBeNull();
  });

  it('recommends APPROVE when EC8A identities hold', () => {
    const result = arithmeticVerification(validSheet);
    expect(result.status).toBe('MATCH');
    expect(result.recommendation).toBe('APPROVE');
    expect(result.engine).toBe('ARITHMETIC');
    expect(result.diffs).toHaveLength(0);
    expect(result.suggestedRejectReason).toBeNull();
  });

  it('flags party sum vs valid votes', () => {
    const result = arithmeticVerification({
      ...validSheet,
      votesCast: 200,
    });
    expect(result.status).toBe('MISMATCH');
    expect(result.recommendation).toBe('RETURN');
    expect(result.arithmeticFlags).toContain('PARTY_SUM_NE_VALID');
    expect(result.suggestedRejectReason).toMatch(/Party scores total 207/);
  });

  it('flags accredited above register', () => {
    const result = arithmeticVerification({
      ...validSheet,
      accreditedVoters: 300,
      usedBallotPapers: 300,
      unusedBallotPapers: 0,
      ballotPapersIssued: 300,
      votesCast: 297,
      invalidVotes: 3,
      partyResults: { PDP: 297 },
    });
    expect(result.arithmeticFlags).toContain('ACCREDITED_GT_REGISTERED');
  });

  it('flags used ballots identity', () => {
    const result = arithmeticVerification({
      ...validSheet,
      usedBallotPapers: 199,
    });
    expect(result.arithmeticFlags).toContain('USED_NE_SPOILED_REJECTED_VALID');
    expect(result.arithmeticFlags).toContain('ISSUED_NE_USED_UNUSED');
    expect(result.arithmeticFlags).toContain('ACCREDITED_NE_USED');
  });

  it('returns CHECK_PHOTO when figures are missing', () => {
    const result = arithmeticVerification({ ec8aPhotoUrls: [] });
    expect(result.status).toBe('PENDING');
    expect(result.recommendation).toBe('CHECK_PHOTO');
  });

  it('parses stored JSON and falls back to arithmetic', () => {
    expect(parseOcrVerification({ status: 'MATCH', recommendation: 'APPROVE' })?.recommendation).toBe(
      'APPROVE',
    );
    expect(parseOcrVerification({ nope: true })).toBeNull();

    const stored = resolveOcrVerification({
      ...validSheet,
      votesCast: 1,
      ocrVerification: {
        status: 'MATCH',
        recommendation: 'APPROVE',
        engine: 'ARITHMETIC',
        diffs: [],
        arithmeticFlags: [],
      },
    });
    expect(stored?.recommendation).toBe('APPROVE');

    const computed = resolveOcrVerification({ ...validSheet, votesCast: 1 });
    expect(computed?.recommendation).toBe('RETURN');
  });

  it('counts PU recommendations for LGA rollup', () => {
    const counts = countPuVerifications([
      validSheet,
      { ...validSheet, votesCast: 1 },
      {},
    ]);
    expect(counts.verifyMatched).toBe(1);
    expect(counts.verifyFlagged).toBe(1);
    expect(counts.verifyPending).toBe(1);
  });
});

describe('ocrVerificationWrite awaiting OCR', () => {
  it('marks a matching sheet CHECK_PHOTO until Vision finishes', async () => {
    const { ocrVerificationWrite } = await import('./ocr-verification');
    const written = ocrVerificationWrite(
      {
        registeredVoters: 289,
        accreditedVoters: 210,
        ballotPapersIssued: 289,
        unusedBallotPapers: 79,
        spoiledBallotPapers: 0,
        invalidVotes: 3,
        votesCast: 207,
        usedBallotPapers: 210,
        partyResults: { PDP: 159, APC: 40, ADC: 8 },
        ec8aPhotoUrls: ['/uploads/ec8a.jpg'],
      },
      { awaitingOcr: true },
    );
    const stored = written.ocrVerification as { recommendation: string; arithmeticFlags: string[] };
    expect(stored.recommendation).toBe('CHECK_PHOTO');
    expect(stored.arithmeticFlags).toContain('OCR_PENDING');
  });
});
