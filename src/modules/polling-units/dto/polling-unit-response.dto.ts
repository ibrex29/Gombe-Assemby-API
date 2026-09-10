import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PollingUnitStatus, PollingUnitStrength } from '@electromon/shared';

export class PollingUnitWardLgaDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Hadejia' })
  name: string;
}

export class PollingUnitWardDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Hadejia Ward A' })
  name: string;

  @ApiProperty({ type: PollingUnitWardLgaDto })
  lga: PollingUnitWardLgaDto;
}

export class AssignedAgentDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Amina' })
  firstName: string;

  @ApiProperty({ example: 'Yusuf' })
  lastName: string;
}

export class PollingUnitResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'JI-HD-001' })
  code: string;

  @ApiProperty({ example: 'Hadejia Central PU 001' })
  name: string;

  @ApiProperty()
  wardId: string;

  @ApiProperty({ type: PollingUnitWardDto })
  ward: PollingUnitWardDto;

  @ApiPropertyOptional({ example: 12.4534 })
  latitude?: number | null;

  @ApiPropertyOptional({ example: 10.0411 })
  longitude?: number | null;

  @ApiPropertyOptional({ enum: PollingUnitStrength })
  strengthAssessment?: PollingUnitStrength | null;

  @ApiProperty({ enum: PollingUnitStatus })
  status: PollingUnitStatus;

  @ApiPropertyOptional()
  assignedAgentId?: string | null;

  @ApiPropertyOptional({ type: AssignedAgentDto })
  assignedAgent?: AssignedAgentDto | null;

  @ApiPropertyOptional()
  notes?: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
