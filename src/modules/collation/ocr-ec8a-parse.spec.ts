import { readFileSync } from 'fs';
import { join } from 'path';
import { arithmeticVerification } from './ocr-verification';
import {
  MIN_AUTO_FILL_CONFIDENCE,
  mergeVisionWithArithmetic,
  parseEc8aOcr,
  parseEc8aOcrText,
  parseNumberWords,
} from './ocr-ec8a-parse';

const osunVisionText = readFileSync(join(__dirname, 'ocr-ec8a-osun.fixture.txt'), 'utf8');
const ayedadeVisionText = readFileSync(join(__dirname, 'ocr-ec8a-ayedade.fixture.txt'), 'utf8');
const ayedadeTokens = JSON.parse(
  readFileSync(join(__dirname, 'ocr-ec8a-ayedade.tokens.json'), 'utf8'),
) as Array<{ text: string; x: number; y: number; w: number; h: number }>;

describe('EC8A Vision text parse', () => {
  const sample = `
    FORM EC8A STATEMENT OF RESULT
    Number of Voters on the Register 289
    Number of Accredited Voters 210
    Ballot Papers Issued to the Polling Unit 289
    Unused Ballot Papers 79
    Spoiled Ballot Papers 0
    Rejected Ballots 3
    Total Valid Votes 207
    Used Ballot Papers 210
    PDP 159  APC 40  ADC 8
  `;

  it('extracts labeled EC8A totals and party scores', () => {
    const extracted = parseEc8aOcrText(sample, ['PDP', 'APC', 'ADC']);
    expect(extracted.unreadable).toBe(false);
    expect(extracted.fields.registeredVoters).toBe(289);
    expect(extracted.fields.accreditedVoters).toBe(210);
    expect(extracted.fields.votesCast).toBe(207);
    expect(extracted.fields.usedBallotPapers).toBe(210);
    expect(extracted.fields.unusedBallotPapers).toBe(79);
    expect(extracted.partyResults.PDP).toBe(159);
    expect(extracted.partyResults.APC).toBe(40);
    expect(extracted.partyResults.ADC).toBe(8);
    expect(extracted.confidence).toBe(1);
  });

  it('marks empty text unreadable', () => {
    expect(parseEc8aOcrText('blurry photo of a wall', ['PDP']).unreadable).toBe(true);
  });

  it('recommends RETURN when photo digits disagree with typed figures', () => {
    const typed = {
      registeredVoters: 289,
      accreditedVoters: 210,
      ballotPapersIssued: 289,
      unusedBallotPapers: 79,
      spoiledBallotPapers: 0,
      invalidVotes: 3,
      votesCast: 207,
      usedBallotPapers: 210,
      partyResults: { PDP: 180, APC: 40, ADC: 8 },
      ec8aPhotoUrls: ['/uploads/ec8a.jpg'],
    };
    const vision = parseEc8aOcrText(sample, ['PDP', 'APC', 'ADC']);
    const merged = mergeVisionWithArithmetic(typed, vision);
    expect(merged.engine).toBe('OCR');
    expect(merged.recommendation).toBe('RETURN');
    expect(merged.arithmeticFlags).toContain('OCR_PARTY_PDP_MISMATCH');
  });

  it('recommends APPROVE when photo matches a clean arithmetic sheet', () => {
    const typed = {
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
    expect(arithmeticVerification(typed).recommendation).toBe('APPROVE');
    const merged = mergeVisionWithArithmetic(typed, parseEc8aOcrText(sample, ['PDP', 'APC', 'ADC']));
    expect(merged.recommendation).toBe('APPROVE');
    expect(merged.engine).toBe('OCR');
  });

  it('parses number words including OCR typos', () => {
    expect(parseNumberWords(['one', 'hundred', 'and', 'fifty', 'nine'])?.value).toBe(159);
    expect(parseNumberWords(['fourty'])?.value).toBe(40);
    expect(parseNumberWords(['zebo'])?.value).toBe(0);
    expect(parseNumberWords(['zero', 'zero', 'four'], 0)).toEqual({ value: 0, consumed: 1 });
    expect(parseNumberWords(['zero', 'zero', 'four'], 2)?.value).toBe(4);
    expect(parseNumberWords(['ninty', 'five'])?.value).toBe(95);
    expect(parseNumberWords(['seventh', 'four'])?.value).toBe(74);
    expect(parseNumberWords(['tho'])?.value).toBe(2);
    expect(parseNumberWords(['lero'])?.value).toBe(0);
    expect(parseNumberWords(['ohe'])?.value).toBe(1);
  });

  it('reads boxed totals and party words from a real Vision EC8A dump', () => {
    const extracted = parseEc8aOcrText(osunVisionText, [
      'AA',
      'AAC',
      'ADC',
      'APC',
      'APGA',
      'APM',
      'APP',
      'BP',
      'NNPP',
      'PDP',
      'PRP',
      'SDP',
      'YPP',
      'ZLP',
    ]);
    expect(extracted.unreadable).toBe(false);
    expect(extracted.fields).toMatchObject({
      registeredVoters: 289,
      accreditedVoters: 210,
      ballotPapersIssued: 289,
      unusedBallotPapers: 79,
      spoiledBallotPapers: 0,
      invalidVotes: 3,
      votesCast: 207,
      usedBallotPapers: 210,
    });
    expect(extracted.partyResults.A).toBe(159);
    expect(extracted.partyResults.AA).toBe(0);
    expect(extracted.partyResults.ADC).toBe(4);
    expect(extracted.partyResults.APC).toBe(40);
    expect(extracted.partyResults.PRP).toBe(1);
    expect(extracted.partyResults.ZLP).toBe(3);
    expect(extracted.partyResults.ZLP).not.toBe(500);
    expect(extracted.partyResults.APC).not.toBe(7);
  });

  it('does not treat a serial sitting after a party code as that party’s votes', () => {
    const trap = `
      POLITICAL PARTY VOTES SCORED IN FIGURES IN WORDS
      4 ADC 4
      5 ADP 2 TWO
    `;
    const extracted = parseEc8aOcrText(trap, ['ADC', 'ADP']);
    expect(extracted.partyResults.ADC).not.toBe(4);
    expect(extracted.partyResults.ADP).toBe(2);
  });

  it('does not treat SN / LGA codes as votes on a boxed Osun EC8A', () => {
    const extracted = parseEc8aOcrText(ayedadeVisionText, [
      'AA',
      'AAC',
      'ADC',
      'ADP',
      'APC',
      'APGA',
      'NNPP',
      'PDP',
      'ZLP',
    ]);
    expect(extracted.unreadable).toBe(false);
    expect(extracted.confidence).toBeGreaterThanOrEqual(MIN_AUTO_FILL_CONFIDENCE);
    expect(extracted.fields.registeredVoters).toBe(315);
    expect(extracted.fields.accreditedVoters).toBe(181);
    expect(extracted.fields.unusedBallotPapers).toBe(134);
    expect(extracted.fields.votesCast).toBe(172);
    expect(extracted.fields.usedBallotPapers).toBe(181);
    expect(extracted.partyResults.A).toBe(95);
    expect(extracted.partyResults.ADC).toBe(0);
    expect(extracted.partyResults.ADP).toBe(2);
    expect(extracted.partyResults.APC).toBe(74);
    expect(extracted.partyResults.ZLP).toBe(1);
    expect(extracted.partyResults.AAC).toBe(0);
  });

  it('reads a real Vision word-box dump of a handwritten Osun EC8A', () => {
    const extracted = parseEc8aOcr(ayedadeVisionText, ['APC', 'ADP', 'ADC', 'NNPP', 'ZLP'], ayedadeTokens);
    expect(extracted.unreadable).toBe(false);
    expect(extracted.confidence).toBe(1);
    expect(extracted.fields).toMatchObject({
      registeredVoters: 315,
      accreditedVoters: 181,
      ballotPapersIssued: 315,
      unusedBallotPapers: 134,
      spoiledBallotPapers: 0,
      invalidVotes: 9,
      votesCast: 172,
      usedBallotPapers: 181,
    });
    expect(extracted.partyResults.A).toBe(95);
    expect(extracted.partyResults.ADC).toBe(0);
    expect(extracted.partyResults.ADP).toBe(2);
    expect(extracted.partyResults.APC).toBe(74);
    expect(extracted.partyResults.NNPP).toBe(0);
    expect(extracted.partyResults.ZLP).toBe(1);
  });

  it('falls back to CHECK_PHOTO when Vision cannot read the form', () => {
    const typed = {
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
    const merged = mergeVisionWithArithmetic(typed, {
      fields: {},
      partyResults: {},
      confidence: null,
      unreadable: true,
      error: 'Vision not configured',
    });
    expect(merged.recommendation).toBe('CHECK_PHOTO');
    expect(merged.status).toBe('UNREADABLE');
  });
});
