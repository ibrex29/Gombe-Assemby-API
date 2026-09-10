import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsService } from './analytics.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { createMockPrismaService } from '../../../test/helpers/prisma.mock';
import { testJwtPayload, TEST_CAMPAIGN_ID } from '../../../test/helpers/fixtures';

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let prisma: ReturnType<typeof createMockPrismaService>;

  beforeEach(async () => {
    prisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(AnalyticsService);
  });

  it('returns aggregated overview for authorized campaign member', async () => {
    prisma.campaignMembership.findFirst.mockResolvedValue({ id: 'mem-1' });
    prisma.campaign.findUniqueOrThrow.mockResolvedValue({
      stateId: 'state-ji',
      state: { name: 'Jigawa' },
    });

    prisma.supportGroup.count.mockResolvedValueOnce(3).mockResolvedValueOnce(2);
    prisma.volunteer.count.mockResolvedValueOnce(5).mockResolvedValueOnce(3);
    prisma.commitment.count
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    prisma.commitment.aggregate.mockResolvedValue({
      _sum: { targetValue: 1000, currentValue: 250 },
    });
    prisma.pollingUnit.count
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    prisma.fieldReport.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    prisma.situationUpdate.count
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    prisma.volunteer.findMany.mockResolvedValue([
      {
        id: 'v1',
        firstName: 'Amina',
        lastName: 'Yusuf',
        role: 'CANVASSER',
        performanceScore: 88,
      },
    ]);
    prisma.fieldReport.findMany.mockResolvedValue([]);
    prisma.situationUpdate.findMany.mockResolvedValue([]);
    prisma.commitment.findMany.mockResolvedValue([]);
    prisma.lGA.findMany.mockResolvedValue([
      { id: 'lga-1', name: 'Hadejia', _count: { wards: 1 } },
    ]);
    prisma.pollingUnit.count.mockResolvedValue(3);
    prisma.volunteer.count.mockResolvedValue(2);

    const result = await service.getOverview(testJwtPayload, TEST_CAMPAIGN_ID);

    expect(result.state).toBe('Jigawa');
    expect(result.counts.supportGroups).toBe(3);
    expect(result.counts.volunteers).toBe(5);
    expect(result.commitmentProgress.percent).toBe(25);
    expect(result.topVolunteers).toHaveLength(1);
  });
});
