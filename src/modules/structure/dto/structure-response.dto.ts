import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CountDto {
  @ApiProperty({ example: 27 })
  lgas?: number;

  @ApiProperty({ example: 1 })
  wards?: number;

  @ApiProperty({ example: 1 })
  pollingUnits?: number;

  @ApiProperty({ example: 0 })
  volunteers?: number;

  @ApiProperty({ example: 0 })
  supportGroups?: number;

  @ApiProperty({ example: 0 })
  fieldReports?: number;

  @ApiProperty({ example: 1 })
  campaigns?: number;
}

export class StateResponseDto {
  @ApiProperty({ example: 'cms147za8001xww9ktd46y7m0' })
  id: string;

  @ApiProperty({ example: 'Jigawa' })
  name: string;

  @ApiProperty({ example: 'JI' })
  code: string;

  @ApiPropertyOptional({ example: 'North West' })
  zone?: string | null;

  @ApiPropertyOptional({ type: CountDto })
  _count?: CountDto;
}

export class SenatorialDistrictDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Jigawa North West' })
  name: string;
}

export class LgaResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Hadejia' })
  name: string;

  @ApiProperty()
  stateId: string;

  @ApiPropertyOptional({ type: SenatorialDistrictDto })
  senatorialDistrict?: SenatorialDistrictDto;

  @ApiPropertyOptional({ type: CountDto })
  _count?: CountDto;
}

export class WardResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Hadejia Ward A' })
  name: string;

  @ApiProperty()
  lgaId: string;

  @ApiPropertyOptional({ example: 12.4534 })
  latitude?: number;

  @ApiPropertyOptional({ example: 10.0411 })
  longitude?: number;

  @ApiPropertyOptional({ type: CountDto })
  _count?: CountDto;
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

  @ApiPropertyOptional({ example: 12.4534 })
  latitude?: number;

  @ApiPropertyOptional({ example: 10.0411 })
  longitude?: number;

  @ApiProperty({ example: 'ACTIVE' })
  status: string;
}

export class CoverageStatsDto {
  @ApiProperty({ example: 'cms147z3t001www9ktkqgluw0' })
  campaignId: string;

  @ApiProperty({ example: 'Jigawa' })
  state: string;

  @ApiProperty({ example: 27 })
  totalLgas: number;

  @ApiProperty({ example: 1 })
  totalWards: number;

  @ApiProperty({ example: 1 })
  totalPollingUnits: number;

  @ApiProperty({ example: 1 })
  assignedCoordinators: number;
}

export class CampaignListItemDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Jigawa State Campaign 2027' })
  name: string;

  @ApiProperty({ example: 'jigawa-2027' })
  slug: string;

  @ApiProperty()
  stateId: string;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiPropertyOptional({ type: StateResponseDto })
  state?: StateResponseDto;

  @ApiPropertyOptional({ type: CountDto })
  _count?: CountDto;
}
