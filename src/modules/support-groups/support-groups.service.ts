import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@electromon/db';
import { JwtPayload } from '@electromon/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  CreateSupportGroupDto,
  ListSupportGroupsQueryDto,
  UpdateSupportGroupDto,
} from './dto/support-group.dto';

@Injectable()
export class SupportGroupsService {
  constructor(private prisma: PrismaService) {}

  private readonly include = {
    lga: { select: { id: true, name: true } },
  } as const;

  private async assertCampaignAccess(userId: string, campaignId: string) {
    const membership = await this.prisma.campaignMembership.findFirst({
      where: { userId, campaignId, isActive: true },
    });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this campaign');
    }
    return membership;
  }

  async list(user: JwtPayload, query: ListSupportGroupsQueryDto) {
    await this.assertCampaignAccess(user.sub, query.campaignId);

    const where: Prisma.SupportGroupWhereInput = {
      campaignId: query.campaignId,
      ...(query.category && { category: query.category }),
      ...(query.verificationStatus && { verificationStatus: query.verificationStatus }),
      ...(query.lgaId && { lgaId: query.lgaId }),
      ...(query.search && {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { leaderName: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };

    return this.prisma.supportGroup.findMany({
      where,
      include: this.include,
      orderBy: [{ updatedAt: 'desc' }],
    });
  }

  async findOne(user: JwtPayload, id: string) {
    const group = await this.prisma.supportGroup.findUnique({
      where: { id },
      include: this.include,
    });
    if (!group) {
      throw new NotFoundException('Support group not found');
    }
    await this.assertCampaignAccess(user.sub, group.campaignId);
    return group;
  }

  async create(user: JwtPayload, dto: CreateSupportGroupDto) {
    await this.assertCampaignAccess(user.sub, dto.campaignId);

    if (dto.lgaId) {
      await this.assertLgaInCampaign(dto.campaignId, dto.lgaId);
    }

    return this.prisma.supportGroup.create({
      data: {
        campaignId: dto.campaignId,
        name: dto.name,
        category: dto.category,
        leaderName: dto.leaderName,
        leaderPhone: dto.leaderPhone,
        leaderEmail: dto.leaderEmail,
        memberCount: dto.memberCount ?? 0,
        lgaId: dto.lgaId,
        areaOfOperation: dto.areaOfOperation,
      },
      include: this.include,
    });
  }

  async update(user: JwtPayload, id: string, dto: UpdateSupportGroupDto) {
    const existing = await this.findOne(user, id);

    if (dto.campaignId && dto.campaignId !== existing.campaignId) {
      throw new ForbiddenException('Cannot move group to another campaign');
    }

    if (dto.lgaId) {
      await this.assertLgaInCampaign(existing.campaignId, dto.lgaId);
    }

    const { campaignId: _campaignId, ...data } = dto;

    return this.prisma.supportGroup.update({
      where: { id },
      data,
      include: this.include,
    });
  }

  async remove(user: JwtPayload, id: string) {
    await this.findOne(user, id);
    await this.prisma.supportGroup.delete({ where: { id } });
    return { success: true, message: 'Support group deleted' };
  }

  private async assertLgaInCampaign(campaignId: string, lgaId: string) {
    const campaign = await this.prisma.campaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: { stateId: true, isNational: true },
    });

    const lga = await this.prisma.lGA.findFirst({
      where: campaign.isNational ? { id: lgaId } : { id: lgaId, stateId: campaign.stateId },
    });
    if (!lga) {
      throw new NotFoundException('LGA not found in campaign geography');
    }
  }
}
