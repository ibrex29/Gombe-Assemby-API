import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SupportGroupsService } from './support-groups.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { createMockPrismaService } from '../../../test/helpers/prisma.mock';
import {
  testJwtPayload,
  testSupportGroup,
  TEST_CAMPAIGN_ID,
  TEST_GROUP_ID,
  TEST_LGA_ID,
} from '../../../test/helpers/fixtures';

describe('SupportGroupsService', () => {
  let service: SupportGroupsService;
  let prisma: ReturnType<typeof createMockPrismaService>;

  beforeEach(async () => {
    prisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportGroupsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(SupportGroupsService);
  });

  describe('list', () => {
    it('returns support groups when user has campaign access', async () => {
      prisma.campaignMembership.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.supportGroup.findMany.mockResolvedValue([testSupportGroup]);

      const result = await service.list(testJwtPayload, { campaignId: TEST_CAMPAIGN_ID });

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Hadejia Youth Forum');
    });

    it('throws when user lacks campaign access', async () => {
      prisma.campaignMembership.findFirst.mockResolvedValue(null);

      await expect(
        service.list(testJwtPayload, { campaignId: TEST_CAMPAIGN_ID }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('create', () => {
    it('creates a support group for an authorized user', async () => {
      prisma.campaignMembership.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.campaign.findUniqueOrThrow.mockResolvedValue({
        state: { code: 'JI' },
      });
      prisma.lGA.findFirst.mockResolvedValue({ id: TEST_LGA_ID });
      prisma.supportGroup.create.mockResolvedValue(testSupportGroup);

      const result = await service.create(testJwtPayload, {
        campaignId: TEST_CAMPAIGN_ID,
        name: 'Hadejia Youth Forum',
        category: 'YOUTH',
        leaderName: 'Ibrahim Musa',
        leaderPhone: '+2348012345678',
        lgaId: TEST_LGA_ID,
      });

      expect(result.id).toBe(TEST_GROUP_ID);
      expect(prisma.supportGroup.create).toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('throws when group does not exist', async () => {
      prisma.supportGroup.findUnique.mockResolvedValue(null);

      await expect(service.findOne(testJwtPayload, 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('deletes an existing group', async () => {
      prisma.supportGroup.findUnique.mockResolvedValue(testSupportGroup);
      prisma.campaignMembership.findFirst.mockResolvedValue({ id: 'mem-1' });
      prisma.supportGroup.delete.mockResolvedValue(testSupportGroup);

      const result = await service.remove(testJwtPayload, TEST_GROUP_ID);

      expect(result.success).toBe(true);
      expect(prisma.supportGroup.delete).toHaveBeenCalledWith({ where: { id: TEST_GROUP_ID } });
    });
  });
});
