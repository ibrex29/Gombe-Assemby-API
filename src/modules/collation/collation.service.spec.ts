import { CampaignRole, CollationLevel, ScopeType } from '@electromon/shared';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CollationService } from './collation.service';
import { CollationBrowseService } from './collation-browse.service';
import { CollationReadinessService } from './collation-readiness.service';
import { SituationRoomService } from '../situation-room/situation-room.service';
import { Ec8aPhotoReaderService } from './ec8a-photo-reader.service';
import { OcrQueueService } from './ocr-queue.service';
import { ScopeResolverService } from '../../common/collation/scope-resolver.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContestService } from '../../common/contest/contest.service';
import { createMockPrismaService } from '../../../test/helpers/prisma.mock';
import { createMockContestService } from '../../../test/helpers/contest.mock';
import { TEST_CAMPAIGN_ID, testJwtPayload } from '../../../test/helpers/fixtures';

describe('CollationService listResults (LGA rollups)', () => {
  let service: CollationService;
  let prisma: ReturnType<typeof createMockPrismaService> & Record<string, unknown>;

  const nationalDirector = {
    ...testJwtPayload,
    role: CampaignRole.CAMPAIGN_DIRECTOR,
    scopeType: ScopeType.CAMPAIGN,
    scopeId: TEST_CAMPAIGN_ID,
  };

  const lgaAlimosho = {
    id: 'lga-alimosho',
    name: 'ALIMOSHO',
    state: { name: 'LAGOS', code: 'LA', zone: 'South West' },
  };

  const lgaAgege = {
    id: 'lga-agege',
    name: 'AGEGE',
    state: { name: 'LAGOS', code: 'LA', zone: 'South West' },
  };

  const baseRow = {
    id: 'result-1',
    campaignId: TEST_CAMPAIGN_ID,
    level: CollationLevel.LGA,
    scopeType: ScopeType.LGA,
    scopeId: 'lga-alimosho',
    status: 'APPROVED',
    partyResults: { APC: 1200, PDP: 800 },
    registeredVoters: 10000,
    votesCast: 2100,
    accreditedVoters: 2200,
    updatedAt: new Date('2026-03-01T12:00:00Z'),
    submittedAt: new Date('2026-03-01T10:00:00Z'),
    submittedBy: null,
    approvedBy: null,
  };

  beforeEach(async () => {
    prisma = createMockPrismaService() as ReturnType<typeof createMockPrismaService> &
      Record<string, unknown>;
    prisma.lGA = {
      ...prisma.lGA,
      findMany: jest.fn(),
      groupBy: jest.fn(),
    };
    prisma.state = {
      findMany: jest.fn(),
    };
    prisma.collationResult = {
      ...prisma.collationResult,
      findMany: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        CollationService,
        { provide: PrismaService, useValue: prisma },
        { provide: ContestService, useValue: createMockContestService() },
        { provide: ScopeResolverService, useValue: { resolveScopeChain: jest.fn() } },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: OcrQueueService, useValue: {} },
        { provide: Ec8aPhotoReaderService, useValue: {} },
        { provide: CollationBrowseService, useValue: {} },
        { provide: CollationReadinessService, useValue: {} },
        { provide: SituationRoomService, useValue: { ingestInferredPulse: jest.fn() } },
      ],
    }).compile();

    service = module.get(CollationService);

    prisma.campaign.findUniqueOrThrow.mockResolvedValue({
      clientPartyCode: 'APC',
      trackedParties: [
        { code: 'APC', name: 'APC' },
        { code: 'PDP', name: 'PDP' },
      ],
    });
  });

  it('returns state rollups by default for national directors', async () => {
    prisma.state.findMany.mockResolvedValueOnce([
      { id: 'state-la', name: 'LAGOS', code: 'LA', zone: 'South West' },
      { id: 'state-ab', name: 'ABIA', code: 'AB', zone: 'South East' },
    ]);
    prisma.collationResult.findMany.mockResolvedValueOnce([
      {
        ...baseRow,
        id: 'result-la',
        scopeId: 'state-la',
        level: CollationLevel.STATE,
        scopeType: ScopeType.STATE,
      },
    ]);
    prisma.lGA.groupBy.mockResolvedValueOnce([
      { stateId: 'state-la', _count: { id: 20 } },
      { stateId: 'state-ab', _count: { id: 17 } },
    ]);

    const rows = await service.listResults(nationalDirector);

    expect(prisma.state.findMany).toHaveBeenCalled();
    expect(prisma.lGA.findMany).not.toHaveBeenCalled();
    expect(rows).toHaveLength(2);
    expect(rows[0].scopeName).toBe('ABIA');
    expect(rows[0].status).toBe('NOT_STARTED');
    expect(rows[0].areaCount).toBe(17);
    expect(rows[1].scopeName).toBe('LAGOS');
    expect(rows[1].level).toBe(CollationLevel.STATE);
  });

  it('filters LGAs by stateId and includes NOT_STARTED rows', async () => {
    prisma.lGA.findMany.mockResolvedValueOnce([lgaAlimosho, lgaAgege]);
    prisma.collationResult.findMany.mockResolvedValueOnce([baseRow]);

    const rows = await service.listResults(nationalDirector, { stateId: 'state-la' });

    expect(prisma.lGA.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ stateId: 'state-la' }),
      }),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].scopeName).toBe('AGEGE');
    expect(rows[0].status).toBe('NOT_STARTED');
    expect(rows[1].scopeName).toBe('ALIMOSHO');
    expect(rows[1].stateZone).toBe('South West');
  });

  it('filters states by zone with canonical labels', async () => {
    prisma.state.findMany.mockResolvedValueOnce([
      { id: 'state-la', name: 'LAGOS', code: 'LA', zone: 'South West' },
    ]);
    prisma.collationResult.findMany.mockResolvedValueOnce([]);
    prisma.lGA.groupBy.mockResolvedValueOnce([{ stateId: 'state-la', _count: { id: 20 } }]);

    await service.listResults(nationalDirector, { zone: 'South West' });

    expect(prisma.state.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ zone: 'South West' }),
      }),
    );
  });

  it('accepts underscore zone aliases from legacy URLs', async () => {
    prisma.state.findMany.mockResolvedValueOnce([
      { id: 'state-la', name: 'LAGOS', code: 'LA', zone: 'South West' },
    ]);
    prisma.collationResult.findMany.mockResolvedValueOnce([]);
    prisma.lGA.groupBy.mockResolvedValueOnce([{ stateId: 'state-la', _count: { id: 20 } }]);

    await service.listResults(nationalDirector, { zone: 'south_west' });

    expect(prisma.state.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ zone: 'South West' }),
      }),
    );
  });

  it('filters states by search on state name', async () => {
    prisma.state.findMany.mockResolvedValueOnce([
      { id: 'state-la', name: 'LAGOS', code: 'LA', zone: 'South West' },
    ]);
    prisma.collationResult.findMany.mockResolvedValueOnce([]);
    prisma.lGA.groupBy.mockResolvedValueOnce([{ stateId: 'state-la', _count: { id: 20 } }]);

    await service.listResults(nationalDirector, { search: 'lag' });

    expect(prisma.state.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          name: expect.objectContaining({ contains: 'lag' }),
        }),
      }),
    );
  });

  it('returns empty list when zone filter is invalid', async () => {
    const rows = await service.listResults(nationalDirector, { zone: 'Invalid Zone' });
    expect(rows).toEqual([]);
    expect(prisma.state.findMany).not.toHaveBeenCalled();
  });

  it('filters by status after merging scoped states', async () => {
    prisma.state.findMany.mockResolvedValueOnce([
      { id: 'state-la', name: 'LAGOS', code: 'LA', zone: 'South West' },
      { id: 'state-ab', name: 'ABIA', code: 'AB', zone: 'South East' },
    ]);
    prisma.collationResult.findMany.mockResolvedValueOnce([
      { ...baseRow, id: 'result-la', scopeId: 'state-la', level: CollationLevel.STATE, scopeType: ScopeType.STATE, status: 'SUBMITTED' },
    ]);
    prisma.lGA.groupBy.mockResolvedValueOnce([
      { stateId: 'state-la', _count: { id: 20 } },
      { stateId: 'state-ab', _count: { id: 17 } },
    ]);

    const rows = await service.listResults(nationalDirector, { status: 'SUBMITTED' });

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('SUBMITTED');
  });

  it('sorts LGAs by total votes descending when a state is selected', async () => {
    const lowTotal = {
      ...baseRow,
      id: 'result-low',
      scopeId: 'lga-agege',
      partyResults: { APC: 100, PDP: 50 },
      votesCast: 150,
    };
    const highTotal = {
      ...baseRow,
      id: 'result-high',
      scopeId: 'lga-alimosho',
      partyResults: { APC: 5000, PDP: 1000 },
      votesCast: 6000,
    };

    prisma.lGA.findMany.mockResolvedValueOnce([lgaAlimosho, lgaAgege]);
    prisma.collationResult.findMany.mockResolvedValueOnce([lowTotal, highTotal]);

    const rows = await service.listResults(nationalDirector, { stateId: 'state-la', sort: 'total' });

    expect(rows.map((r) => r.scopeName)).toEqual(['ALIMOSHO', 'AGEGE']);
    expect(rows[0].leadingParty).toBe('APC');
    expect(rows[0].outcome).toBe('WIN');
    expect(rows[0].totalVotes).toBe(6000);
    expect(rows[0].turnoutPercent).toBeGreaterThan(0);
  });
});
