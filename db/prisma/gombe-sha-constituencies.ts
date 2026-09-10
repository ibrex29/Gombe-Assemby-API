/**
 * Gombe State House of Assembly — 24 seats.
 *
 * Each seat owns its own `wards` array. Edit one seat without touching others.
 * Name-exact defaults only (ward name equals the seat or an alias). Everything
 * else stays empty until you add it. `sha:validate` never auto-assigns.
 *
 * Names: https://en.wikipedia.org/wiki/Gombe_State_House_of_Assembly
 *
 * IReV has no single Gombe SHA election. Each seat is its own 2023-03-18
 * `House of Assembly` record (`GET /elections?state_id=16`).
 */

export const GOMBE_STATE_CODE = 'GO';

export type GombeShaSeat = {
  code: string;
  name: string;
  lga: string;
  lgaAliases?: string[];
  aliases: string[];
  /** Ward names in this LGA that belong to this seat. Adjust locally. */
  wards: string[];
  /** INEC IReV election `_id` for this constituency (2023 SHA). */
  irevElectionId: string;
};

export const GOMBE_SHA_LGA_SEAT_COUNTS: Record<string, number> = {
  Akko: 3,
  Balanga: 2,
  Billiri: 2,
  Dukku: 2,
  Funakaye: 2,
  Gombe: 2,
  Kaltungo: 2,
  Kwami: 2,
  Nafada: 2,
  Shongom: 2,
  'Yamaltu/Deba': 3,
};

export const GOMBE_SHA_CONSTITUENCIES: GombeShaSeat[] = [
  {
    code: 'AKKO_CENTRAL',
    name: 'Akko Central (Kumo)',
    lga: 'Akko',
    aliases: ['Akko Central', 'Kumo'],
    wards: [],
    irevElectionId: '6407cb0e26d4fe6cc81c0c53',
  },
  {
    code: 'AKKO_NORTH',
    name: 'Akko North',
    lga: 'Akko',
    aliases: [],
    wards: [],
    irevElectionId: '6407cb1026d4fe6cc81c0dba',
  },
  {
    code: 'AKKO_WEST',
    name: 'Akko West',
    lga: 'Akko',
    aliases: [],
    wards: [],
    irevElectionId: '6407cb0d26d4fe6cc81c0b72',
  },
  {
    code: 'BALANGA_NORTH',
    name: 'Balanga North',
    lga: 'Balanga',
    aliases: [],
    wards: [],
    irevElectionId: '6407cb1326d4fe6cc81c0f6d',
  },
  {
    code: 'BALANGA_SOUTH',
    name: 'Balanga South',
    lga: 'Balanga',
    aliases: [],
    wards: [],
    irevElectionId: '6407cb1526d4fe6cc81c10a2',
  },
  {
    code: 'BILLIRI_EAST',
    name: 'Billiri East',
    lga: 'Billiri',
    aliases: [],
    wards: [],
    irevElectionId: '6407cb1726d4fe6cc81c11ab',
  },
  {
    code: 'BILLIRI_WEST',
    name: 'Billiri West',
    lga: 'Billiri',
    aliases: [],
    wards: [],
    irevElectionId: '6407cb1926d4fe6cc81c1288',
  },
  {
    code: 'DUKKU_NORTH',
    name: 'Dukku North',
    lga: 'Dukku',
    aliases: [],
    wards: [],
    irevElectionId: '6407cb1b26d4fe6cc81c1381',
  },
  {
    code: 'DUKKU_SOUTH',
    name: 'Dukku South',
    lga: 'Dukku',
    aliases: [],
    wards: [],
    irevElectionId: '6407cb1d26d4fe6cc81c147e',
  },
  {
    code: 'DEBA',
    name: 'Deba',
    lga: 'Yamaltu/Deba',
    lgaAliases: ['Yamaltu Deba', 'Yalmaltu/Deba', 'Yalmaltu/ Deba', 'YALMALTU/ DEBA'],
    aliases: ['Deba Constituency'],
    wards: ['DEBA'],
    irevElectionId: '6407cb3426d4fe6cc81c2039',
  },
  {
    code: 'FUNAKAYE_NORTH',
    name: 'Funakaye North',
    lga: 'Funakaye',
    aliases: [],
    wards: [],
    irevElectionId: '6407cb1f26d4fe6cc81c15cf',
  },
  {
    code: 'FUNAKAYE_SOUTH',
    name: 'Funakaye South',
    lga: 'Funakaye',
    aliases: [],
    wards: [],
    irevElectionId: '6407cb2226d4fe6cc81c172c',
  },
  {
    code: 'GOMBE_NORTH',
    name: 'Gombe North',
    lga: 'Gombe',
    aliases: [],
    wards: [],
    irevElectionId: '6407cb2426d4fe6cc81c1815',
  },
  {
    code: 'GOMBE_SOUTH',
    name: 'Gombe South',
    lga: 'Gombe',
    aliases: [],
    wards: [],
    irevElectionId: '6407cb2626d4fe6cc81c19d2',
  },
  {
    code: 'KALTUNGO_EAST',
    name: 'Kaltungo East',
    lga: 'Kaltungo',
    aliases: [],
    wards: ['KALTUNGO EAST'],
    irevElectionId: '6407cb2a26d4fe6cc81c1c86',
  },
  {
    code: 'KALTUNGO_WEST',
    name: 'Kaltungo West',
    lga: 'Kaltungo',
    aliases: [],
    wards: ['KALTUNGO WEST'],
    irevElectionId: '6407cb2926d4fe6cc81c1b8b',
  },
  {
    code: 'KWAMI_EAST',
    name: 'Kwami East',
    lga: 'Kwami',
    aliases: [],
    wards: [],
    irevElectionId: '6407cb3a26d4fe6cc81c23ae',
  },
  {
    code: 'KWAMI_WEST',
    name: 'Kwami West',
    lga: 'Kwami',
    aliases: [],
    wards: [],
    irevElectionId: '6407cb3c26d4fe6cc81c24a9',
  },
  {
    code: 'NAFADA_NORTH',
    name: 'Nafada North',
    lga: 'Nafada',
    aliases: [],
    wards: [],
    irevElectionId: '6407cb2d26d4fe6cc81c1dbb',
  },
  {
    code: 'NAFADA_SOUTH',
    name: 'Nafada South',
    lga: 'Nafada',
    aliases: [],
    wards: [],
    irevElectionId: '6407cb2f26d4fe6cc81c1ea0',
  },
  {
    code: 'PERO_CHONGE',
    name: 'Pero/Chonge',
    lga: 'Shongom',
    lgaAliases: ['Shongom'],
    aliases: ['Pero Chonge', 'Pero-Chonge'],
    wards: [],
    irevElectionId: '6407cb3226d4fe6cc81c1f86',
  },
  {
    code: 'SHONGOM',
    name: 'Shongom',
    lga: 'Shongom',
    lgaAliases: ['Shongom'],
    aliases: ['Shongom'],
    wards: [],
    irevElectionId: '6407cb3026d4fe6cc81c1f03',
  },
  {
    code: 'YAMALTU_EAST',
    name: 'Yamaltu East',
    lga: 'Yamaltu/Deba',
    lgaAliases: ['Yamaltu Deba', 'Yalmaltu/Deba', 'Yalmaltu/ Deba', 'YALMALTU/ DEBA'],
    aliases: [],
    wards: [],
    irevElectionId: '6407cb3626d4fe6cc81c21aa',
  },
  {
    code: 'YAMALTU_WEST',
    name: 'Yamaltu West',
    lga: 'Yamaltu/Deba',
    lgaAliases: ['Yamaltu Deba', 'Yalmaltu/Deba', 'Yalmaltu/ Deba', 'YALMALTU/ DEBA'],
    aliases: [],
    wards: [],
    irevElectionId: '6407cb3826d4fe6cc81c22d7',
  },
];

export const GOMBE_SHA_IREV_ELECTION_IDS: Record<string, string> = Object.fromEntries(
  GOMBE_SHA_CONSTITUENCIES.map((seat) => [seat.code, seat.irevElectionId]),
);

export function irevElectionIdForShaSeat(code: string): string | undefined {
  return GOMBE_SHA_IREV_ELECTION_IDS[code];
}

export function constituencyPersistFields(seat: GombeShaSeat, lgaId: string | null) {
  return {
    name: seat.name,
    aliases: seat.aliases,
    lgaId,
    irevElectionId: seat.irevElectionId,
  };
}

export type WardRef = { lga: string; name: string };

export type ShaValidateOptions = {
  allowPartial?: boolean;
};

export type ShaSeatReport = {
  code: string;
  name: string;
  lga: string;
  wards: string[];
  empty: boolean;
};

export type ShaValidateReport = {
  ok: boolean;
  allowPartial: boolean;
  seatCount: number;
  seats: ShaSeatReport[];
  emptySeats: string[];
  leftovers: WardRef[];
  clashes: Array<{ ward: WardRef; seats: string[] }>;
  unknownWards: Array<{ seat: string; ward: string; lga: string }>;
  lgaSeatCountErrors: string[];
  errors: string[];
};

export function normalizeShaName(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/['’]/g, '')
    .replace(/[/_\-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

export function lgaMatchesSeat(lgaName: string, seat: GombeShaSeat): boolean {
  const target = normalizeShaName(lgaName);
  if (target === normalizeShaName(seat.lga)) return true;
  return (seat.lgaAliases ?? []).some((alias) => normalizeShaName(alias) === target);
}

export function wardMatchesName(wardName: string, listed: string): boolean {
  return normalizeShaName(wardName) === normalizeShaName(listed);
}

export function nameExactWardNames(seat: GombeShaSeat): string[] {
  return [seat.name, ...seat.aliases].map(normalizeShaName);
}

export function isNameExactWard(seat: GombeShaSeat, wardName: string): boolean {
  const ward = normalizeShaName(wardName);
  return nameExactWardNames(seat).includes(ward);
}

export function validateGombeShaRoster(
  registerWards: WardRef[],
  seats: GombeShaSeat[] = GOMBE_SHA_CONSTITUENCIES,
  options: ShaValidateOptions = {},
): ShaValidateReport {
  const allowPartial = options.allowPartial === true;
  const errors: string[] = [];
  const lgaSeatCountErrors: string[] = [];

  if (seats.length !== 24) {
    errors.push(`Expected 24 seats, found ${seats.length}`);
  }
  const required = ['AKKO_CENTRAL', 'DEBA', 'PERO_CHONGE'] as const;
  for (const code of required) {
    if (!seats.some((seat) => seat.code === code)) {
      errors.push(`Missing required seat ${code}`);
    }
  }

  const codes = new Set<string>();
  for (const seat of seats) {
    if (codes.has(seat.code)) errors.push(`Duplicate seat code ${seat.code}`);
    codes.add(seat.code);
  }

  for (const [lga, expected] of Object.entries(GOMBE_SHA_LGA_SEAT_COUNTS)) {
    const actual = seats.filter((seat) => normalizeShaName(seat.lga) === normalizeShaName(lga)).length;
    if (actual !== expected) {
      const message = `${lga} should have ${expected} seats, found ${actual}`;
      lgaSeatCountErrors.push(message);
      errors.push(message);
    }
  }

  const claimed = new Map<string, string[]>();
  const unknownWards: Array<{ seat: string; ward: string; lga: string }> = [];

  const registerKey = (lga: string, name: string) =>
    `${normalizeShaName(lga)}::${normalizeShaName(name)}`;
  const registerSet = new Set(registerWards.map((ward) => registerKey(ward.lga, ward.name)));

  for (const seat of seats) {
    for (const ward of seat.wards) {
      const key = registerKey(seat.lga, ward);
      const list = claimed.get(key) ?? [];
      list.push(seat.code);
      claimed.set(key, list);
      const inRegister = registerWards.some(
        (row) => lgaMatchesSeat(row.lga, seat) && wardMatchesName(row.name, ward),
      );
      if (registerWards.length > 0 && !inRegister && !registerSet.has(key)) {
        unknownWards.push({ seat: seat.code, ward, lga: seat.lga });
      }
    }
  }

  const clashes = [...claimed.entries()]
    .filter(([, seatCodes]) => seatCodes.length > 1)
    .map(([key, seatCodes]) => {
      const [lga, name] = key.split('::');
      return { ward: { lga, name }, seats: seatCodes };
    });
  if (clashes.length) {
    for (const clash of clashes) {
      errors.push(
        `Ward ${clash.ward.lga} / ${clash.ward.name} is listed on ${clash.seats.join(', ')}`,
      );
    }
  }

  const leftovers = registerWards.filter((ward) => {
    const key = registerKey(ward.lga, ward.name);
    if (claimed.has(key)) return false;
    return !seats.some(
      (seat) =>
        lgaMatchesSeat(ward.lga, seat) &&
        seat.wards.some((listed) => wardMatchesName(ward.name, listed)),
    );
  });

  const seatReports: ShaSeatReport[] = seats.map((seat) => ({
    code: seat.code,
    name: seat.name,
    lga: seat.lga,
    wards: [...seat.wards],
    empty: seat.wards.length === 0,
  }));
  const emptySeats = seatReports.filter((seat) => seat.empty).map((seat) => seat.code);

  if (!allowPartial) {
    if (emptySeats.length) {
      errors.push(`Empty seats: ${emptySeats.join(', ')}`);
    }
    if (leftovers.length) {
      errors.push(`${leftovers.length} Gombe ward(s) have no seat`);
    }
    if (unknownWards.length) {
      errors.push(
        `${unknownWards.length} listed ward(s) are not in the Gombe register`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    allowPartial,
    seatCount: seats.length,
    seats: seatReports,
    emptySeats,
    leftovers,
    clashes,
    unknownWards,
    lgaSeatCountErrors,
    errors,
  };
}

export function formatShaValidateReport(report: ShaValidateReport): string {
  const lines = [
    `Gombe SHA · ${report.seatCount} seats · ${report.allowPartial ? 'partial' : 'complete'}`,
    '',
  ];
  for (const seat of report.seats) {
    lines.push(
      `${seat.code.padEnd(16)} ${seat.lga.padEnd(14)} ${seat.wards.length} ward(s)${
        seat.empty ? '  [empty]' : ''
      }`,
    );
    for (const ward of seat.wards) {
      lines.push(`  - ${ward}`);
    }
  }
  if (report.leftovers.length) {
    lines.push('', `Leftover wards (${report.leftovers.length}):`);
    for (const ward of report.leftovers) {
      lines.push(`  - ${ward.lga} / ${ward.name}`);
    }
  }
  if (report.errors.length) {
    lines.push('', 'Errors:');
    for (const error of report.errors) lines.push(`  - ${error}`);
  }
  return lines.join('\n');
}
