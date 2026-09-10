import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  Max,
  MaxLength,
  Min,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { CollationLevel, ScopeType, TriageRiskLevel } from '@electromon/shared';

/** Levels a command room reads. Ward/PU scoring is on-demand, not swept. */
export enum TriageSweepLevel {
  STATE = 'STATE',
  LGA = 'LGA',
}

export class TriageOverviewQueryDto {
  @ApiPropertyOptional({
    enum: TriageSweepLevel,
    default: TriageSweepLevel.STATE,
  })
  @IsOptional()
  @IsEnum(TriageSweepLevel)
  level?: TriageSweepLevel;

  @ApiPropertyOptional({ enum: TriageRiskLevel })
  @IsOptional()
  @IsEnum(TriageRiskLevel)
  riskLevel?: TriageRiskLevel;
}

export class TriageScopeQueryDto {
  @ApiProperty({ enum: ScopeType })
  @IsEnum(ScopeType)
  scopeType: ScopeType;
}

export class TriageRescoreDto {
  @ApiPropertyOptional({
    enum: TriageSweepLevel,
    default: TriageSweepLevel.STATE,
  })
  @IsOptional()
  @IsEnum(TriageSweepLevel)
  level?: TriageSweepLevel;

  @ApiPropertyOptional({
    description:
      'Election mode enables the time-sensitive components (reporting coverage, staleness).',
    default: true,
  })
  @IsOptional()
  @Transform(({ value }) => value !== false && value !== 'false')
  @IsBoolean()
  electionMode?: boolean;
}

export const SWEEP_LEVEL_TO_COLLATION: Record<
  TriageSweepLevel,
  CollationLevel.STATE | CollationLevel.LGA
> = {
  [TriageSweepLevel.STATE]: CollationLevel.STATE,
  [TriageSweepLevel.LGA]: CollationLevel.LGA,
};

/** Levels you drill into rather than sweep. */
export enum TriageDrillLevel {
  WARD = 'WARD',
  POLLING_UNIT = 'POLLING_UNIT',
}

export class TriageChildrenQueryDto {
  @ApiProperty({
    enum: TriageDrillLevel,
    description: 'The level of the children you want, not of the parent.',
  })
  @IsEnum(TriageDrillLevel)
  level: TriageDrillLevel;

  @ApiProperty({
    description: 'An LGA id when level is WARD, a ward id when POLLING_UNIT.',
  })
  @IsString()
  @IsNotEmpty()
  parentId: string;

  @ApiPropertyOptional({
    description:
      'Election mode enables the time-sensitive components (reporting coverage, staleness).',
    default: true,
  })
  @IsOptional()
  @Transform(({ value }) => value !== false && value !== 'false')
  @IsBoolean()
  electionMode?: boolean;
}

export const DRILL_LEVEL_TO_COLLATION: Record<
  TriageDrillLevel,
  CollationLevel.WARD | CollationLevel.POLLING_UNIT
> = {
  [TriageDrillLevel.WARD]: CollationLevel.WARD,
  [TriageDrillLevel.POLLING_UNIT]: CollationLevel.POLLING_UNIT,
};

/** Direction of a band move, by the risk ladder rather than the score. */
export enum TriageTransitionDirection {
  ALL = 'ALL',
  RAISED = 'RAISED',
  CLEARED = 'CLEARED',
}

export class TriageTransitionsQueryDto {
  @ApiPropertyOptional({
    enum: TriageTransitionDirection,
    default: TriageTransitionDirection.ALL,
  })
  @IsOptional()
  @IsEnum(TriageTransitionDirection)
  direction?: TriageTransitionDirection;

  @ApiPropertyOptional({ description: 'Rows to return, 1-100. Default 20.' })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class TriageAcknowledgeDto {
  @ApiPropertyOptional({
    description: 'Optional note on what is being done about it.',
    maxLength: 280,
  })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  note?: string;
}
