import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VolunteerWardLgaDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Hadejia' })
  name: string;
}

export class VolunteerWardDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Hadejia Ward A' })
  name: string;

  @ApiPropertyOptional({ type: VolunteerWardLgaDto })
  lga?: VolunteerWardLgaDto | null;
}

export class VolunteerResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  campaignId: string;

  @ApiProperty({ example: 'Amina' })
  firstName: string;

  @ApiProperty({ example: 'Yusuf' })
  lastName: string;

  @ApiProperty({ example: '+2348012345678' })
  phoneNumber: string;

  @ApiPropertyOptional({ example: 'amina@example.com' })
  email?: string | null;

  @ApiPropertyOptional()
  wardId?: string | null;

  @ApiPropertyOptional({ type: VolunteerWardDto })
  ward?: VolunteerWardDto | null;

  @ApiPropertyOptional({ example: 'CANVASSER' })
  role?: string | null;

  @ApiProperty({ example: 0 })
  performanceScore: number;

  @ApiProperty({ example: false })
  isVerified: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
