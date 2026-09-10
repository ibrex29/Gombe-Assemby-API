import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SupportGroupCategory, VerificationStatus } from '@electromon/shared';

export class SupportGroupLgaDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Hadejia' })
  name: string;
}

export class SupportGroupResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  campaignId: string;

  @ApiProperty({ example: 'Hadejia Youth Forum' })
  name: string;

  @ApiProperty({ enum: SupportGroupCategory })
  category: SupportGroupCategory;

  @ApiProperty({ example: 'Ibrahim Musa' })
  leaderName: string;

  @ApiProperty({ example: '+2348012345678' })
  leaderPhone: string;

  @ApiPropertyOptional({ example: 'leader@example.com' })
  leaderEmail?: string | null;

  @ApiProperty({ example: 120 })
  memberCount: number;

  @ApiPropertyOptional()
  lgaId?: string | null;

  @ApiPropertyOptional({ type: SupportGroupLgaDto })
  lga?: SupportGroupLgaDto | null;

  @ApiPropertyOptional({ example: 'Hadejia town and surrounds' })
  areaOfOperation?: string | null;

  @ApiProperty({ enum: VerificationStatus })
  verificationStatus: VerificationStatus;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
