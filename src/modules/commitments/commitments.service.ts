import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CommitmentStatus, Prisma } from '@electromon/db';
import { JwtPayload } from '@electromon/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  CreateCommitmentDto,
  ListCommitmentsQueryDto,
  UpdateCommitmentDto,
} from './dto/commitment.dto';

@Injectable()
export class CommitmentsService {
  constructor(private prisma: PrismaService) {}

  private readonly include = {
    supportGroup: { select: { id: true, name: true } },
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

  private async assertSupportGroupInCampaign(campaignId: string, supportGroupId: string) {
    const group = await this.prisma.supportGroup.findFirst({
      where: { id: supportGroupId, campaignId },
    });
    if (!group) {
      throw new NotFoundException('Support group not found in this campaign');
    }
    return group;
  }

  async list(user: JwtPayload, query: ListCommitmentsQueryDto) {
    await this.assertCampaignAccess(user.sub, query.campaignId);

    const where: Prisma.CommitmentWhereInput = {
      campaignId: query.campaignId,
      ...(query.status && { status: query.status }),
      ...(query.supportGroupId && { supportGroupId: query.supportGroupId }),
      ...(query.search && {
        OR: [
          { title: { contains: query.search, mode: 'insensitive' } },
          { description: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };

    return this.prisma.commitment.findMany({
      where,
      include: this.include,
      orderBy: [{ deadline: 'asc' }, { updatedAt: 'desc' }],
    });
  }

  async findOne(user: JwtPayload, id: string) {
    const commitment = await this.prisma.commitment.findUnique({
      where: { id },
      include: this.include,
    });
    if (!commitment) {
      throw new NotFoundException('Commitment not found');
    }
    await this.assertCampaignAccess(user.sub, commitment.campaignId);
    return commitment;
  }

  async create(user: JwtPayload, dto: CreateCommitmentDto) {
    await this.assertCampaignAccess(user.sub, dto.campaignId);
    await this.assertSupportGroupInCampaign(dto.campaignId, dto.supportGroupId);

    const currentValue = dto.currentValue ?? 0;
    if (currentValue > dto.targetValue) {
      throw new BadRequestException('Current value cannot exceed target value');
    }

    return this.prisma.commitment.create({
      data: {
        campaignId: dto.campaignId,
        supportGroupId: dto.supportGroupId,
        title: dto.title,
        description: dto.description,
        targetValue: dto.targetValue,
        currentValue,
        deadline: new Date(dto.deadline),
        status: dto.status ?? CommitmentStatus.DRAFT,
      },
      include: this.include,
    });
  }

  async update(user: JwtPayload, id: string, dto: UpdateCommitmentDto) {
    const existing = await this.findOne(user, id);

    if (dto.campaignId && dto.campaignId !== existing.campaignId) {
      throw new ForbiddenException('Cannot move commitment to another campaign');
    }

    const supportGroupId = dto.supportGroupId ?? existing.supportGroupId;
    if (dto.supportGroupId) {
      await this.assertSupportGroupInCampaign(existing.campaignId, supportGroupId);
    }

    const targetValue = dto.targetValue ?? existing.targetValue;
    const currentValue = dto.currentValue ?? existing.currentValue;
    if (currentValue > targetValue) {
      throw new BadRequestException('Current value cannot exceed target value');
    }

    const { campaignId: _campaignId, deadline, ...rest } = dto;

    return this.prisma.commitment.update({
      where: { id },
      data: {
        ...rest,
        ...(deadline && { deadline: new Date(deadline) }),
      },
      include: this.include,
    });
  }

  async remove(user: JwtPayload, id: string) {
    await this.findOne(user, id);
    await this.prisma.commitment.delete({ where: { id } });
    return { success: true, message: 'Commitment deleted' };
  }
}
