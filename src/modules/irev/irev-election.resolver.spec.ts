import { ContestType } from '@electromon/shared';
import { IrevElectionResolver } from './irev-election.resolver';

const assembly = {
  id: 'contest-assembly',
  campaignId: 'campaign-1',
  type: ContestType.ASSEMBLY,
  slug: 'assembly',
  label: 'Assembly',
  irevElectionId: '6407d9bfce35006e92156f2e',
  irevElectionLabel: 'Gombe State House of Assembly Election',
  isDefault: false,
};

const governorship = {
  ...assembly,
  id: 'contest-gov',
  type: ContestType.GOVERNORSHIP,
  slug: 'governorship',
  label: 'Governorship',
  irevElectionId: '6407d9bfce35006e92156f2e',
  isDefault: true,
};

const debaSeat = {
  id: 'seat-deba',
  code: 'DEBA',
  name: 'Deba',
  lgaId: 'lga-yd',
  lgaName: 'Yamaltu/Deba',
  wardIds: ['ward-deba'],
  wards: [{ id: 'ward-deba', name: 'DEBA' }],
  irevElectionId: '6407cb3426d4fe6cc81c2039',
};

describe('IrevElectionResolver', () => {
  const prisma = {
    ward: { findUnique: jest.fn() },
  };
  const contests = { seat: jest.fn().mockReturnValue(null) };
  const deploymentScope = {
    irevElectionId: jest.fn().mockReturnValue('6407d9bfce35006e92156f2e'),
  };

  let resolver: IrevElectionResolver;

  beforeEach(() => {
    jest.resetAllMocks();
    deploymentScope.irevElectionId.mockReturnValue('6407d9bfce35006e92156f2e');
    contests.seat.mockReturnValue(null);
    resolver = new IrevElectionResolver(
      prisma as never,
      contests as never,
      deploymentScope as never,
    );
  });

  it('uses the contest / env ID for governorship', () => {
    expect(resolver.forContest(governorship)).toBe('6407d9bfce35006e92156f2e');
    expect(resolver.forSeat(governorship, null)).toBe('6407d9bfce35006e92156f2e');
  });

  it('never treats Assembly as a single statewide IReV election', () => {
    expect(resolver.forContest(assembly)).toBeNull();
    expect(resolver.forSeat(assembly, null)).toBeNull();
    expect(resolver.configElectionId(assembly)).toBe('per-seat');
  });

  it('resolves Deba from the seat row', () => {
    expect(resolver.forSeat(assembly, debaSeat)).toBe('6407cb3426d4fe6cc81c2039');
  });

  it('resolves Deba from the PU ward constituency', async () => {
    prisma.ward.findUnique.mockResolvedValue({
      constituency: { irevElectionId: '6407cb3426d4fe6cc81c2039' },
    });
    await expect(resolver.forWard(assembly, 'ward-deba')).resolves.toBe(
      '6407cb3426d4fe6cc81c2039',
    );
  });

  it('does not fall back to the governorship ID for an unassigned assembly ward', async () => {
    prisma.ward.findUnique.mockResolvedValue({ constituency: null });
    await expect(resolver.forWard(assembly, 'ward-unassigned')).resolves.toBeNull();
    expect(deploymentScope.irevElectionId).not.toHaveBeenCalled();
  });
});
