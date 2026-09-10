import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { SocialPlatform, SocialSentiment } from '@electromon/shared';

export class IngestSocialPostDto {
  @ApiProperty({ enum: SocialPlatform })
  @IsEnum(SocialPlatform)
  platform: SocialPlatform;

  @ApiProperty({ description: "The platform's own id for this post." })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  externalId: string;

  @ApiProperty({ description: 'Must match an existing SocialSource handle.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  sourceHandle: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  authorHandle?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000)
  text: string;

  @ApiPropertyOptional({ example: 'en' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  lang?: string;

  @ApiProperty({ example: '2026-08-20T09:15:00.000Z' })
  @IsDateString()
  postedAt: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  permalink?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  mediaUrls?: string[];

  @ApiPropertyOptional({
    description: 'Original platform payload, stored verbatim.',
  })
  @IsOptional()
  @IsObject()
  raw?: Record<string, unknown>;
}

export class IngestSocialBatchDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  campaignId: string;

  @ApiProperty({ type: [IngestSocialPostDto], maxItems: 200 })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => IngestSocialPostDto)
  posts: IngestSocialPostDto[];
}

export class CreateSocialSourceDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  campaignId: string;

  @ApiProperty({ enum: SocialPlatform })
  @IsEnum(SocialPlatform)
  platform: SocialPlatform;

  @ApiProperty({ example: 'danmodi2027' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  handle: string;

  @ApiProperty({ example: 'Dan-Modi Campaign Page' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  displayName: string;

  @ApiPropertyOptional({
    description:
      'Fetcher settings (poll interval, keywords). Never raw secrets.',
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class UpdateSocialSourceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  displayName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class ListSocialPostsQueryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  campaignId: string;

  @ApiPropertyOptional({ enum: SocialSentiment })
  @IsOptional()
  @IsEnum(SocialSentiment)
  sentiment?: SocialSentiment;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class SocialSummaryQueryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  campaignId: string;
}
