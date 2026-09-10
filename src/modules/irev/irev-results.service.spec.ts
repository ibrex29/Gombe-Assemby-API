import { CampaignRole } from '@electromon/shared';
import { IrevResultsService } from './irev-results.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DeploymentScopeService } from '../../common/deployment-scope/deployment-scope.service';
import { IrevOfficialStatsService } from './irev-official-stats.service';
import { IrevClient } from './irev.client';

describe('IrevResultsService', () => {
  const campaignId = 'campaign-1';
  const nationalDirector = {
    sub: 'user-1',
    role: CampaignRole.CAMPAIGN_DIRECTOR,
    campaignId,
    scopeType: null,
    scopeId: null,
  };

  function createService() {
    const prisma = {
      campaign: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          stateId: 'state-go',
          clientPartyCode: 'APC',
          trackedParties: [
            { code: 'APC', name: 'All Progressives Congress' },
            { code: 'PDP', name: 'Peoples Democratic Party' },
          ],
        }),
      },
      stateAssemblyConstituency: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'seat-deba',
            name: 'Deba',
            code: 'DEBA',
            lga: { name: 'Yamaltu/Deba' },
            state: { name: 'Gombe', code: 'GO', zone: 'North East' },
            wards: [{ id: 'ward-deba' }],
          },
        ]),
      },
      state: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'state-la', name: 'Lagos', code: 'LA', zone: 'South West' },
        ]),
      },
      lGA: {
        findMany: jest.fn(),
        groupBy: jest.fn().mockResolvedValue([{ stateId: 'state-la', _count: { id: 20 } }]),
      },
      $queryRaw: jest.fn(),
    } as unknown as PrismaService;

    const deploymentScope = {
      lockedStateId: jest.fn().mockReturnValue(undefined),
      lockedStateName: jest.fn().mockReturnValue(undefined),
      irevElectionId: jest.fn().mockReturnValue(undefined),
      irevElectionLabel: jest.fn().mockReturnValue(undefined),
      irevElectionType: jest.fn().mockReturnValue('PRESIDENTIAL'),
      irevPortalStateInecId: jest.fn().mockReturnValue(undefined),
      isGovernorshipElection: jest.fn().mockReturnValue(false),
      resolveClientPartyCode: jest.fn((code?: string | null) => code ?? 'APC'),
    } as unknown as DeploymentScopeService;

    const officialStats = {
      getStateOfficialStats: jest.fn().mockResolvedValue(null),
    } as unknown as IrevOfficialStatsService;

    const irevClient = {
      defaultElectionId: jest.fn().mockReturnValue(null),
    } as unknown as IrevClient;

    const contests = {
      id: jest.fn().mockReturnValue('contest-assembly'),
      seat: jest.fn().mockReturnValue(null),
      current: jest.fn().mockReturnValue(null),
    };

    const irevElections = {
      forSeat: jest.fn().mockReturnValue(null),
    };

    return {
      service: new IrevResultsService(
        prisma,
        deploymentScope,
        officialStats,
        irevClient,
        contests as never,
        irevElections as never,
      ),
      prisma,
    };
  }

  it('lists assembly seats from IReV OCR aggregates', async () => {
    const { service, prisma } = createService();

    (prisma.$queryRaw as jest.Mock)
      .mockResolvedValueOnce([
        {
          scopeId: 'seat-deba',
          scopeName: 'Deba',
          stateCode: 'GO',
          stateZone: 'North East',
          stateName: 'Gombe',
          totalPus: 12,
          publishedPus: 2,
          readablePus: 2,
          failedPus: 0,
          pendingOcrPus: 0,
        },
      ])
      .mockResolvedValueOnce([
        {
          scopeId: 'seat-deba',
          ocrExtract: {
            partyResults: { APC: 600, PDP: 400 },
            fields: { registeredVoters: 2000, votesCast: 1000 },
          },
        },
      ]);

    const rows = await service.listResults(nationalDirector);
    expect(rows).toHaveLength(1);
    expect(rows[0].scopeName).toBe('Deba');
    expect(rows[0].status).toBe('APPROVED');
    expect(rows[0].partyResults?.APC).toBe(600);
    expect(rows[0].totalVotes).toBe(1000);
    expect(rows[0].leadingParty).toBe('APC');
  });

  it('marks unpublished seats as NOT_STARTED', async () => {
    const { service, prisma } = createService();

    (prisma.$queryRaw as jest.Mock)
      .mockResolvedValueOnce([
        {
          scopeId: 'seat-deba',
          scopeName: 'Deba',
          stateCode: 'GO',
          stateZone: 'North East',
          stateName: 'Gombe',
          totalPus: 12,
          publishedPus: 0,
          readablePus: 0,
          failedPus: 0,
          pendingOcrPus: 0,
        },
      ])
      .mockResolvedValueOnce([]);

    const rows = await service.listResults(nationalDirector);
    expect(rows[0].status).toBe('NOT_STARTED');
    expect(rows[0].totalVotes).toBe(0);
  });
});
