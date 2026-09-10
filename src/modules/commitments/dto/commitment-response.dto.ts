import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CommitmentStatus } from '@electromon/db';

export class CommitmentSupportGroupDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'Hadejia Youth Forum' })
  name: string;
}

export class CommitmentResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  campaignId: string;

  @ApiProperty()
  supportGroupId: string;

  @ApiProperty({ type: CommitmentSupportGroupDto })
  supportGroup: CommitmentSupportGroupDto;

  @ApiProperty({ example: 'Mobilize 500 youth voters in Hadejia' })
  title: string;

  @ApiPropertyOptional()
  description?: string | null;

  @ApiProperty({ example: 500 })
  targetValue: number;

  @ApiProperty({ example: 120 })
  currentValue: number;

  @ApiProperty()
  deadline: Date;

  @ApiProperty({ enum: CommitmentStatus })
  status: CommitmentStatus;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
