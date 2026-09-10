import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@electromon/db';
import { JwtPayload } from '@electromon/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DeploymentScopeService } from '../../common/deployment-scope/deployment-scope.service';
import {
  CreatePollingUnitDto,
  ListPollingUnitsQueryDto,
  UpdatePollingUnitDto,
} from './dto/polling-unit.dto';

type PollingUnitRecord = Prisma.PollingUnitGetPayload<{
  include: {
    ward: { include: { lga: { select: { id: true; name: true } } } };
  };
}>;

@Injectable()
export class PollingUnitsService {
  constructor(
    private prisma: PrismaService,
    private deploymentScope: DeploymentScopeService,
  ) {}

  private readonly include = {
    ward: {
      include: {
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

  private async getCampaignStateId(campaignId: string) {
    const campaign = await this.prisma.campaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: { stateId: true, isNational: true },
    });
    return campaign;
  }

  private async assertWardInCampaignState(campaignId: string, wardId: string) {
    const campaign = await this.getCampaignStateId(campaignId);
    const effectiveStateId = this.deploymentScope.effectivePuStateId(campaign);
    const ward = await this.prisma.ward.findFirst({
      where: effectiveStateId
        ? { id: wardId, lga: { stateId: effectiveStateId } }
        : { id: wardId },
    });
    if (!ward) {
      throw new NotFoundException('Ward not found in campaign state');
    }
    return ward;
  }

  private async assertAgentInCampaign(campaignId: string, volunteerId: string) {
    const volunteer = await this.prisma.volunteer.findFirst({
      where: { id: volunteerId, campaignId },
    });
    if (!volunteer) {
      throw new NotFoundException('Assigned agent not found in this campaign');
    }
  }

  private async enrichWithAgents(units: PollingUnitRecord[]) {
    const agentIds = [...new Set(units.map((u) => u.assignedAgentId).filter(Boolean))] as string[];
    if (agentIds.length === 0) {
      return units.map((u) => ({ ...u, assignedAgent: null }));
    }

    const agents = await this.prisma.volunteer.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, firstName: true, lastName: true },
    });
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    return units.map((unit) => ({
      ...unit,
      assignedAgent: unit.assignedAgentId ? agentMap.get(unit.assignedAgentId) ?? null : null,
    }));
  }

  private puGeoWhere(campaign: { isNational: boolean; stateId: string }): Prisma.PollingUnitWhereInput {
    const effectiveStateId = this.deploymentScope.effectivePuStateId(campaign);
    if (!effectiveStateId) return {};
    return { ward: { lga: { stateId: effectiveStateId } } };
  }

  async list(user: JwtPayload, query: ListPollingUnitsQueryDto) {
    await this.assertCampaignAccess(user.sub, query.campaignId);
    const campaign = await this.getCampaignStateId(query.campaignId);
    const effectiveStateId = this.deploymentScope.effectivePuStateId(campaign);

    const where: Prisma.PollingUnitWhereInput = {
      ward: {
        lga: {
          ...(effectiveStateId ? { stateId: effectiveStateId } : {}),
          ...(query.lgaId && { id: query.lgaId }),
        },
        ...(query.wardId && { id: query.wardId }),
      },
      ...(query.status && { status: query.status }),
      ...(query.strength && { strengthAssessment: query.strength }),
      ...(query.search && {
        OR: [
          { code: { contains: query.search, mode: 'insensitive' } },
          { name: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };

    const units = await this.prisma.pollingUnit.findMany({
      where,
      include: this.include,
      orderBy: [{ ward: { lga: { name: 'asc' } } }, { code: 'asc' }],
    });

    return this.enrichWithAgents(units);
  }

  async findOne(user: JwtPayload, id: string, campaignId: string) {
    await this.assertCampaignAccess(user.sub, campaignId);
    const campaign = await this.getCampaignStateId(campaignId);

    const unit = await this.prisma.pollingUnit.findFirst({
      where: {
        id,
        ...this.puGeoWhere(campaign),
      },
      include: this.include,
    });
    if (!unit) {
      throw new NotFoundException('Polling unit not found');
    }

    const [enriched] = await this.enrichWithAgents([unit]);
    return enriched;
  }

  async create(user: JwtPayload, dto: CreatePollingUnitDto) {
    await this.assertCampaignAccess(user.sub, dto.campaignId);
    await this.assertWardInCampaignState(dto.campaignId, dto.wardId);

    if (dto.assignedAgentId) {
      await this.assertAgentInCampaign(dto.campaignId, dto.assignedAgentId);
    }

    const existing = await this.prisma.pollingUnit.findUnique({ where: { code: dto.code } });
    if (existing) {
      throw new ConflictException('Polling unit code already exists');
    }

    const unit = await this.prisma.pollingUnit.create({
      data: {
        code: dto.code,
        name: dto.name,
        wardId: dto.wardId,
        latitude: dto.latitude,
        longitude: dto.longitude,
        strengthAssessment: dto.strengthAssessment,
        status: dto.status,
        assignedAgentId: dto.assignedAgentId,
        notes: dto.notes,
      },
      include: this.include,
    });

    const [enriched] = await this.enrichWithAgents([unit]);
    return enriched;
  }

  async update(user: JwtPayload, id: string, dto: UpdatePollingUnitDto) {
    if (!dto.campaignId) {
      throw new ForbiddenException('campaignId is required');
    }

    const existing = await this.findOne(user, id, dto.campaignId);

    if (dto.wardId && dto.wardId !== existing.wardId) {
      await this.assertWardInCampaignState(dto.campaignId, dto.wardId);
    }

    if (dto.assignedAgentId) {
      await this.assertAgentInCampaign(dto.campaignId, dto.assignedAgentId);
    }

    if (dto.code && dto.code !== existing.code) {
      const duplicate = await this.prisma.pollingUnit.findUnique({ where: { code: dto.code } });
      if (duplicate) {
        throw new ConflictException('Polling unit code already exists');
      }
    }

    const { campaignId: _campaignId, ...data } = dto;

    const unit = await this.prisma.pollingUnit.update({
      where: { id },
      data,
      include: this.include,
    });

    const [enriched] = await this.enrichWithAgents([unit]);
    return enriched;
  }

  async remove(user: JwtPayload, id: string, campaignId: string) {
    await this.findOne(user, id, campaignId);
    await this.prisma.pollingUnit.delete({ where: { id } });
    return { success: true, message: 'Polling unit deleted' };
  }
}
