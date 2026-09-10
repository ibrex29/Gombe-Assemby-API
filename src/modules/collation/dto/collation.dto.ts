import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsInt, IsObject, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class CreateCollationResultDto {
  @ApiPropertyOptional({ example: 289, description: 'EC8A: Number of Voters on the Register' })
  @IsOptional()
  @IsInt()
  @Min(0)
  registeredVoters?: number;

  @ApiPropertyOptional({ example: 210, description: 'EC8A: Number of Accredited Voters' })
  @IsOptional()
  @IsInt()
  @Min(0)
  accreditedVoters?: number;

  @ApiPropertyOptional({
    example: 289,
    description: 'EC8A: Number of Ballot Papers Issued to the Polling Unit',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  ballotPapersIssued?: number;

  @ApiPropertyOptional({ example: 79, description: 'EC8A: Number of Unused Ballot Papers' })
  @IsOptional()
  @IsInt()
  @Min(0)
  unusedBallotPapers?: number;

  @ApiPropertyOptional({ example: 0, description: 'EC8A: Number of Spoiled Ballot Papers' })
  @IsOptional()
  @IsInt()
  @Min(0)
  spoiledBallotPapers?: number;

  @ApiPropertyOptional({ example: 3, description: 'EC8A: Number of Rejected Ballots' })
  @IsOptional()
  @IsInt()
  @Min(0)
  invalidVotes?: number;

  @ApiPropertyOptional({
    example: 207,
    description: 'EC8A: Number of Total Valid Votes (party totals)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  votesCast?: number;

  @ApiPropertyOptional({
    example: 210,
    description: 'EC8A: Total Number of Used Ballot Papers',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  usedBallotPapers?: number;

  @ApiPropertyOptional({
    example: { APC: 159, PDP: 40, ADC: 4 },
    description: 'Party vote totals keyed by party code',
  })
  @IsOptional()
  @IsObject()
  partyResults?: Record<string, number>;

  @ApiPropertyOptional({
    type: [String],
    description: 'URLs of uploaded EC8A form images — required before submission at PU level',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ec8aPhotoUrls?: string[];
}

export class AttachEc8aPhotoDto {
  @ApiProperty({ example: 'http://localhost:3001/uploads/abc.jpg' })
  @IsString()
  @MinLength(8)
  photoUrl: string;
}

export class ScanEc8aDto {
  @ApiProperty({ example: 'http://localhost:3001/uploads/abc.jpg' })
  @IsString()
  @MinLength(8)
  photoUrl: string;
}

export class ScanEc8aResponseDto {
  @ApiProperty({
    example: {
      registeredVoters: 289,
      accreditedVoters: 210,
      ballotPapersIssued: 289,
      unusedBallotPapers: 79,
      spoiledBallotPapers: 0,
      invalidVotes: 3,
      votesCast: 207,
      usedBallotPapers: 210,
    },
  })
  fields: Record<string, number | null>;

  @ApiProperty({ example: { APC: 159, PDP: 40, ADC: 4 } })
  partyResults: Record<string, number>;

  @ApiPropertyOptional({ example: 1, nullable: true })
  confidence: number | null;

  @ApiProperty({ example: false })
  unreadable: boolean;

  @ApiPropertyOptional({ example: null, nullable: true })
  error?: string;
}

export class ScanEc8aFileResponseDto extends ScanEc8aResponseDto {
  @ApiProperty({ example: 'http://192.168.1.10:3001/uploads/abc.jpg' })
  photoUrl: string;

  @ApiProperty({ example: 'http://192.168.1.10:3001/uploads/abc.jpg' })
  url: string;

  @ApiProperty({ example: 'abc.jpg' })
  filename: string;

  @ApiProperty({ example: 'image/jpeg' })
  mimeType: string;

  @ApiProperty({ example: 183879 })
  size: number;
}

export class RejectCollationResultDto {
  @ApiProperty({ example: 'Figures do not match signed EC8A form' })
  @IsString()
  reason: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Optional: ward ids in the LGA that State believes need correction (State → LGA return only)',
    example: ['clxyz…'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  affectedWardIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      'Optional: polling unit ids in the ward that LGA believes need correction (LGA → ward return only)',
    example: ['clxyz…'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  affectedPollingUnitIds?: string[];
}

export class ApproveCollationResultDto {
  @ApiPropertyOptional({ example: 'Figures verified against EC8A' })
  @IsOptional()
  @IsString()
  comment?: string;
}

export class CommentCollationResultDto {
  @ApiProperty({ example: 'Please confirm the unused ballot figure on the EC8A photo.' })
  @IsString()
  @MinLength(3)
  comment: string;
}

export class ReopenCollationResultDto {
  @ApiProperty({ example: 'Reopened for recount verification' })
  @IsString()
  reason: string;
}
