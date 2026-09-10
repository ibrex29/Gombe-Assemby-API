import { ForbiddenException, Injectable } from '@nestjs/common';
import { JwtPayload } from '@electromon/shared';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  private async assertCampaignAccess(userId: string, campaignId: string) {
    const membership = await this.prisma.campaignMembership.findFirst({
      where: { userId, campaignId, isActive: true },
    });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this campaign');
    }
  }

  async getOverview(user: JwtPayload, campaignId: string) {
    await this.assertCampaignAccess(user.sub, campaignId);

    const campaign = await this.prisma.campaign.findUniqueOrThrow({
      where: { id: campaignId },
      include: { state: true },
    });
    const puStateFilter = campaign.isNational
      ? {}
      : { ward: { lga: { stateId: campaign.stateId } } };

    const [
      supportGroups,
      activeSupportGroups,
      volunteers,
      verifiedVolunteers,
      commitments,
      activeCommitments,
      completedCommitments,
      commitmentAgg,
      pollingUnits,
      assignedPollingUnits,
      puStrong,
      puSwing,
      puWeak,
      fieldReports,
      urgentFieldReports,
      situationUpdates,
      urgentSituations,
      incidents,
      topVolunteers,
      recentFieldReports,
      recentSituations,
      recentCommitments,
      lgas,
    ] = await Promise.all([
      this.prisma.supportGroup.count({ where: { campaignId } }),
      this.prisma.supportGroup.count({ where: { campaignId, verificationStatus: 'ACTIVE' } }),
      this.prisma.volunteer.count({ where: { campaignId } }),
      this.prisma.volunteer.count({ where: { campaignId, isVerified: true } }),
      this.prisma.commitment.count({ where: { campaignId } }),
      this.prisma.commitment.count({ where: { campaignId, status: 'ACTIVE' } }),
      this.prisma.commitment.count({ where: { campaignId, status: 'COMPLETED' } }),
      this.prisma.commitment.aggregate({
        where: { campaignId },
        _sum: { targetValue: true, currentValue: true },
      }),
      this.prisma.pollingUnit.count({ where: puStateFilter }),
      this.prisma.pollingUnit.count({
        where: { ...puStateFilter, assignedAgentId: { not: null } },
      }),
      this.prisma.pollingUnit.count({ where: { ...puStateFilter, strengthAssessment: 'STRONG' } }),
      this.prisma.pollingUnit.count({ where: { ...puStateFilter, strengthAssessment: 'SWING' } }),
      this.prisma.pollingUnit.count({ where: { ...puStateFilter, strengthAssessment: 'WEAK' } }),
      this.prisma.fieldReport.count({ where: { campaignId } }),
      this.prisma.fieldReport.count({ where: { campaignId, isUrgent: true } }),
      this.prisma.situationUpdate.count({
        where: campaign.isNational ? {} : { pollingUnit: { ward: { lga: { stateId: campaign.stateId } } } },
      }),
      this.prisma.situationUpdate.count({
        where: campaign.isNational
          ? { isUrgent: true }
          : {
              isUrgent: true,
              pollingUnit: { ward: { lga: { stateId: campaign.stateId } } },
            },
      }),
      this.prisma.situationUpdate.count({
        where: campaign.isNational
          ? { status: 'INCIDENT' }
          : {
              status: 'INCIDENT',
              pollingUnit: { ward: { lga: { stateId: campaign.stateId } } },
            },
      }),
      this.prisma.volunteer.findMany({
        where: { campaignId },
        orderBy: { performanceScore: 'desc' },
        take: 5,
        select: { id: true, firstName: true, lastName: true, role: true, performanceScore: true },
      }),
      this.prisma.fieldReport.findMany({
        where: { campaignId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, title: true, type: true, isUrgent: true, createdAt: true },
      }),
      this.prisma.situationUpdate.findMany({
        where: campaign.isNational
          ? {}
          : { pollingUnit: { ward: { lga: { stateId: campaign.stateId } } } },
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: { pollingUnit: { select: { code: true, name: true } } },
      }),
      this.prisma.commitment.findMany({
        where: { campaignId },
        orderBy: { updatedAt: 'desc' },
        take: 5,
        include: { supportGroup: { select: { name: true } } },
      }),
      this.prisma.lGA.findMany({
        where: campaign.isNational ? { id: '__none__' } : { stateId: campaign.stateId },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          _count: {
            select: {
              wards: true,
            },
          },
        },
      }),
    ]);

    const totalTarget = commitmentAgg._sum.targetValue ?? 0;
    const totalCurrent = commitmentAgg._sum.currentValue ?? 0;
    const unassessed = pollingUnits - puStrong - puSwing - puWeak;

    const lgaCoverage = await Promise.all(
      lgas.map(async (lga) => {
        const [puCount, assigned, volCount] = await Promise.all([
          this.prisma.pollingUnit.count({ where: { ward: { lgaId: lga.id } } }),
          this.prisma.pollingUnit.count({
            where: { ward: { lgaId: lga.id }, assignedAgentId: { not: null } },
          }),
          this.prisma.volunteer.count({ where: { campaignId, ward: { lgaId: lga.id } } }),
        ]);
        return {
          lgaId: lga.id,
          lgaName: lga.name,
          pollingUnits: puCount,
          assignedAgents: assigned,
          volunteers: volCount,
        };
      }),
    );

    const recentActivity = [
      ...recentFieldReports.map((r) => ({
        type: 'field_report' as const,
        id: r.id,
        title: r.title,
        subtitle: r.type.replace(/_/g, ' '),
        isUrgent: r.isUrgent,
        createdAt: r.createdAt,
      })),
      ...recentSituations.map((s) => ({
        type: 'situation_update' as const,
        id: s.id,
        title: `${s.pollingUnit.code} — ${s.status}`,
        subtitle: s.pollingUnit.name,
        isUrgent: s.isUrgent,
        createdAt: s.createdAt,
      })),
      ...recentCommitments.map((c) => ({
        type: 'commitment' as const,
        id: c.id,
        title: c.title,
        subtitle: c.supportGroup.name,
        isUrgent: false,
        createdAt: c.updatedAt,
      })),
    ]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 8);

    return {
      campaignId,
      state: campaign.isNational ? 'Nigeria' : campaign.state.name,
      counts: {
        supportGroups,
        activeSupportGroups,
        volunteers,
        verifiedVolunteers,
        commitments,
        activeCommitments,
        completedCommitments,
        pollingUnits,
        assignedPollingUnits,
        fieldReports,
        urgentFieldReports,
        situationUpdates,
        urgentSituations,
        incidents,
      },
      commitmentProgress: {
        totalTarget,
        totalCurrent,
        percent: totalTarget > 0 ? Math.round((totalCurrent / totalTarget) * 100) : 0,
      },
      pollingUnitStrength: {
        strong: puStrong,
        swing: puSwing,
        weak: puWeak,
        unassessed: Math.max(0, unassessed),
      },
      topVolunteers,
      recentActivity,
      lgaCoverage: lgaCoverage.filter(
        (l) => l.pollingUnits > 0 || l.volunteers > 0,
      ).slice(0, 10),
    };
  }
}
