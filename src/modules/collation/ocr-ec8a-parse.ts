import type { OcrToken } from './ocr-ec8a-layout';
import { extractEc8aLayout } from './ocr-ec8a-layout';
import { isPartyCode, parseNumberWords, tokenizeOcr } from './ocr-ec8a-words';
import type { CollationFigures, OcrVerification, OcrVerificationDiff } from './ocr-verification';
import { arithmeticVerification, partyVotesSum } from './ocr-verification';

export type { OcrToken } from './ocr-ec8a-layout';
export { tokensFromVisionPages } from './ocr-ec8a-layout';
export { parseNumberWords } from './ocr-ec8a-words';

const NUMBER_RE = /(\d{1,3}(?:,\d{3})+|\d{1,7})/;

export const FIELD_PATTERNS: Array<{
  field: keyof Pick<
    CollationFigures,
    | 'registeredVoters'
    | 'accreditedVoters'
    | 'ballotPapersIssued'
    | 'unusedBallotPapers'
    | 'spoiledBallotPapers'
    | 'invalidVotes'
    | 'votesCast'
    | 'usedBallotPapers'
  >;
  label: string;
  patterns: RegExp[];
}> = [
  {
    field: 'registeredVoters',
    label: 'Voters on the register',
    patterns: [/#\s*1\b[\s\S]{0,40}register/i, /voters?\s+on\s+the\s+register/i, /registered\s+voters?/i],
  },
  {
    field: 'accreditedVoters',
    label: 'Accredited voters',
    patterns: [/#\s*2\b[\s\S]{0,40}accredited/i, /accredited\s+voters?/i],
  },
  {
    field: 'ballotPapersIssued',
    label: 'Ballot papers issued',
    patterns: [/#\s*3\b[\s\S]{0,60}issued/i, /ballot\s+papers?\s+issued/i, /issued\s+to\s+the\s+polling\s+unit/i],
  },
  {
    field: 'unusedBallotPapers',
    label: 'Unused ballot papers',
    patterns: [/#\s*4\b[\s\S]{0,40}unused/i, /\bunused\s+ballot/i],
  },
  {
    field: 'spoiledBallotPapers',
    label: 'Spoiled ballot papers',
    patterns: [/#\s*5\b[\s\S]{0,40}spol/i, /\bspol+ed\s+ballot/i],
  },
  {
    field: 'invalidVotes',
    label: 'Rejected ballots',
    patterns: [/#\s*6\b[\s\S]{0,40}rejected/i, /\brejected\s+ballots?/i, /\brejected\s+votes?/i],
  },
  {
    field: 'votesCast',
    label: 'Total valid votes',
    patterns: [/#\s*7\b[\s\S]{0,80}valid\s+votes/i, /number of total valid votes/i, /total\s+valid\s+votes?/i],
  },
  {
    field: 'usedBallotPapers',
    label: 'Used ballot papers',
    patterns: [
      /#\s*8\b[\s\S]{0,80}used\s+ballot/i,
      /total\s+number\s+of\s+used\s+ballot/i,
      /(?<!un)used\s+ballot\s+papers?/i,
    ],
  },
];

export interface VisionExtract {
  fields: Record<string, number | null>;
  partyResults: Record<string, number>;
  confidence: number | null;
  unreadable: boolean;
  error?: string;
}

interface LabelHit {
  field: string;
  index: number;
  end: number;
}

interface FoundNumber {
  value: number;
  index: number;
  raw: string;
}

const LARGE_SUMMARY_FIELDS = new Set([
  'registeredVoters',
  'accreditedVoters',
  'ballotPapersIssued',
  'usedBallotPapers',
]);

/** Auto-fill the agent form only when identities hold or enough parties agree. */
export const MIN_AUTO_FILL_CONFIDENCE = 0.75;

function looksLikeLocationCode(text: string, index: number, raw: string): boolean {
  const digits = raw.replace(/,/g, '');
  const before = text.slice(Math.max(0, index - 40), index);
  const after = text.slice(index + digits.length, index + digits.length + 28);
  if (digits.length <= 3 && /\bcode\b/i.test(before.slice(-20) + after.slice(0, 12))) return true;
  if (/s\/n\s*$/i.test(before)) return true;
  if (/^\s*(local government|state\.)/i.test(after)) return true;
  return false;
}

function tooSmallForField(field: string, value: number): boolean {
  return LARGE_SUMMARY_FIELDS.has(field) && value < 10;
}

function collectFormNumbers(text: string): FoundNumber[] {
  const re = /#\s*\d+|(\d{1,3}(?:,\d{3})+|\d{1,7})/g;
  const found: FoundNumber[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (match[0].startsWith('#')) continue;
    const raw = match[1] ?? match[0];
    const value = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    if (/^0\d{5,}$/.test(raw)) continue;
    if (value > 50_000) continue;
    if (looksLikeLocationCode(text, match.index, raw)) continue;
    found.push({ value, index: match.index, raw });
  }
  return found;
}

function findLabels(text: string): LabelHit[] {
  const hits: LabelHit[] = [];
  for (const spec of FIELD_PATTERNS) {
    for (const pattern of spec.patterns) {
      const match = pattern.exec(text);
      if (!match) continue;
      hits.push({ field: spec.field, index: match.index, end: match.index + match[0].length });
      break;
    }
  }
  hits.sort((a, b) => a.index - b.index);
  return hits;
}

function assignClusteredFields(text: string): Record<string, number | null> {
  const fields: Record<string, number | null> = {};
  for (const spec of FIELD_PATTERNS) fields[spec.field] = null;

  const labels = findLabels(text);
  const numbers = collectFormNumbers(text);
  if (labels.length === 0) return fields;

  let numIdx = 0;
  while (numIdx < numbers.length && numbers[numIdx]!.index < labels[0]!.index) numIdx += 1;

  let i = 0;
  while (i < labels.length) {
    let j = i + 1;
    while (j < labels.length) {
      const hasNumberBetween = numbers.some(
        (item) => item.index >= labels[j - 1]!.end && item.index < labels[j]!.index,
      );
      if (hasNumberBetween) break;
      j += 1;
    }
    const group = labels.slice(i, j);
    const after = group[group.length - 1]!.end;
    const before = labels[j]?.index ?? Number.POSITIVE_INFINITY;
    while (numIdx < numbers.length && numbers[numIdx]!.index < after) numIdx += 1;
    const cluster: number[] = [];
    while (
      numIdx < numbers.length &&
      numbers[numIdx]!.index < before &&
      cluster.length < group.length
    ) {
      const value = numbers[numIdx]!.value;
      const field = group[cluster.length]?.field;
      numIdx += 1;
      if (field && tooSmallForField(field, value)) continue;
      cluster.push(value);
    }
    for (let k = 0; k < group.length; k += 1) {
      const value = cluster[k];
      if (value == null) continue;
      if (tooSmallForField(group[k]!.field, value)) continue;
      fields[group[k]!.field] = value;
    }
    i = j;
  }
  return fields;
}

function firstUsefulNumberAfter(text: string, from: number, window = 120): number | null {
  const slice = text.slice(from, from + window);
  const numbers = collectFormNumbers(slice);
  return numbers[0]?.value ?? null;
}

function nextSerialLine(block: string[], from: number, serial: number): boolean {
  for (let i = from; i < Math.min(block.length, from + 4); i += 1) {
    const line = block[i] ?? '';
    if (/^(0|[1-9]\d?)$/.test(line) && Number(line) === serial + 1) return true;
    if (isPartyCode(line)) continue;
  }
  return false;
}

function extractPartyTable(text: string): { codes: string[]; figures: Array<number | null> } {
  const start = text.search(/political\s+party|votes\s+scored/i);
  if (start < 0) return { codes: [], figures: [] };
  const rest = text.slice(start);
  const endMatch = rest.search(/number of total valid votes|total valid votes/i);
  const block = (endMatch > 80 ? rest.slice(0, endMatch) : rest).split(/\n/).map((line) => line.trim());
  const codes: string[] = [];
  const figures: Array<number | null> = [];

  for (let i = 0; i < block.length; i += 1) {
    const line = block[i] ?? '';
    if (!/^(0|[1-9]\d?)$/.test(line)) continue;
    const serial = Number(line);
    if (serial < 1 || serial > 30) continue;
    const code = block[i + 1] ?? '';
    if (!isPartyCode(code)) continue;
    codes.push(code.toUpperCase());
    const maybeFigure = block[i + 2] ?? '';
    if (!/^\d{1,5}$/.test(maybeFigure)) {
      figures.push(null);
      continue;
    }
    const figure = Number(maybeFigure);
    const followedByNextSerial = nextSerialLine(block, i + 3, serial);
    // SN 4 / ADC / 4 / 5  → the "4" is the serial, not four votes.
    if (figure === serial + 1 || (figure === serial && followedByNextSerial) || figure === serial) {
      figures.push(null);
      continue;
    }
    figures.push(figure);
  }
  return { codes, figures };
}

function extractWordScoresFrom(slice: string, expectedCount: number): number[] {
  let text = slice;
  const totalAt = text.search(/\btotal\s+valid\s+votes\b/i);
  if (totalAt > 40) text = text.slice(0, totalAt);

  const tokens = tokenizeOcr(text);
  const scores: number[] = [];
  let i = 0;
  while (i < tokens.length && scores.length < expectedCount + 2) {
    const parsed = parseNumberWords(tokens, i);
    if (parsed) {
      scores.push(parsed.value);
      i += parsed.consumed;
      continue;
    }
    if (/^\d+$/.test(tokens[i] ?? '')) {
      const digit = Number(tokens[i]);
      const next = parseNumberWords(tokens, i + 1);
      if (next && next.value === digit) {
        scores.push(digit);
        i += 1 + next.consumed;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  if (scores.length === expectedCount + 1) scores.pop();
  return scores.slice(0, expectedCount || scores.length);
}

function extractWordScores(text: string, expectedCount: number): number[] {
  const windows: string[] = [];
  const inWords = text.search(/in\s+words/i);
  if (inWords >= 0) windows.push(text.slice(inWords));
  const afterTable = [
    text.search(/name\s*\/\s*signature/i),
    text.search(/polling\s+agent/i),
    text.search(/total\s+number\s+of\s+used\s+ballot/i),
  ].filter((index) => index >= 0);
  if (afterTable.length > 0) windows.push(text.slice(Math.max(...afterTable)));
  if (windows.length === 0) return [];

  const expected = expectedCount || 18;
  const candidates = windows.map((slice) => extractWordScoresFrom(slice, expected));
  candidates.sort((a, b) => {
    const aFit = Math.abs(a.length - expected);
    const bFit = Math.abs(b.length - expected);
    if (aFit !== bFit) return aFit - bFit;
    const aZeros = a.filter((n) => n === 0).length;
    const bZeros = b.filter((n) => n === 0).length;
    return bZeros - aZeros;
  });
  return candidates[0] ?? [];
}

function extractPartiesFromWordsAndTable(text: string): Record<string, number> {
  const table = extractPartyTable(text);
  const wordScores = extractWordScores(text, table.codes.length || 18);
  const partyResults: Record<string, number> = {};
  const enoughWords =
    table.codes.length > 0 && wordScores.length >= Math.min(8, table.codes.length);

  if (enoughWords) {
    for (let i = 0; i < table.codes.length; i += 1) {
      const fromWords = wordScores[i];
      const fromFigure = table.figures[i];
      const votes = fromWords ?? fromFigure;
      if (votes == null) continue;
      partyResults[table.codes[i]!] = votes;
    }
    return partyResults;
  }

  if (table.codes.length > 0) {
    for (let i = 0; i < table.codes.length; i += 1) {
      const votes = table.figures[i];
      if (votes == null) continue;
      partyResults[table.codes[i]!] = votes;
    }
  }
  return partyResults;
}

function looksLikeNextSerial(text: string, afterIndex: number, value: number): boolean {
  if (value < 1 || value > 30) return false;
  const after = text.slice(afterIndex, afterIndex + 48);
  // SN 4 / ADC / 4 / 5 ADP — the "4" after ADC is the serial, not four votes.
  return /^\s*\d{1,2}\s+[A-Z]{1,6}\b/i.test(after);
}

function extractPartiesByCode(text: string, partyCodes: string[]): Record<string, number> {
  const partyResults: Record<string, number> = {};
  const codes = [...new Set(partyCodes.map((code) => code.toUpperCase()))].filter(
    (code) => code.length >= 2 && code.length <= 6,
  );
  for (const code of codes) {
    const pattern = new RegExp(`\\b${code}\\b[^0-9]{0,24}${NUMBER_RE.source}`, 'i');
    const match = pattern.exec(text);
    if (!match) continue;
    const value = Number(match[1]!.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    if (looksLikeNextSerial(text, match.index + match[0].length, value)) continue;
    partyResults[code] = value;
  }
  return partyResults;
}

function applyPatternFields(text: string, fields: Record<string, number | null>) {
  const partyTableAt = text.search(/political\s+party|votes\s+scored/i);
  for (const spec of FIELD_PATTERNS) {
    const current = fields[spec.field];
    if (current != null && !tooSmallForField(spec.field, current)) continue;
    for (const pattern of spec.patterns) {
      const match = pattern.exec(text);
      if (!match) continue;
      if (partyTableAt >= 0 && match.index > partyTableAt) continue;
      const found = firstUsefulNumberAfter(text, match.index + match[0].length, 80);
      if (found == null) continue;
      if (tooSmallForField(spec.field, found)) continue;
      fields[spec.field] = found;
      break;
    }
  }
}

function reconcileExtract(fields: Record<string, number | null>, partyResults: Record<string, number>) {
  const partySum = partyVotesSum(partyResults);
  if (partySum != null && partySum >= 10) {
    const valid = fields.votesCast;
    if (valid == null || valid < 10 || valid === partySum) {
      fields.votesCast = partySum;
    }
  }
  const spoiled = fields.spoiledBallotPapers ?? 0;
  const rejected = fields.invalidVotes ?? 0;
  const valid = fields.votesCast;
  if (valid != null && fields.usedBallotPapers == null) {
    fields.usedBallotPapers = spoiled + rejected + valid;
  }
  if (fields.accreditedVoters != null && fields.usedBallotPapers == null) {
    fields.usedBallotPapers = fields.accreditedVoters;
  }
  if (
    fields.ballotPapersIssued == null &&
    fields.usedBallotPapers != null &&
    fields.unusedBallotPapers != null
  ) {
    fields.ballotPapersIssued = fields.usedBallotPapers + fields.unusedBallotPapers;
  }
}

export function parseEc8aOcrText(text: string, partyCodes: string[] = []): VisionExtract {
  const fields = assignClusteredFields(text);
  applyPatternFields(text, fields);

  const table = extractPartyTable(text);
  const fromTable = extractPartiesFromWordsAndTable(text);
  const partyResults = { ...fromTable };
  if (table.codes.length < 8) {
    const fromCodes = extractPartiesByCode(text, partyCodes);
    for (const [code, votes] of Object.entries(fromCodes)) {
      if (partyResults[code] == null) partyResults[code] = votes;
    }
  }

  reconcileExtract(fields, partyResults);
  return finishExtract(fields, partyResults);
}

function finishExtract(
  fields: Record<string, number | null>,
  partyResults: Record<string, number>,
): VisionExtract {
  const extractedCount =
    Object.values(fields).filter((value) => value != null).length + Object.keys(partyResults).length;
  const partySum = partyVotesSum(partyResults);
  const identitiesHold =
    (partySum != null && fields.votesCast != null && partySum === fields.votesCast) ||
    (fields.usedBallotPapers != null &&
      fields.spoiledBallotPapers != null &&
      fields.invalidVotes != null &&
      fields.votesCast != null &&
      fields.usedBallotPapers === fields.spoiledBallotPapers + fields.invalidVotes + fields.votesCast);

  const confidence =
    extractedCount === 0 ? null : identitiesHold ? 1 : Math.min(0.65, extractedCount / 16);

  return {
    fields,
    partyResults,
    confidence,
    unreadable: extractedCount === 0 || (confidence != null && confidence < 0.45),
  };
}

export function parseEc8aOcr(
  text: string,
  partyCodes: string[] = [],
  tokens: OcrToken[] = [],
): VisionExtract {
  const fromText = parseEc8aOcrText(text, partyCodes);
  if (tokens.length < 30) return fromText;

  const fromLayout = extractEc8aLayout(tokens);
  const fields = { ...fromText.fields };
  for (const [field, value] of Object.entries(fromLayout.fields)) {
    if (value != null) fields[field] = value;
  }

  const layoutPartyCount = Object.keys(fromLayout.partyResults).length;
  const partyResults =
    layoutPartyCount >= 8
      ? { ...fromLayout.partyResults }
      : { ...fromText.partyResults, ...fromLayout.partyResults };

  reconcileExtract(fields, partyResults);
  return finishExtract(fields, partyResults);
}

function typedValue(input: CollationFigures, field: string): number | null {
  const record = input as Record<string, unknown>;
  const value = record[field];
  return typeof value === 'number' ? value : null;
}

export function mergeVisionWithArithmetic(
  typed: CollationFigures,
  vision: VisionExtract,
  arithmetic: OcrVerification = arithmeticVerification(typed),
): OcrVerification {
  const photoCount = typed.ec8aPhotoUrls?.length ?? 0;
  const verifiedAt = new Date().toISOString();
  const ocrFields: Record<string, number | null> = {
    ...vision.fields,
    ...Object.fromEntries(Object.entries(vision.partyResults).map(([code, votes]) => [`party.${code}`, votes])),
  };

  if (vision.unreadable || vision.error) {
    return {
      ...arithmetic,
      engine: 'OCR',
      status: arithmetic.recommendation === 'RETURN' ? 'MISMATCH' : 'UNREADABLE',
      recommendation: arithmetic.recommendation === 'RETURN' ? 'RETURN' : 'CHECK_PHOTO',
      confidence: vision.confidence,
      photoCount,
      verifiedAt,
      ocrError: vision.error ?? (vision.unreadable ? 'Could not read digits from the EC8A photo' : null),
      ocrFields,
      arithmeticFlags: arithmetic.arithmeticFlags.filter((flag) => flag !== 'OCR_PENDING'),
    };
  }

  const diffs: OcrVerificationDiff[] = [...arithmetic.diffs];
  const ocrFlags: string[] = [];

  for (const spec of FIELD_PATTERNS) {
    const ocrValue = vision.fields[spec.field];
    const typedNumber = typedValue(typed, spec.field);
    if (ocrValue == null || typedNumber == null) continue;
    if (ocrValue === typedNumber) continue;
    diffs.push({
      field: spec.field,
      label: spec.label,
      typed: typedNumber,
      expected: ocrValue,
      message: `Typed ${spec.label.toLowerCase()} is ${typedNumber}, but the EC8A photo reads ${ocrValue}.`,
    });
    ocrFlags.push(`OCR_${spec.field.toUpperCase()}_MISMATCH`);
  }

  const typedParties =
    typed.partyResults && typeof typed.partyResults === 'object' && !Array.isArray(typed.partyResults)
      ? (typed.partyResults as Record<string, number>)
      : {};
  for (const [code, ocrVotes] of Object.entries(vision.partyResults)) {
    const typedVotes = typedParties[code];
    if (typeof typedVotes !== 'number') continue;
    if (typedVotes === ocrVotes) continue;
    diffs.push({
      field: `party.${code}`,
      label: `${code} votes`,
      typed: typedVotes,
      expected: ocrVotes,
      message: `Typed ${code} is ${typedVotes}, but the EC8A photo reads ${ocrVotes}.`,
    });
    ocrFlags.push(`OCR_PARTY_${code}_MISMATCH`);
  }

  const ocrPartySum = partyVotesSum(vision.partyResults);
  const typedValid = typed.votesCast ?? null;
  if (ocrPartySum != null && typedValid != null && ocrPartySum !== typedValid && !ocrFlags.includes('OCR_VOTESCAST_MISMATCH')) {
    diffs.push({
      field: 'votesCast',
      label: 'Total valid votes',
      typed: typedValid,
      expected: ocrPartySum,
      message: `Typed valid votes is ${typedValid}, but party scores on the EC8A photo total ${ocrPartySum}.`,
    });
    ocrFlags.push('OCR_PARTY_SUM_NE_VALID');
  }

  const ocrMismatch = ocrFlags.length > 0;
  const arithmeticReturn = arithmetic.recommendation === 'RETURN';
  const recommendation = arithmeticReturn || ocrMismatch ? 'RETURN' : 'APPROVE';
  const status = recommendation === 'RETURN' ? 'MISMATCH' : 'MATCH';
  const uniqueDiffs = diffs.filter(
    (diff, index, all) =>
      all.findIndex((other) => other.field === diff.field && other.message === diff.message) === index,
  );

  return {
    status,
    recommendation,
    engine: 'OCR',
    confidence: vision.confidence,
    arithmeticFlags: [
      ...arithmetic.arithmeticFlags.filter((flag) => flag !== 'OCR_PENDING'),
      ...ocrFlags,
    ],
    diffs: uniqueDiffs,
    suggestedRejectReason: uniqueDiffs.length
      ? uniqueDiffs
          .slice(0, 2)
          .map((diff) => diff.message)
          .join(' ')
      : null,
    photoCount,
    verifiedAt,
    ocrError: null,
    ocrFields,
  };
}
