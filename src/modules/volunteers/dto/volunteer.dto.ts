import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export class CreateVolunteerDto {
  @ApiProperty({ example: 'cms147z3t001www9ktkqgluw0' })
  @IsString()
  @IsNotEmpty()
  campaignId: string;

  @ApiProperty({ example: 'Amina' })
  @IsString()
  @MinLength(2)
  firstName: string;

  @ApiProperty({ example: 'Yusuf' })
  @IsString()
  @MinLength(2)
  lastName: string;

  @ApiProperty({ example: '+2348012345678' })
  @IsString()
  @MinLength(7)
  phoneNumber: string;

  @ApiPropertyOptional({ example: 'amina@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ description: 'Jigawa ward ID' })
  @IsOptional()
  @IsString()
  wardId?: string;

  @ApiPropertyOptional({ example: 'CANVASSER' })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional({ example: 0, default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  performanceScore?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isVerified?: boolean;
}

export class UpdateVolunteerDto extends PartialType(CreateVolunteerDto) {}

export class ListVolunteersQueryDto {
  @ApiProperty({ example: 'cms147z3t001www9ktkqgluw0' })
  @IsString()
  @IsNotEmpty()
  campaignId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  wardId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  })
  @IsBoolean()
  isVerified?: boolean;

  @ApiPropertyOptional({ description: 'Search by name, phone, or email' })
  @IsOptional()
  @IsString()
  search?: string;
}
