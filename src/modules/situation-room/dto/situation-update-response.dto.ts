import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CrowdLean,
  ElectionDayPhase,
  ObservedConfidence,
  PulseAtmosphere,
  PulseBvasStatus,
  PulseQueue,
  PulseTurnoutBand,
  PulseSource,
  RivalMobilization,
  RivalTactic,
  SituationStatus,
  WhoLooksAhead,
} from '@electromon/shared';

export class SituationPollingUnitDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'JI-HD-001' })
  code: string;

  @ApiProperty({ example: 'Hadejia Central PU 001' })
  name: string;
}

export class SituationReporterDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Campaign' })
  firstName: string;

  @ApiProperty({ example: 'Director' })
  lastName: string;
}

export class SituationUpdateResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  pollingUnitId: string;

  @ApiPropertyOptional()
  campaignId?: string | null;

  @ApiProperty({ type: SituationPollingUnitDto })
  pollingUnit: SituationPollingUnitDto;

  @ApiProperty()
  reportedById: string;

  @ApiProperty({ type: SituationReporterDto })
  reporter: SituationReporterDto;

  @ApiProperty({ enum: SituationStatus })
  status: SituationStatus;

  @ApiPropertyOptional({ enum: ElectionDayPhase })
  phase?: ElectionDayPhase | null;

  @ApiPropertyOptional({ enum: PulseAtmosphere })
  atmosphere?: PulseAtmosphere | null;

  @ApiPropertyOptional({ enum: PulseBvasStatus })
  bvasStatus?: PulseBvasStatus | null;

  @ApiPropertyOptional({ enum: PulseQueue })
  queue?: PulseQueue | null;

  @ApiPropertyOptional()
  materialsComplete?: boolean | null;

  @ApiPropertyOptional()
  securityPresent?: boolean | null;

  @ApiPropertyOptional({ enum: PulseTurnoutBand })
  turnoutBand?: PulseTurnoutBand | null;

  @ApiPropertyOptional()
  estimatedAccredited?: number | null;

  @ApiPropertyOptional()
  rivalAgentPresent?: boolean | null;

  @ApiPropertyOptional({ enum: RivalMobilization })
  rivalMobilization?: RivalMobilization | null;

  @ApiPropertyOptional({ enum: CrowdLean })
  crowdLean?: CrowdLean | null;

  @ApiPropertyOptional({ enum: WhoLooksAhead })
  whoLooksAhead?: WhoLooksAhead | null;

  @ApiPropertyOptional({ enum: RivalTactic, isArray: true })
  rivalTactics?: RivalTactic[];

  @ApiPropertyOptional()
  observedPartyResults?: Record<string, number> | null;

  @ApiPropertyOptional({ enum: ObservedConfidence })
  observedConfidence?: ObservedConfidence | null;

  @ApiPropertyOptional({ type: [String] })
  photoUrls?: string[];

  @ApiPropertyOptional()
  notes?: string | null;

  @ApiPropertyOptional()
  latitude?: number | null;

  @ApiPropertyOptional()
  longitude?: number | null;

  @ApiProperty()
  isUrgent: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiPropertyOptional()
  silent?: boolean;

  @ApiPropertyOptional({ enum: PulseSource })
  source?: PulseSource | null;
}

export class SituationSummaryDto {
  @ApiProperty()
  campaignId: string;

  @ApiProperty({ example: 3 })
  totalUpdates: number;

  @ApiProperty({ example: 1 })
  open: number;

  @ApiProperty({ example: 1 })
  reporting: number;

  @ApiProperty({ example: 1 })
  closed: number;

  @ApiProperty({ example: 0 })
  incidents: number;

  @ApiProperty({ example: 1 })
  urgent: number;

  @ApiProperty({ example: 3 })
  totalPollingUnits: number;

  @ApiProperty({ example: 2 })
  unitsWithUpdates: number;

  @ApiPropertyOptional()
  checkedIn?: number;

  @ApiPropertyOptional()
  opened?: number;

  @ApiPropertyOptional()
  voting?: number;

  @ApiPropertyOptional()
  counting?: number;

  @ApiPropertyOptional()
  silent?: number;

  @ApiPropertyOptional()
  bvasDown?: number;

  @ApiPropertyOptional()
  rivalHeavy?: number;
}

export class PulsePartyTotalsDto {
  @ApiProperty()
  observed: Record<string, number>;

  @ApiProperty()
  official: Record<string, number>;
}

export class PulseRollupDto {
  @ApiProperty()
  campaignId: string;

  @ApiProperty()
  level: string;

  @ApiProperty()
  scopeId: string;

  @ApiProperty()
  totalPollingUnits: number;

  @ApiProperty()
  checkedIn: number;

  @ApiProperty()
  opened: number;

  @ApiProperty()
  voting: number;

  @ApiProperty()
  closed: number;

  @ApiProperty()
  counting: number;

  @ApiProperty()
  silent: number;

  @ApiProperty()
  materialsIncomplete: number;

  @ApiProperty()
  bvasDown: number;

  @ApiProperty()
  tenseOrDisrupted: number;

  @ApiProperty()
  rivalHeavy: number;

  @ApiProperty()
  withObserved: number;

  @ApiProperty()
  officialSheetIn: number;

  @ApiProperty({ type: PulsePartyTotalsDto })
  partyTotals: PulsePartyTotalsDto;
}
