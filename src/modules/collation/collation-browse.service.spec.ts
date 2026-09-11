import { ForbiddenException } from '@nestjs/common';
import { CampaignRole, ScopeType } from '@electromon/shared';
import { Test } from '@nestjs/testing';
import { CollationBrowseService } from './collation-browse.service';
import { CollationReadinessService } from './collation-readiness.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContestService } from '../../common/contest/contest.service';
import { DeploymentScopeService } from '../../common/deployment-scope/deployment-scope.service';
import { RedisService } from '../../common/redis/redis.service';
import { createMockContestService } from '../../../test/helpers/contest.mock';
import { PulseGeoService } from '../situation-room/pulse-geo.service';
import { createMockPrismaService } from '../../../test/helpers/prisma.mock';
import { TEST_CAMPAIGN_ID, testJwtPayload } from '../../../test/helpers/fixtures';

describe('CollationBrowseService browse rollups', () => {
  let service: CollationBrowseService;
  let prisma: ReturnType<typeof createMockPrismaService> & Record<string, unknown>;

  const nationalDirector = {
    ...testJwtPayload,
    role: CampaignRole.CAMPAIGN_DIRECTOR,
    scopeType: ScopeType.CAMPAIGN,
    scopeId: TEST_CAMPAIGN_ID,
  };

  beforeEach(async () => {
    prisma = createMockPrismaService() as ReturnType<typeof createMockPrismaService> &
      Record<string, unknown>;
    prisma.state = {
      count: jest.fn(),
      findMany: jest.fn(),
    };
    prisma.lGA = {
      ...prisma.lGA,
      count: jest.fn(),
      findMany: jest.fn(),
      groupBy: jest.fn(),
    };
    prisma.ward = {
      ...prisma.ward,
      count: jest.fn(),
      findMany: jest.fn(),
      groupBy: jest.fn(),
    };
    prisma.collationResult = {
      ...prisma.collationResult,
      findMany: jest.fn(),
      findFirst: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        CollationBrowseService,
        { provide: PrismaService, useValue: prisma },
        { provide: ContestService, useValue: createMockContestService() },
        {
          provide: DeploymentScopeService,
          useValue: {
            applyToBrowseContext: (value: unknown) => value,
            resolveClientPartyCode: (code: string | null) => code,
            stateWhere: () => ({}),
            isStateLocked: () => false,
            clampStateId: (id?: string) => id,
          },
        },
        {
          provide: CollationReadinessService,
          useValue: { loadApprovalPipelineByState: jest.fn() },
        },
        { provide: RedisService, useValue: { getJson: jest.fn(), setJson: jest.fn(), del: jest.fn() } },
        { provide: PulseGeoService, useValue: { fieldsByState: jest.fn() } },
      ],
    }).compile();

    service = module.get(CollationBrowseService);

    prisma.campaign.findUniqueOrThrow.mockResolvedValue({
      id: TEST_CAMPAIGN_ID,
      name: 'N4A',
      isNational: true,
      clientPartyCode: 'APC',
      trackedParties: [
        { code: 'APC', name: 'APC' },
        { code: 'PDP', name: 'PDP' },
      ],
      state: { id: 'state-fct', name: 'FCT', code: 'FC' },
    });
  });

  it('browseStates returns STATE level rows with reporting for national campaigns', async () => {
    prisma.state.count.mockResolvedValue(2);
    prisma.state.findMany.mockResolvedValue([
      { id: 'state-la', name: 'LAGOS', code: 'LA', zone: 'SOUTH_WEST' },
      { id: 'state-kn', name: 'KANO', code: 'KN', zone: 'NORTH_WEST' },
    ]);
    prisma.collationResult.findMany.mockResolvedValue([
      {
        scopeId: 'state-la',
        status: 'APPROVED',
        partyResults: { APC: 100, PDP: 80 },
      },
    ]);
    prisma.lGA.groupBy.mockResolvedValue([
      { stateId: 'state-la', _count: { id: 20 } },
      { stateId: 'state-kn', _count: { id: 44 } },
    ]);
    prisma.$queryRaw
      .mockResolvedValueOnce([
        { stateId: 'state-la', total: 1000 },
        { stateId: 'state-kn', total: 2000 },
      ])
      .mockResolvedValueOnce([
        { stateId: 'state-la', reported: 120, approved: 90, lastAt: new Date() },
        { stateId: 'state-kn', reported: 0, approved: 0, lastAt: null },
      ]);

    const result = await service.browseStates(nationalDirector, 1, 25);

    expect(result.level).toBe('STATE');
    expect(result.subtitle).toBe('States & FCT');
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({
      id: 'state-la',
      name: 'Lagos',
      code: 'LA',
      totalVotes: 180,
      resultStatus: 'APPROVED',
    });
    expect(result.data[0]?.reporting).toMatchObject({
      pollingUnitsTotal: 1000,
      pollingUnitsReported: 120,
      pollingUnitsApproved: 90,
    });
    expect(result.data[0]?.subtitle).toContain('LGAs');
  });

  it('browseStates rejects non-national campaigns', async () => {
    prisma.campaign.findUniqueOrThrow.mockResolvedValue({
      id: TEST_CAMPAIGN_ID,
      name: 'State campaign',
      isNational: false,
      clientPartyCode: 'APC',
      trackedParties: [{ code: 'APC', name: 'APC' }],
      state: { id: 'state-ji', name: 'JIGAWA', code: 'JI' },
    });

    await expect(service.browseStates(nationalDirector, 1, 25)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('browseLgas includes resultStatus and state subtitle when national', async () => {
    prisma.campaign.findUniqueOrThrow.mockResolvedValue({
      id: TEST_CAMPAIGN_ID,
      name: 'N4A',
      isNational: true,
      clientPartyCode: 'APC',
      trackedParties: [{ code: 'APC', name: 'APC' }],
      state: { id: 'state-fct', name: 'FCT', code: 'FC' },
    });
    prisma.lGA.count.mockResolvedValue(1);
    prisma.lGA.findMany.mockResolvedValue([
      {
        id: 'lga-1',
        name: 'IKEJA',
        stateId: 'state-la',
        state: { id: 'state-la', name: 'LAGOS' },
      },
    ]);
    prisma.collationResult.findMany.mockResolvedValue([
      { scopeId: 'lga-1', status: 'SUBMITTED', partyResults: { APC: 10 } },
    ]);
    prisma.ward.groupBy.mockResolvedValue([{ lgaId: 'lga-1', _count: { id: 11 } }]);
    prisma.pollingUnit.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([]);

    const result = await service.browseLgas(nationalDirector, 1, 25);

    expect(result.level).toBe('LGA');
    expect(result.data[0]).toMatchObject({
      id: 'lga-1',
      name: 'Ikeja',
      subtitle: 'Lagos',
      resultStatus: 'SUBMITTED',
    });
  });

  it('getAssemblyRaceAnalytics returns 24 constituency units', async () => {
    prisma.campaign.findUniqueOrThrow.mockResolvedValue({
      id: TEST_CAMPAIGN_ID,
      name: 'Pantamiyya',
      isNational: false,
      clientPartyCode: 'PDP',
      trackedParties: [
        { code: 'PDP', name: 'PDP' },
        { code: 'APC', name: 'APC' },
      ],
      stateId: 'state-go',
      state: { id: 'state-go', name: 'Gombe', code: 'GO' },
    });
    prisma.stateAssemblyConstituency.findMany.mockResolvedValue(
      Array.from({ length: 24 }, (_, index) => ({
        id: `seat-${index}`,
        name: `Seat ${index + 1}`,
        code: `S${index + 1}`,
        lga: { id: 'lga-1', name: 'Akko' },
        wards: [{ id: `ward-${index}` }],
      })),
    );
    prisma.collationResult.findMany.mockResolvedValue([]);
    prisma.pollingUnit.findMany.mockResolvedValue([]);

    const result = await service.getAssemblyRaceAnalytics(nationalDirector);

    expect(result.geographyLevel).toBe('CONSTITUENCY');
    expect(result.unitLabel).toBe('constituencies');
    expect(result.lgas).toHaveLength(24);
    expect(result.summary.lgaCount).toBe(24);
  });
});
