import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CampaignRole, CollationDashboardMeta, ScopeType } from '@electromon/shared';

export class CollationDashboardDto implements CollationDashboardMeta {
  @ApiProperty({ example: 'POLLING_UNIT' })
  level: CollationDashboardMeta['level'];

  @ApiProperty({ example: 'Polling Unit (PU)' })
  levelLabel: string;

  @ApiProperty({ example: 1 })
  levelOrder: number;

  @ApiProperty({ enum: ScopeType, example: ScopeType.POLLING_UNIT })
  scopeType: ScopeType;

  @ApiPropertyOptional({ example: 'cms147za8001xww9ktd46y7m0' })
  scopeId?: string;

  @ApiPropertyOptional({ example: 'Hadejia Central PU 001 (JI-HD-001)' })
  scopeName?: string;

  @ApiProperty({ example: true })
  canSubmit: boolean;

  @ApiProperty({ example: false })
  canApprove: boolean;

  @ApiProperty({ example: false })
  canComment: boolean;

  @ApiProperty({ example: false })
  canRequestCorrection: boolean;

  @ApiPropertyOptional({ example: 'WARD' })
  approvesFromLevel?: CollationDashboardMeta['approvesFromLevel'];

  @ApiPropertyOptional({ example: 'WARD' })
  submitsToLevel?: CollationDashboardMeta['submitsToLevel'];

  @ApiProperty({ example: '/dashboard/polling-unit' })
  route: string;
}

export class AuthUserDto {
  @ApiProperty({ example: 'cms147za8001xww9ktd46y7m0' })
  id: string;

  @ApiProperty({ example: 'director@electromon.ng' })
  email: string;

  @ApiPropertyOptional({ example: '+2348000000001' })
  phoneNumber?: string | null;

  @ApiProperty({ example: 'Campaign' })
  firstName: string;

  @ApiProperty({ example: 'Director' })
  lastName: string;

  @ApiPropertyOptional({ enum: CampaignRole, example: CampaignRole.CAMPAIGN_DIRECTOR })
  role?: CampaignRole;

  @ApiPropertyOptional({ enum: ScopeType, example: ScopeType.CAMPAIGN })
  scopeType?: ScopeType;

  @ApiPropertyOptional({ example: 'cms147z3t001www9ktkqgluw0' })
  scopeId?: string;

  @ApiPropertyOptional({ example: 'cms147z3t001www9ktkqgluw0' })
  campaignId?: string;

  @ApiProperty({ example: false })
  mfaEnabled: boolean;

  @ApiPropertyOptional({ type: CollationDashboardDto })
  dashboard?: CollationDashboardDto;
}

export class LoginResponseDto {
  @ApiProperty({ type: AuthUserDto })
  user: AuthUserDto;

  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'JWT access token (15 min expiry)',
  })
  accessToken: string;

  @ApiProperty({
    example: '8074ffa26b5199ff401b29bad6ce4061cc5c49892821435df994085521c324c8351a17183072c0b46ec6323a0e9f9251',
    description: 'Refresh token (7 day expiry)',
  })
  refreshToken: string;
}

export class RefreshTokenResponseDto {
  @ApiProperty()
  accessToken: string;

  @ApiProperty()
  refreshToken: string;
}

export class RegisterResponseDto {
  @ApiProperty({ example: 'cms147za8001xww9ktd46y7m0' })
  id: string;

  @ApiProperty({ example: 'user@example.com' })
  email: string;
}

export class CampaignMembershipDto {
  @ApiProperty({ example: 'cms147z3t001www9ktkqgluw0' })
  campaignId: string;

  @ApiProperty({ example: 'Jigawa State Campaign 2027' })
  campaignName: string;

  @ApiProperty({ enum: CampaignRole, example: CampaignRole.CAMPAIGN_DIRECTOR })
  role: CampaignRole;

  @ApiPropertyOptional({ enum: ScopeType, example: ScopeType.CAMPAIGN })
  scopeType?: ScopeType;

  @ApiPropertyOptional({ example: 'cms147z3t001www9ktkqgluw0' })
  scopeId?: string;

  @ApiPropertyOptional({ example: 'Hadejia Ward A' })
  scopeName?: string;

  @ApiPropertyOptional({ type: CollationDashboardDto })
  dashboard?: CollationDashboardDto;
}

export class SessionResponseDto {
  @ApiProperty({ example: 'cms147za8001xww9ktd46y7m0' })
  id: string;

  @ApiProperty({ example: 'director@electromon.ng' })
  email: string;

  @ApiProperty({ example: 'Campaign' })
  firstName: string;

  @ApiProperty({ example: 'Director' })
  lastName: string;

  @ApiProperty({ example: false })
  mfaEnabled: boolean;

  @ApiProperty({ type: [CampaignMembershipDto] })
  memberships: CampaignMembershipDto[];
}
