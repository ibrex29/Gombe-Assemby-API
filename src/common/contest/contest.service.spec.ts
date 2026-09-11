import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ContestType } from '@electromon/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ContestService } from './contest.service';

describe('ContestService seats', () => {
  let service: ContestService;
  const prisma = {
    campaign: { findUnique: jest.fn() },
    contest: { findFirst: jest.fn(), findMany: jest.fn(), upsert: jest.fn() },
    stateAssemblyConstituency: { findMany: jest.fn(), findFirst: jest.fn() },
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    const module = await Test.createTestingModule({
      providers: [ContestService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(ContestService);
  });

  it('resolves a Gombe SHA seat by code and lists its wards', async () => {
    prisma.campaign.findUnique.mockResolvedValue({ stateId: 'state-go' });
    prisma.stateAssemblyConstituency.findFirst.mockResolvedValue({
      id: 'seat-deba',
      code: 'DEBA',
      name: 'Deba',
      lgaId: 'lga-yd',
      irevElectionId: '6407cb3426d4fe6cc81c2039',
      lga: { id: 'lga-yd', name: 'Yamaltu/Deba' },
      wards: [{ id: 'ward-deba', name: 'DEBA' }],
    });

    const seat = await service.resolveSeat('campaign-1', 'deba');
    expect(seat).toEqual({
      id: 'seat-deba',
      code: 'DEBA',
      name: 'Deba',
      lgaId: 'lga-yd',
      lgaName: 'Yamaltu/Deba',
      wardIds: ['ward-deba'],
      wards: [{ id: 'ward-deba', name: 'DEBA' }],
      irevElectionId: '6407cb3426d4fe6cc81c2039',
    });
  });

  it('throws when the seat is not in this campaign state', async () => {
    prisma.campaign.findUnique.mockResolvedValue({ stateId: 'state-go' });
    prisma.stateAssemblyConstituency.findFirst.mockResolvedValue(null);
    await expect(service.resolveSeat('campaign-1', 'NO_SUCH_SEAT')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lookupUnlocked ignores DEFAULT_CONTEST and returns the named race', async () => {
    const previous = process.env.DEFAULT_CONTEST;
    process.env.DEFAULT_CONTEST = 'assembly';
    prisma.contest.findFirst.mockResolvedValue({
      id: 'c-gov',
      campaignId: 'campaign-1',
      type: ContestType.GOVERNORSHIP,
      slug: 'governorship',
      label: 'Governorship',
      irevElectionId: null,
      irevElectionLabel: null,
      isDefault: true,
    });

    try {
      const contest = await service.lookupUnlocked('campaign-1', 'governorship');
      expect(contest.type).toBe(ContestType.GOVERNORSHIP);
      expect(prisma.contest.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ campaignId: 'campaign-1' }),
        }),
      );
    } finally {
      if (previous === undefined) delete process.env.DEFAULT_CONTEST;
      else process.env.DEFAULT_CONTEST = previous;
    }
  });

  it('resolve stays locked to DEFAULT_CONTEST even when another race is requested', async () => {
    const previous = process.env.DEFAULT_CONTEST;
    process.env.DEFAULT_CONTEST = 'assembly';
    prisma.contest.findFirst.mockResolvedValue({
      id: 'c-assembly',
      campaignId: 'campaign-1',
      type: ContestType.ASSEMBLY,
      slug: 'assembly',
      label: 'State House of Assembly',
      irevElectionId: null,
      irevElectionLabel: null,
      isDefault: false,
    });

    try {
      const contest = await service.resolve('campaign-1', 'governorship');
      expect(contest.type).toBe(ContestType.ASSEMBLY);
      expect(prisma.contest.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([{ type: ContestType.ASSEMBLY }]),
          }),
        }),
      );
    } finally {
      if (previous === undefined) delete process.env.DEFAULT_CONTEST;
      else process.env.DEFAULT_CONTEST = previous;
    }
  });

  it('exposes the resolved seat on the request store', () => {
    const contest = {
      id: 'c-assembly',
      campaignId: 'campaign-1',
      type: ContestType.ASSEMBLY,
      slug: 'assembly',
      label: 'Assembly',
      irevElectionId: null,
      irevElectionLabel: null,
      isDefault: false,
    };
    const seat = {
      id: 'seat-deba',
      code: 'DEBA',
      name: 'Deba',
      lgaId: 'lga-yd',
      lgaName: 'Yamaltu/Deba',
      wardIds: ['ward-deba'],
      wards: [{ id: 'ward-deba', name: 'DEBA' }],
      irevElectionId: '6407cb3426d4fe6cc81c2039',
    };
    const seen = service.run(contest, seat, () => service.seat());
    expect(seen?.code).toBe('DEBA');
  });
});
