import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  CollationLevel,
  CrowdLean,
  ElectionDayPhase,
  ObservedConfidence,
  PulseAtmosphere,
  PulseBvasStatus,
  PulseQueue,
  PulseSource,
  PulseTurnoutBand,
  RivalMobilization,
  RivalTactic,
  SituationStatus,
  WhoLooksAhead,
} from '@electromon/shared';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

function toBool(value: unknown) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

export class CreateSituationUpdateDto {
  @ApiProperty({ example: 'cms147z3t001www9ktkqgluw0' })
  @IsString()
  @IsNotEmpty()
  campaignId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  pollingUnitId: string;

  @ApiPropertyOptional({ enum: SituationStatus, description: 'Legacy status. Prefer phase.' })
  @IsOptional()
  @IsEnum(SituationStatus)
  status?: SituationStatus;

  @ApiPropertyOptional({ enum: ElectionDayPhase })
  @IsOptional()
  @IsEnum(ElectionDayPhase)
  phase?: ElectionDayPhase;

  @ApiPropertyOptional({ enum: PulseAtmosphere })
  @IsOptional()
  @IsEnum(PulseAtmosphere)
  atmosphere?: PulseAtmosphere;

  @ApiPropertyOptional({ enum: PulseBvasStatus })
  @IsOptional()
  @IsEnum(PulseBvasStatus)
  bvasStatus?: PulseBvasStatus;

  @ApiPropertyOptional({ enum: PulseQueue })
  @IsOptional()
  @IsEnum(PulseQueue)
  queue?: PulseQueue;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  materialsComplete?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  securityPresent?: boolean;

  @ApiPropertyOptional({ enum: PulseTurnoutBand })
  @IsOptional()
  @IsEnum(PulseTurnoutBand)
  turnoutBand?: PulseTurnoutBand;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  estimatedAccredited?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  rivalAgentPresent?: boolean;

  @ApiPropertyOptional({ enum: RivalMobilization })
  @IsOptional()
  @IsEnum(RivalMobilization)
  rivalMobilization?: RivalMobilization;

  @ApiPropertyOptional({ enum: CrowdLean })
  @IsOptional()
  @IsEnum(CrowdLean)
  crowdLean?: CrowdLean;

  @ApiPropertyOptional({ enum: WhoLooksAhead })
  @IsOptional()
  @IsEnum(WhoLooksAhead)
  whoLooksAhead?: WhoLooksAhead;

  @ApiPropertyOptional({ enum: RivalTactic, isArray: true })
  @IsOptional()
  @IsArray()
  @IsEnum(RivalTactic, { each: true })
  rivalTactics?: RivalTactic[];

  @ApiPropertyOptional({
    example: { APC: 120, PDP: 88 },
    description: 'Unofficial observed party totals. Allowed only when phase is COUNTING.',
  })
  @IsOptional()
  @IsObject()
  observedPartyResults?: Record<string, number>;

  @ApiPropertyOptional({ enum: ObservedConfidence })
  @IsOptional()
  @IsEnum(ObservedConfidence)
  observedConfidence?: ObservedConfidence;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photoUrls?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  longitude?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isUrgent?: boolean;

  @ApiPropertyOptional({ enum: PulseSource })
  @IsOptional()
  @IsEnum(PulseSource)
  source?: PulseSource;
}

export class PulseActionDto {
  @ApiProperty({ example: 'cms147z3t001www9ktkqgluw0' })
  @IsString()
  @IsNotEmpty()
  campaignId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  pollingUnitId?: string;
}

export class UpdateSituationUpdateDto extends PartialType(CreateSituationUpdateDto) {}

export class ListSituationUpdatesQueryDto {
  @ApiProperty({ example: 'cms147z3t001www9ktkqgluw0' })
  @IsString()
  @IsNotEmpty()
  campaignId: string;

  @ApiPropertyOptional({ enum: SituationStatus })
  @IsOptional()
  @IsEnum(SituationStatus)
  status?: SituationStatus;

  @ApiPropertyOptional({ enum: ElectionDayPhase })
  @IsOptional()
  @IsEnum(ElectionDayPhase)
  phase?: ElectionDayPhase;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  pollingUnitId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reportedById?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => toBool(value))
  @IsBoolean()
  isUrgent?: boolean;
}

export class SituationSummaryQueryDto {
  @ApiProperty({ example: 'cms147z3t001www9ktkqgluw0' })
  @IsString()
  @IsNotEmpty()
  campaignId: string;
}

export class PulseMeQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  campaignId?: string;
}

export class PulseRollupQueryDto {
  @ApiProperty({ example: 'cms147z3t001www9ktkqgluw0' })
  @IsString()
  @IsNotEmpty()
  campaignId: string;

  @ApiPropertyOptional({ enum: CollationLevel })
  @IsOptional()
  @IsEnum(CollationLevel)
  level?: CollationLevel;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  scopeId?: string;
}

export class PulseUnitsQueryDto {
  @ApiProperty({ example: 'cms147z3t001www9ktkqgluw0' })
  @IsString()
  @IsNotEmpty()
  campaignId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  wardId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  lgaId?: string;

  @ApiPropertyOptional({ enum: ElectionDayPhase })
  @IsOptional()
  @IsEnum(ElectionDayPhase)
  phase?: ElectionDayPhase;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => toBool(value))
  @IsBoolean()
  silent?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  take?: number;
}
