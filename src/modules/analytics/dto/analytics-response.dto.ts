import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AnalyticsCountsDto {
  @ApiProperty() supportGroups: number;
  @ApiProperty() activeSupportGroups: number;
  @ApiProperty() volunteers: number;
  @ApiProperty() verifiedVolunteers: number;
  @ApiProperty() commitments: number;
  @ApiProperty() activeCommitments: number;
  @ApiProperty() completedCommitments: number;
  @ApiProperty() pollingUnits: number;
  @ApiProperty() assignedPollingUnits: number;
  @ApiProperty() fieldReports: number;
  @ApiProperty() urgentFieldReports: number;
  @ApiProperty() situationUpdates: number;
  @ApiProperty() urgentSituations: number;
  @ApiProperty() incidents: number;
}

export class CommitmentProgressDto {
  @ApiProperty() totalTarget: number;
  @ApiProperty() totalCurrent: number;
  @ApiProperty() percent: number;
}

export class PuBreakdownDto {
  @ApiProperty() strong: number;
  @ApiProperty() swing: number;
  @ApiProperty() weak: number;
  @ApiProperty() unassessed: number;
}

export class TopVolunteerDto {
  @ApiProperty() id: string;
  @ApiProperty() firstName: string;
  @ApiProperty() lastName: string;
  @ApiPropertyOptional() role?: string | null;
  @ApiProperty() performanceScore: number;
}

export class RecentActivityDto {
  @ApiProperty({ enum: ['field_report', 'situation_update', 'commitment'] })
  type: string;

  @ApiProperty() id: string;
  @ApiProperty() title: string;
  @ApiProperty() subtitle?: string;
  @ApiProperty() isUrgent: boolean;
  @ApiProperty() createdAt: Date;
}

export class LgaCoverageDto {
  @ApiProperty() lgaId: string;
  @ApiProperty() lgaName: string;
  @ApiProperty() pollingUnits: number;
  @ApiProperty() assignedAgents: number;
  @ApiProperty() volunteers: number;
}

export class AnalyticsOverviewDto {
  @ApiProperty() campaignId: string;
  @ApiProperty() state: string;
  @ApiProperty({ type: AnalyticsCountsDto }) counts: AnalyticsCountsDto;
  @ApiProperty({ type: CommitmentProgressDto }) commitmentProgress: CommitmentProgressDto;
  @ApiProperty({ type: PuBreakdownDto }) pollingUnitStrength: PuBreakdownDto;
  @ApiProperty({ type: [TopVolunteerDto] }) topVolunteers: TopVolunteerDto[];
  @ApiProperty({ type: [RecentActivityDto] }) recentActivity: RecentActivityDto[];
  @ApiProperty({ type: [LgaCoverageDto] }) lgaCoverage: LgaCoverageDto[];
}
