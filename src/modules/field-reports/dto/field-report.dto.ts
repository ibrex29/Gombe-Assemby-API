import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FieldReportStatus, FieldReportType, IncidentType, IncidentSeverity } from '@electromon/shared';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MinLength,
  ValidateIf,
} from 'class-validator';

function isIncidentReport(dto: { type?: FieldReportType }) {
  return dto.type === FieldReportType.INCIDENT || dto.type === FieldReportType.SECURITY_CONCERN;
}

function isVoiceIncidentReport(dto: CreateFieldReportDto) {
  return isIncidentReport(dto) && Boolean(dto.audioUrl?.trim());
}

function requiresFormIncidentFields(dto: CreateFieldReportDto) {
  return isIncidentReport(dto) && !dto.audioUrl?.trim();
}

export class CreateFieldReportDto {
  @ApiProperty({ example: 'cms147z3t001www9ktkqgluw0' })
  @IsString()
  @IsNotEmpty()
  campaignId: string;

  @ApiProperty({ enum: FieldReportType })
  @IsEnum(FieldReportType)
  type: FieldReportType;

  @ApiPropertyOptional({ enum: IncidentType, description: 'Required when type is INCIDENT (unless audioUrl is set)' })
  @ValidateIf(requiresFormIncidentFields)
  @IsEnum(IncidentType)
  @IsNotEmpty()
  incidentType?: IncidentType;

  @ApiPropertyOptional({ enum: IncidentSeverity, description: 'Required when type is INCIDENT (unless audioUrl is set)' })
  @ValidateIf(requiresFormIncidentFields)
  @IsEnum(IncidentSeverity)
  @IsNotEmpty()
  incidentSeverity?: IncidentSeverity;

  @ApiPropertyOptional({ example: 'Security concern at PU' })
  @ValidateIf((dto: CreateFieldReportDto) => !dto.audioUrl?.trim())
  @IsString()
  @MinLength(3)
  title?: string;

  @ApiPropertyOptional({ example: 'Unidentified persons gathering near the polling unit entrance.' })
  @ValidateIf((dto: CreateFieldReportDto) => !dto.audioUrl?.trim())
  @IsString()
  @MinLength(5)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  wardId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  pollingUnitId?: string;

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

  @ApiPropertyOptional({
    type: [String],
    description: 'URLs of uploaded photos (e.g. EC8A form images)',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photoUrls?: string[];

  @ApiPropertyOptional({
    description: 'URL of uploaded voice clip; when set, type/severity/description are optional and processed by AI',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  audioUrl?: string;
}

export class ListFieldReportsQueryDto {
  @ApiProperty({ example: 'cms147z3t001www9ktkqgluw0' })
  @IsString()
  @IsNotEmpty()
  campaignId: string;

  @ApiPropertyOptional({ enum: FieldReportType })
  @IsOptional()
  @IsEnum(FieldReportType)
  type?: FieldReportType;

  @ApiPropertyOptional({ enum: IncidentType })
  @IsOptional()
  @IsEnum(IncidentType)
  incidentType?: IncidentType;

  @ApiPropertyOptional({ enum: IncidentSeverity })
  @IsOptional()
  @IsEnum(IncidentSeverity)
  incidentSeverity?: IncidentSeverity;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  })
  @IsBoolean()
  isUrgent?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

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
  @IsString()
  wardId?: string;

  @ApiPropertyOptional({ description: 'Filter incidents to a state' })
  @IsOptional()
  @IsString()
  stateId?: string;

  @ApiPropertyOptional({ description: 'Filter incidents to a local government area' })
  @IsOptional()
  @IsString()
  lgaId?: string;

  @ApiPropertyOptional({ enum: FieldReportStatus })
  @IsOptional()
  @IsEnum(FieldReportStatus)
  status?: FieldReportStatus;
}

export class UpdateFieldReportStatusDto {
  @ApiProperty({ enum: FieldReportStatus })
  @IsEnum(FieldReportStatus)
  status: FieldReportStatus;

  @ApiPropertyOptional({ example: 'Monitored locally — situation under control' })
  @IsOptional()
  @IsString()
  wardComment?: string;
}
