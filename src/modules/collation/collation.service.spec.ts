import { CampaignRole, CollationLevel, CollationResultStatus, ScopeType } from '@electromon/shared';
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
import {
  createMockContestService,
  TEST_ASSEMBLY_CONTEST_ID,
  TEST_CONTEST_ID,
  testAssemblyContest,
  testContest,
} from '../../../test/helpers/contest.mock';
import {
  TEST_CAMPAIGN_ID,
  TEST_LGA_ID,
  TEST_PU_ID,
  TEST_WARD_ID,
  testJwtPayload,
} from '../../../test/helpers/fixtures';

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

describe('CollationService dual-contest ward queue', () => {
  let service: CollationService;
  let prisma: ReturnType<typeof createMockPrismaService> & Record<string, any>;
  let contests: ReturnType<typeof createMockContestService>;

  const wardOfficer = {
    ...testJwtPayload,
    role: CampaignRole.WARD_RA_OFFICER,
    scopeType: ScopeType.WARD,
    scopeId: TEST_WARD_ID,
  };

  const pu = { id: TEST_PU_ID, code: 'GO-001', name: 'Central PU', wardId: TEST_WARD_ID };

  const govRow = {
    id: 'result-gov',
    campaignId: TEST_CAMPAIGN_ID,
    contestId: TEST_CONTEST_ID,
    level: CollationLevel.POLLING_UNIT,
    scopeType: ScopeType.POLLING_UNIT,
    scopeId: TEST_PU_ID,
    status: CollationResultStatus.SUBMITTED,
    partyResults: { APC: 40, PDP: 20 },
    registeredVoters: 200,
    accreditedVoters: 80,
    votesCast: 60,
    invalidVotes: 2,
    usedBallotPapers: 62,
    ballotPapersIssued: 80,
    unusedBallotPapers: 18,
    spoiledBallotPapers: 0,
    ec8aPhotoUrls: ['/uploads/gov.jpg'],
    submittedBy: null,
    approvedBy: null,
    contest: testContest,
  };

  const shaRow = {
    ...govRow,
    id: 'result-sha',
    contestId: TEST_ASSEMBLY_CONTEST_ID,
    status: CollationResultStatus.APPROVED,
    partyResults: { APC: 35, PDP: 22 },
    contest: testAssemblyContest,
  };

  beforeEach(async () => {
    prisma = createMockPrismaService() as ReturnType<typeof createMockPrismaService> &
      Record<string, any>;
    contests = createMockContestService();
    prisma.collationResult = {
      ...prisma.collationResult,
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    };
    prisma.collationActionLog = { create: jest.fn().mockResolvedValue({ id: 'log-1' }) };
    prisma.ward = {
      ...prisma.ward,
      findMany: jest.fn().mockResolvedValue([{ id: TEST_WARD_ID }]),
      findUnique: jest.fn().mockResolvedValue({
        lgaId: TEST_LGA_ID,
        lga: { stateId: 'state-go' },
      }),
    };
    prisma.lGA = {
      ...prisma.lGA,
      findMany: jest.fn().mockResolvedValue([{ id: TEST_LGA_ID }]),
      findUnique: jest.fn().mockResolvedValue({ stateId: 'state-go' }),
    };
    prisma.pollingUnit.findMany = jest.fn().mockResolvedValue([pu]);
    prisma.pollingUnit.findUnique = jest.fn().mockResolvedValue({
      wardId: TEST_WARD_ID,
      ward: { lgaId: TEST_LGA_ID, lga: { stateId: 'state-go' } },
    });

    const module = await Test.createTestingModule({
      providers: [
        CollationService,
        { provide: PrismaService, useValue: prisma },
        { provide: ContestService, useValue: contests },
        { provide: ScopeResolverService, useValue: { resolveScopeChain: jest.fn() } },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: OcrQueueService, useValue: {} },
        { provide: Ec8aPhotoReaderService, useValue: {} },
        {
          provide: CollationBrowseService,
          useValue: { invalidateNationalSituationCaches: jest.fn() },
        },
        { provide: CollationReadinessService, useValue: {} },
        { provide: SituationRoomService, useValue: { ingestInferredPulse: jest.fn() } },
      ],
    }).compile();

    service = module.get(CollationService);
  });

  function mockWardQueueQueries() {
    prisma.collationResult.findMany.mockImplementation(async (args: { where?: any; select?: any }) => {
      const level = args?.where?.level;
      if (level === CollationLevel.POLLING_UNIT && args.select) {
        return [
          { scopeId: TEST_PU_ID, contestId: TEST_CONTEST_ID, status: CollationResultStatus.SUBMITTED },
          {
            scopeId: TEST_PU_ID,
            contestId: TEST_ASSEMBLY_CONTEST_ID,
            status: CollationResultStatus.APPROVED,
          },
        ];
      }
      if (level === CollationLevel.POLLING_UNIT) {
        return [govRow, shaRow];
      }
      if (level === CollationLevel.WARD) {
        return [];
      }
      return [];
    });
  }

  it('groups governorship and assembly sheets per PU when contest is omitted', async () => {
    mockWardQueueQueries();

    const payload = await service.listWardPuSubmissions(wardOfficer, { allContests: true });

    expect(payload.grouped).toBe(true);
    expect(payload.data).toHaveLength(1);
    const row = payload.data[0] as {
      pollingUnit: { id: string };
      status: string;
      contests: Array<{ contest: { slug: string }; id: string; status: string }>;
    };
    expect(row.pollingUnit.id).toBe(TEST_PU_ID);
    expect(row.status).toBe(CollationResultStatus.SUBMITTED);
    expect(row.contests.map((sheet) => sheet.contest.slug)).toEqual(['governorship', 'assembly']);
    expect(row.contests.map((sheet) => sheet.status)).toEqual([
      CollationResultStatus.SUBMITTED,
      CollationResultStatus.APPROVED,
    ]);
    expect(payload.contestStatusCounts.governorship.submitted).toBe(1);
    expect(payload.contestStatusCounts.assembly.approved).toBe(1);
    expect(payload.statusCounts.submitted).toBe(1);
  });

  it('keeps a flat single-contest list when contest is explicit', async () => {
    contests.explicit.mockReturnValue(true);
    mockWardQueueQueries();

    const payload = await service.listWardPuSubmissions(wardOfficer, { allContests: false });

    expect(payload.grouped).toBe(false);
    expect(payload.data).toHaveLength(1);
    const row = payload.data[0] as { id: string; contestId: string; contests?: unknown };
    expect(row.id).toBe('result-gov');
    expect(row.contestId).toBe(TEST_CONTEST_ID);
    expect(row.contests).toBeUndefined();
  });

  it('keeps a PU when any contest matches the status filter', async () => {
    mockWardQueueQueries();

    const payload = await service.listWardPuSubmissions(wardOfficer, {
      allContests: true,
      status: CollationResultStatus.SUBMITTED,
    });

    expect(payload.data).toHaveLength(1);
    const row = payload.data[0] as {
      contests: Array<{ status: string }>;
    };
    expect(row.contests).toHaveLength(2);
  });

  it('rolls up the approved result contest, not the interceptor default', async () => {
    prisma.collationResult.findUniqueOrThrow.mockResolvedValue({
      ...shaRow,
      status: CollationResultStatus.SUBMITTED,
    });
    prisma.collationResult.update.mockResolvedValue({
      ...shaRow,
      status: CollationResultStatus.APPROVED,
      approvedById: wardOfficer.sub,
      approvedAt: new Date(),
    });
    prisma.collationResult.findMany.mockResolvedValue([
      { ...shaRow, status: CollationResultStatus.APPROVED },
    ]);
    prisma.collationResult.findUnique.mockResolvedValue({
      id: 'ward-sha',
      contestId: TEST_ASSEMBLY_CONTEST_ID,
      status: CollationResultStatus.APPROVED,
      flaggedPollingUnitIds: [],
      flaggedWardIds: [],
    });
    prisma.collationResult.upsert.mockImplementation(async ({ create }: { create: unknown }) => create);

    await service.approveResult(wardOfficer, 'result-sha', {});

    const upsertContestIds = prisma.collationResult.upsert.mock.calls.map(
      (call: [{ create: { contestId: string } }]) => call[0].create.contestId,
    );
    expect(upsertContestIds.length).toBeGreaterThan(0);
    expect(upsertContestIds.every((id: string) => id === TEST_ASSEMBLY_CONTEST_ID)).toBe(true);
    expect(upsertContestIds).not.toContain(TEST_CONTEST_ID);
  });
});
