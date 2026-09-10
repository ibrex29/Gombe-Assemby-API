const ONES: Record<string, number> = {
  zero: 0,
  zebo: 0,
  zevo: 0,
  zaro: 0,
  lero: 0,
  one: 1,
  ohe: 1,
  two: 2,
  tho: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fourty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  seventh: 70,
  eighty: 80,
  ninety: 90,
  ninty: 90,
};

const WORD_ALIASES: Record<string, string> = {
  tho: 'two',
  ohe: 'one',
  lero: 'zero',
  zaro: 'zero',
  seventh: 'seventy',
  ninty: 'ninety',
};

const OCR_WORD_SPLITS: Record<string, string[]> = {
  fiftinine: ['fifty', 'nine'],
  fiftnine: ['fifty', 'nine'],
  fiftenine: ['fifty', 'nine'],
  ninetyfive: ['ninety', 'five'],
  nintyfive: ['ninety', 'five'],
  seventyfour: ['seventy', 'four'],
  seventhfour: ['seventy', 'four'],
  seventyfive: ['seventy', 'five'],
  fortyfive: ['forty', 'five'],
  fourtyfive: ['forty', 'five'],
};

const PARTY_CODE_STOP = new Set([
  'AND',
  'THE',
  'FOR',
  'OF',
  'IN',
  'TO',
  'OR',
  'SN',
  'FORM',
  'EC',
  'CODE',
  'DATE',
  'NAME',
  'TOTAL',
  'VALID',
  'VOTES',
  'PARTY',
  'POLITICAL',
  'FIGURES',
  'WORDS',
  'BALLOT',
  'PAPERS',
  'AGENT',
  'ZERO',
  'ONE',
  'TWO',
  'THREE',
  'FOUR',
  'FIVE',
  'SIX',
  'SEVEN',
  'EIGHT',
  'NINE',
  'TEN',
  'FORTY',
  'FOURTY',
  'FIFTY',
  'HUNDRED',
  'THOUSAND',
  'INEC',
  'OSUN',
  'IFE',
]);

function normalizeWord(token: string): string {
  const raw = token.toLowerCase().replace(/[^a-z]/g, '');
  return WORD_ALIASES[raw] ?? raw;
}

export function tokenizeOcr(text: string): string[] {
  const raw = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean);
  const tokens: string[] = [];
  for (const token of raw) {
    const split = OCR_WORD_SPLITS[token];
    if (split) tokens.push(...split);
    else tokens.push(token);
  }
  return tokens;
}

export function parseNumberWords(tokens: string[], start = 0): { value: number; consumed: number } | null {
  const first = normalizeWord(tokens[start] ?? '');
  if (!first) return null;
  if (first === 'zero' || first === 'zebo' || first === 'zevo' || first === 'zaro' || first === 'lero') {
    return { value: 0, consumed: 1 };
  }

  let total = 0;
  let current = 0;
  let consumed = 0;
  let i = start;

  while (i < tokens.length) {
    const word = normalizeWord(tokens[i] ?? '');
    if (!word) break;
    if (word === 'and' && consumed > 0) {
      i += 1;
      consumed += 1;
      continue;
    }
    if (ONES[word] != null) {
      if (word === 'zero' || word === 'zebo' || word === 'zevo' || word === 'zaro' || word === 'lero') break;
      if (current >= 1 && current <= 19) break;
      if (current % 10 !== 0) break;
      current += ONES[word];
      i += 1;
      consumed += 1;
      continue;
    }
    if (TENS[word] != null) {
      if (current % 100 !== 0) break;
      current += TENS[word];
      i += 1;
      consumed += 1;
      continue;
    }
    if (word === 'hundred') {
      current = (current || 1) * 100;
      i += 1;
      consumed += 1;
      continue;
    }
    if (word === 'thousand') {
      total += (current || 1) * 1000;
      current = 0;
      i += 1;
      consumed += 1;
      continue;
    }
    break;
  }

  if (consumed === 0) return null;
  return { value: total + current, consumed };
}

export function isPartyCode(token: string): boolean {
  const code = token.toUpperCase();
  if (!/^[A-Z]{1,6}$/.test(code)) return false;
  return !PARTY_CODE_STOP.has(code);
}
