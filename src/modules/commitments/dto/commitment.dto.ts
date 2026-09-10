import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { CommitmentStatus } from '@electromon/db';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';

export class CreateCommitmentDto {
  @ApiProperty({ example: 'cms147z3t001www9ktkqgluw0' })
  @IsString()
  @IsNotEmpty()
  campaignId: string;

  @ApiProperty({ example: 'cms147z3t001www9ktkqgluw1' })
  @IsString()
  @IsNotEmpty()
  supportGroupId: string;

  @ApiProperty({ example: 'Mobilize 500 youth voters in Hadejia' })
  @IsString()
  @MinLength(3)
  title: string;

  @ApiPropertyOptional({ example: 'Door-to-door outreach before registration deadline' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 500 })
  @IsInt()
  @Min(1)
  targetValue: number;

  @ApiPropertyOptional({ example: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  currentValue?: number;

  @ApiProperty({ example: '2026-12-31' })
  @IsDateString()
  deadline: string;

  @ApiPropertyOptional({ enum: CommitmentStatus, default: CommitmentStatus.DRAFT })
  @IsOptional()
  @IsEnum(CommitmentStatus)
  status?: CommitmentStatus;
}

export class UpdateCommitmentDto extends PartialType(CreateCommitmentDto) {}

export class ListCommitmentsQueryDto {
  @ApiProperty({ example: 'cms147z3t001www9ktkqgluw0' })
  @IsString()
  @IsNotEmpty()
  campaignId: string;

  @ApiPropertyOptional({ enum: CommitmentStatus })
  @IsOptional()
  @IsEnum(CommitmentStatus)
  status?: CommitmentStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  supportGroupId?: string;

  @ApiPropertyOptional({ description: 'Search by title or description' })
  @IsOptional()
  @IsString()
  search?: string;
}
