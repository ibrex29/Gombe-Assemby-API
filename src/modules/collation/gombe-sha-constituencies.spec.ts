import {
  constituencyPersistFields,
  GOMBE_SHA_CONSTITUENCIES,
  GOMBE_SHA_LGA_SEAT_COUNTS,
  validateGombeShaRoster,
  type GombeShaSeat,
} from '../../../db/prisma/gombe-sha-constituencies';

function cloneSeats(): GombeShaSeat[] {
  return GOMBE_SHA_CONSTITUENCIES.map((seat) => ({
    ...seat,
    aliases: [...seat.aliases],
    wards: [...seat.wards],
  }));
}

describe('Gombe SHA roster', () => {
  it('locks 24 seats including the easy-to-miss ones', () => {
    const codes = GOMBE_SHA_CONSTITUENCIES.map((seat) => seat.code);
    expect(codes).toHaveLength(24);
    expect(codes).toEqual(expect.arrayContaining(['AKKO_CENTRAL', 'DEBA', 'PERO_CHONGE']));
    const seats = Object.values(GOMBE_SHA_LGA_SEAT_COUNTS).reduce((sum, n) => sum + n, 0);
    expect(seats).toBe(24);
  });

  it('maps each seat to a unique 2023 IReV House of Assembly election id', () => {
    const ids = GOMBE_SHA_CONSTITUENCIES.map((seat) => seat.irevElectionId);
    expect(ids).toHaveLength(24);
    expect(new Set(ids).size).toBe(24);
    expect(ids.every((id) => /^[a-f0-9]{24}$/.test(id))).toBe(true);
    const deba = GOMBE_SHA_CONSTITUENCIES.find((seat) => seat.code === 'DEBA');
    expect(deba?.irevElectionId).toBe('6407cb3426d4fe6cc81c2039');
  });

  it('persists each seat IReV id onto the constituency row', () => {
    const deba = GOMBE_SHA_CONSTITUENCIES.find((seat) => seat.code === 'DEBA')!;
    expect(constituencyPersistFields(deba, 'lga-yd')).toEqual({
      name: 'Deba',
      aliases: ['Deba Constituency'],
      lgaId: 'lga-yd',
      irevElectionId: '6407cb3426d4fe6cc81c2039',
    });
  });

  it('allows partial local maps and reports leftovers', () => {
    const register = [
      { lga: 'Yamaltu/Deba', name: 'DEBA' },
      { lga: 'Yamaltu/Deba', name: 'ZAMBUK/KWALI' },
      { lga: 'Kaltungo', name: 'KALTUNGO WEST' },
    ];
    const report = validateGombeShaRoster(register, undefined, { allowPartial: true });
    expect(report.ok).toBe(true);
    expect(report.emptySeats).toContain('AKKO_CENTRAL');
    expect(report.leftovers.map((ward) => ward.name)).toContain('ZAMBUK/KWALI');
  });

  it('fails complete mode when leftovers or empty seats remain', () => {
    const register = [
      { lga: 'Yamaltu/Deba', name: 'DEBA' },
      { lga: 'Yamaltu/Deba', name: 'ZAMBUK/KWALI' },
    ];
    const report = validateGombeShaRoster(register, undefined, { allowPartial: false });
    expect(report.ok).toBe(false);
    expect(report.errors.some((error) => error.includes('Empty seats'))).toBe(true);
    expect(report.errors.some((error) => error.includes('have no seat'))).toBe(true);
  });

  it('keeps per-seat edits isolated', () => {
    const seats = cloneSeats();
    const deba = seats.find((seat) => seat.code === 'DEBA')!;
    const east = seats.find((seat) => seat.code === 'YAMALTU_EAST')!;
    const beforeEast = [...east.wards];
    deba.wards.push('ZAMBUK/KWALI');
    expect(east.wards).toEqual(beforeEast);
    expect(deba.wards).toContain('ZAMBUK/KWALI');
  });

  it('rejects a ward listed on two seats', () => {
    const seats = cloneSeats();
    const deba = seats.find((seat) => seat.code === 'DEBA')!;
    const east = seats.find((seat) => seat.code === 'YAMALTU_EAST')!;
    east.wards.push('DEBA');
    const report = validateGombeShaRoster(
      [{ lga: 'Yamaltu/Deba', name: 'DEBA' }],
      seats,
      { allowPartial: true },
    );
    expect(report.ok).toBe(false);
    expect(report.clashes[0]?.seats).toEqual(expect.arrayContaining(['DEBA', 'YAMALTU_EAST']));
    expect(deba.wards).toContain('DEBA');
  });
});
