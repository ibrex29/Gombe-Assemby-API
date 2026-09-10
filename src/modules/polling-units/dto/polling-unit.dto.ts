import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { PollingUnitStatus, PollingUnitStrength } from '@electromon/shared';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class CreatePollingUnitDto {
  @ApiProperty({ example: 'cms147z3t001www9ktkqgluw0' })
  @IsString()
  @IsNotEmpty()
  campaignId: string;

  @ApiProperty({ example: 'JI-HD-002' })
  @IsString()
  @MinLength(3)
  code: string;

  @ApiProperty({ example: 'Hadejia Central PU 002' })
  @IsString()
  @MinLength(3)
  name: string;

  @ApiProperty({ description: 'Jigawa ward ID' })
  @IsString()
  @IsNotEmpty()
  wardId: string;

  @ApiPropertyOptional({ example: 12.4534 })
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @ApiPropertyOptional({ example: 10.0411 })
  @IsOptional()
  @IsNumber()
  longitude?: number;

  @ApiPropertyOptional({ enum: PollingUnitStrength })
  @IsOptional()
  @IsEnum(PollingUnitStrength)
  strengthAssessment?: PollingUnitStrength;

  @ApiPropertyOptional({ enum: PollingUnitStatus, default: PollingUnitStatus.ACTIVE })
  @IsOptional()
  @IsEnum(PollingUnitStatus)
  status?: PollingUnitStatus;

  @ApiPropertyOptional({ description: 'Volunteer ID assigned as polling agent' })
  @IsOptional()
  @IsString()
  assignedAgentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdatePollingUnitDto extends PartialType(CreatePollingUnitDto) {}

export class ListPollingUnitsQueryDto {
  @ApiProperty({ example: 'cms147z3t001www9ktkqgluw0' })
  @IsString()
  @IsNotEmpty()
  campaignId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  lgaId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  wardId?: string;

  @ApiPropertyOptional({ enum: PollingUnitStatus })
  @IsOptional()
  @IsEnum(PollingUnitStatus)
  status?: PollingUnitStatus;

  @ApiPropertyOptional({ enum: PollingUnitStrength })
  @IsOptional()
  @IsEnum(PollingUnitStrength)
  strength?: PollingUnitStrength;

  @ApiPropertyOptional({ description: 'Search by code or name' })
  @IsOptional()
  @IsString()
  search?: string;
}
