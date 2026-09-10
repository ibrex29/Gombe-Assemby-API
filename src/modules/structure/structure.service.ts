import { Injectable } from '@nestjs/common';
import {
  COLLATION_HIERARCHY,
  CampaignRole,
  CollationLevel,
  LEVEL_TO_SCOPE_TYPE,
} from '@electromon/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DeploymentScopeService } from '../../common/deployment-scope/deployment-scope.service';

@Injectable()
export class StructureService {
  constructor(
    private prisma: PrismaService,
    private deploymentScope: DeploymentScopeService,
  ) {}

  getCollationHierarchy() {
    const labels: Record<CollationLevel, string> = {
      [CollationLevel.POLLING_UNIT]: 'Polling Unit (PU)',
      [CollationLevel.WARD]: 'Ward / Registration Area (RA)',
      [CollationLevel.LGA]: 'Local Government Area (LGA)',
      [CollationLevel.CONSTITUENCY]: 'State Constituency',
      [CollationLevel.STATE]: 'State Collation Centre',
      [CollationLevel.NATIONAL]: 'National Collation Centre (Abuja)',
    };

    return COLLATION_HIERARCHY.map((level, index) => ({
      level,
      levelOrder: index + 1,
      label: labels[level],
      scopeType: LEVEL_TO_SCOPE_TYPE[level],
      description:
        index === 0
          ? 'Lowest level; physical voting and initial count happens here.'
          : index === COLLATION_HIERARCHY.length - 1
            ? 'Highest level; final presidential announcement.'
            : `Combines all units from ${labels[COLLATION_HIERARCHY[index - 1]]}.`,
      approvesFrom: index > 0 ? COLLATION_HIERARCHY[index - 1] : null,
      submitsTo: index < COLLATION_HIERARCHY.length - 1 ? COLLATION_HIERARCHY[index + 1] : null,
      dashboardRoute:
        level === CollationLevel.POLLING_UNIT
          ? '/dashboard/polling-unit'
          : level === CollationLevel.WARD
            ? '/dashboard/ward'
            : level === CollationLevel.LGA
              ? '/dashboard/lga'
              : level === CollationLevel.STATE
                ? '/dashboard/state'
                : '/dashboard/national',
    }));
  }

  getStates() {
    return this.prisma.state.findMany({
      where: this.deploymentScope.stateWhere(),
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { lgas: true, campaigns: true } },
      },
    });
  }

  getLgasByState(stateId: string) {
    this.deploymentScope.clampStateId(stateId);
    return this.prisma.lGA.findMany({
      where: { stateId },
      orderBy: { name: 'asc' },
      include: {
        senatorialDistrict: true,
        _count: { select: { wards: true } },
      },
    });
  }

  getWardsByLga(lgaId: string) {
    return this.prisma.ward.findMany({
      where: { lgaId },
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { pollingUnits: true, volunteers: true } },
      },
    });
  }

  getPollingUnitsByWard(wardId: string) {
    return this.prisma.pollingUnit.findMany({
      where: { wardId },
      orderBy: { code: 'asc' },
    });
  }

  async getCoverageStats(campaignId: string) {
    const campaign = await this.prisma.campaign.findUniqueOrThrow({
      where: { id: campaignId },
      include: { state: true },
    });

    const geo = campaign.isNational ? {} : { stateId: campaign.stateId };
    const [totalLgas, totalWards, totalPollingUnits, assignedCoordinators] = await Promise.all([
      this.prisma.lGA.count({ where: geo }),
      this.prisma.ward.count({
        where: { lga: geo },
      }),
      this.prisma.pollingUnit.count({
        where: { ward: { lga: geo } },
      }),
      this.prisma.campaignMembership.count({
        where: {
          campaignId,
          isActive: true,
          role: {
            in: [
              CampaignRole.POLLING_AGENT,
              CampaignRole.WARD_RA_OFFICER,
              CampaignRole.LGA_COLLATION_OFFICER,
              CampaignRole.STATE_COLLATION_OFFICER,
              CampaignRole.NATIONAL_COLLATION_OFFICER,
            ],
          },
        },
      }),
    ]);

    return {
      campaignId,
      state: campaign.isNational ? 'Nigeria' : campaign.state.name,
      totalLgas,
      totalWards,
      totalPollingUnits,
      assignedCoordinators,
    };
  }
}
