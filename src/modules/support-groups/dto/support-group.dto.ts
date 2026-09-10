import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { SupportGroupCategory, VerificationStatus } from '@electromon/shared';

export class CreateSupportGroupDto {
  @ApiProperty({ example: 'cms147z3t001www9ktkqgluw0' })
  @IsString()
  @IsNotEmpty()
  campaignId: string;

  @ApiProperty({ example: 'Hadejia Youth Forum' })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiProperty({ enum: SupportGroupCategory, example: SupportGroupCategory.YOUTH })
  @IsEnum(SupportGroupCategory)
  category: SupportGroupCategory;

  @ApiProperty({ example: 'Ibrahim Musa' })
  @IsString()
  @MinLength(2)
  leaderName: string;

  @ApiProperty({ example: '+2348012345678' })
  @IsString()
  @MinLength(7)
  leaderPhone: string;

  @ApiPropertyOptional({ example: 'leader@example.com' })
  @IsOptional()
  @IsEmail()
  leaderEmail?: string;

  @ApiPropertyOptional({ example: 120, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  memberCount?: number;

  @ApiPropertyOptional({ description: 'Jigawa LGA ID' })
  @IsOptional()
  @IsString()
  lgaId?: string;

  @ApiPropertyOptional({ example: 'Hadejia town and surrounds' })
  @IsOptional()
  @IsString()
  areaOfOperation?: string;
}

export class UpdateSupportGroupDto extends PartialType(CreateSupportGroupDto) {
  @ApiPropertyOptional({ enum: VerificationStatus })
  @IsOptional()
  @IsEnum(VerificationStatus)
  verificationStatus?: VerificationStatus;
}

export class ListSupportGroupsQueryDto {
  @ApiProperty({ example: 'cms147z3t001www9ktkqgluw0' })
  @IsString()
  @IsNotEmpty()
  campaignId: string;

  @ApiPropertyOptional({ enum: SupportGroupCategory })
  @IsOptional()
  @IsEnum(SupportGroupCategory)
  category?: SupportGroupCategory;

  @ApiPropertyOptional({ enum: VerificationStatus })
  @IsOptional()
  @IsEnum(VerificationStatus)
  verificationStatus?: VerificationStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  lgaId?: string;

  @ApiPropertyOptional({ description: 'Search by name or leader' })
  @IsOptional()
  @IsString()
  search?: string;
}
