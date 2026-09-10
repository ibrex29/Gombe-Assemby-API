import { isPartyCode, parseNumberWords, tokenizeOcr } from './ocr-ec8a-words';

export interface OcrToken {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const LAYOUT_SUMMARY_FIELDS = [
  'registeredVoters',
  'accreditedVoters',
  'ballotPapersIssued',
  'unusedBallotPapers',
  'spoiledBallotPapers',
  'invalidVotes',
  'votesCast',
  'usedBallotPapers',
] as const;

type VisionVertex = { x?: number | null; y?: number | null };
type VisionWord = {
  symbols?: Array<{ text?: string | null } | null> | null;
  boundingBox?: { vertices?: Array<VisionVertex | null> | null } | null;
};
type VisionPage = {
  blocks?: Array<{
    paragraphs?: Array<{ words?: Array<VisionWord | null> | null } | null> | null;
  } | null> | null;
};

export function tokensFromVisionPages(pages: VisionPage[] | null | undefined): OcrToken[] {
  const tokens: OcrToken[] = [];
  for (const page of pages ?? []) {
    for (const block of page.blocks ?? []) {
      for (const para of block?.paragraphs ?? []) {
        for (const word of para?.words ?? []) {
          if (!word) continue;
          const text = (word.symbols ?? []).map((symbol) => symbol?.text ?? '').join('').trim();
          if (!text) continue;
          const verts = (word.boundingBox?.vertices ?? []).filter(Boolean) as VisionVertex[];
          const xs = verts.map((vertex) => vertex.x ?? 0);
          const ys = verts.map((vertex) => vertex.y ?? 0);
          if (xs.length === 0 || ys.length === 0) continue;
          const minX = Math.min(...xs);
          const maxX = Math.max(...xs);
          const minY = Math.min(...ys);
          const maxY = Math.max(...ys);
          tokens.push({
            text,
            x: (minX + maxX) / 2,
            y: (minY + maxY) / 2,
            w: Math.max(1, maxX - minX),
            h: Math.max(1, maxY - minY),
          });
        }
      }
    }
  }
  return tokens;
}

function tokenNumber(text: string): number | null {
  const trimmed = text.replace(/,/g, '').trim();
  if (/^[oOøØ]$/.test(trimmed)) return 0;
  if (/^\d{1,7}$/.test(trimmed)) return Number(trimmed);
  return null;
}

function clusterRows(tokens: OcrToken[]): OcrToken[][] {
  if (tokens.length === 0) return [];
  const heights = tokens.map((token) => token.h).filter((height) => height > 0).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] ?? 20;
  const tol = Math.max(18, medianH * 0.7);
  const sorted = [...tokens].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: OcrToken[][] = [];
  for (const token of sorted) {
    const last = rows[rows.length - 1];
    if (!last) {
      rows.push([token]);
      continue;
    }
    const meanY = last.reduce((sum, item) => sum + item.y, 0) / last.length;
    if (Math.abs(token.y - meanY) <= tol) last.push(token);
    else rows.push([token]);
  }
  return rows.map((row) => [...row].sort((a, b) => a.x - b.x));
}

function layoutSummary(tokens: OcrToken[]): Record<string, number | null> {
  const fields: Record<string, number | null> = {};
  for (const field of LAYOUT_SUMMARY_FIELDS) fields[field] = null;
  if (tokens.length === 0) return fields;

  const maxX = Math.max(...tokens.map((token) => token.x + token.w / 2));
  const politicalY =
    tokens.find((token) => /^political$/i.test(token.text))?.y ?? Number.POSITIVE_INFINITY;
  const hashes = tokens
    .filter(
      (token) =>
        token.text === '#' &&
        token.y < politicalY - 20 &&
        token.x > maxX * 0.55 &&
        token.x < maxX * 0.78,
    )
    .sort((a, b) => a.y - b.y)
    .slice(0, 8);

  if (hashes.length >= 7) {
    for (let i = 0; i < LAYOUT_SUMMARY_FIELDS.length; i += 1) {
      const hash = hashes[i];
      if (!hash) continue;
      const value = tokens
        .filter((token) => {
          const number = tokenNumber(token.text);
          return number != null && Math.abs(token.y - hash.y) <= 45 && token.x > hash.x + 180;
        })
        .sort((a, b) => b.x - a.x)[0];
      const number = value ? tokenNumber(value.text) : null;
      if (number != null) fields[LAYOUT_SUMMARY_FIELDS[i]!] = number;
    }
  }

  return fields;
}

function layoutParties(tokens: OcrToken[]): Record<string, number> {
  const partyResults: Record<string, number> = {};
  const figuresHeader = tokens.find((token) => /^figures$/i.test(token.text));
  const wordsHeader = tokens.find((token) => /^words$/i.test(token.text));
  const rows = clusterRows(tokens);

  for (const row of rows) {
    for (const token of row) {
      if (!isPartyCode(token.text)) continue;
      const left = row.filter((item) => item.x < token.x - 8);
      const serial = left.find((item) => {
        const value = tokenNumber(item.text);
        return value != null && value >= 1 && value <= 20 && item.x < token.x;
      });
      if (!serial) continue;

      const figureMaxX = (wordsHeader?.x ?? token.x + 700) - 80;
      const figureMinX = token.x + 60;
      const figureTok = row.find((item) => {
        const value = tokenNumber(item.text);
        return value != null && item.x > figureMinX && item.x < figureMaxX;
      });
      const figure = figureTok ? tokenNumber(figureTok.text) : null;

      const wordMinX = figuresHeader?.x ?? token.x + 250;
      const wordMaxX = wordMinX + 900;
      const wordTexts = row
        .filter((item) => /[a-z]/i.test(item.text) && item.x > wordMinX && item.x < wordMaxX)
        .map((item) => item.text);
      const parsedWords = parseNumberWords(tokenizeOcr(wordTexts.join(' ')));
      const votes = parsedWords?.value ?? (figure != null && figure !== tokenNumber(serial.text) ? figure : null);
      if (votes == null) continue;
      partyResults[token.text.toUpperCase()] = votes;
    }
  }

  return partyResults;
}

export function extractEc8aLayout(tokens: OcrToken[]): {
  fields: Record<string, number | null>;
  partyResults: Record<string, number>;
} {
  return {
    fields: layoutSummary(tokens),
    partyResults: layoutParties(tokens),
  };
}
