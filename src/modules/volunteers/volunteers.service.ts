import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@electromon/db';
import { JwtPayload } from '@electromon/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  assertWardAccess,
  getWardScopeId,
} from '../../common/scoping/campaign-scope';
import {
  CreateVolunteerDto,
  ListVolunteersQueryDto,
  UpdateVolunteerDto,
} from './dto/volunteer.dto';

@Injectable()
export class VolunteersService {
  constructor(private prisma: PrismaService) {}

  private readonly include = {
    ward: {
      select: {
        id: true,
        name: true,
        lga: { select: { id: true, name: true } },
      },
    },
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

  async list(user: JwtPayload, query: ListVolunteersQueryDto) {
    await this.assertCampaignAccess(user.sub, query.campaignId);

    const wardScopeId = getWardScopeId(user);
    if (wardScopeId && query.wardId && query.wardId !== wardScopeId) {
      throw new ForbiddenException('You can only view volunteers in your assigned ward');
    }

    const where: Prisma.VolunteerWhereInput = {
      campaignId: query.campaignId,
      ...(wardScopeId
        ? { wardId: wardScopeId }
        : query.wardId && { wardId: query.wardId }),
      ...(query.role && { role: query.role }),
      ...(query.isVerified !== undefined && { isVerified: query.isVerified }),
      ...(query.search && {
        OR: [
          { firstName: { contains: query.search, mode: 'insensitive' } },
          { lastName: { contains: query.search, mode: 'insensitive' } },
          { phoneNumber: { contains: query.search, mode: 'insensitive' } },
          { email: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };

    return this.prisma.volunteer.findMany({
      where,
      include: this.include,
      orderBy: [{ updatedAt: 'desc' }],
    });
  }

  async findOne(user: JwtPayload, id: string) {
    const volunteer = await this.prisma.volunteer.findUnique({
      where: { id },
      include: this.include,
    });
    if (!volunteer) {
      throw new NotFoundException('Volunteer not found');
    }
    await this.assertCampaignAccess(user.sub, volunteer.campaignId);
    if (volunteer.wardId) {
      assertWardAccess(user, volunteer.wardId);
    }
    return volunteer;
  }

  async create(user: JwtPayload, dto: CreateVolunteerDto) {
    await this.assertCampaignAccess(user.sub, dto.campaignId);

    const wardScopeId = getWardScopeId(user);
    const wardId = wardScopeId ?? dto.wardId;
    if (wardScopeId && dto.wardId && dto.wardId !== wardScopeId) {
      throw new ForbiddenException('You can only assign volunteers to your ward');
    }

    if (wardId) {
      await this.assertWardInCampaign(wardId);
      assertWardAccess(user, wardId);
    }

    return this.prisma.volunteer.create({
      data: {
        campaignId: dto.campaignId,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phoneNumber: dto.phoneNumber,
        email: dto.email,
        wardId,
        role: dto.role,
        performanceScore: dto.performanceScore ?? 0,
        isVerified: dto.isVerified ?? false,
      },
      include: this.include,
    });
  }

  async update(user: JwtPayload, id: string, dto: UpdateVolunteerDto) {
    const existing = await this.findOne(user, id);

    if (dto.campaignId && dto.campaignId !== existing.campaignId) {
      throw new ForbiddenException('Cannot move volunteer to another campaign');
    }

    if (dto.wardId) {
      await this.assertWardInCampaign(dto.wardId);
      assertWardAccess(user, dto.wardId);
    } else if (existing.wardId) {
      assertWardAccess(user, existing.wardId);
    }

    const { campaignId: _campaignId, ...data } = dto;

    return this.prisma.volunteer.update({
      where: { id },
      data,
      include: this.include,
    });
  }

  async remove(user: JwtPayload, id: string) {
    await this.findOne(user, id);
    await this.prisma.volunteer.delete({ where: { id } });
    return { success: true, message: 'Volunteer deleted' };
  }

  private async assertWardInCampaign(wardId: string) {
    const ward = await this.prisma.ward.findFirst({
      where: { id: wardId },
    });
    if (!ward) {
      throw new NotFoundException('Ward not found');
    }
  }
}
