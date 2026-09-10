import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiSecurity,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CampaignRole } from '@electromon/shared';
import type { JwtPayload } from '@electromon/shared';
import { AuditAction } from '../../../common/audit/audit.decorators';
import { Public, Roles } from '../../../common/decorators/auth.decorators';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { SWAGGER_BEARER_AUTH } from '../../../common/swagger/swagger.config';
import {
  CreateSocialSourceDto,
  IngestSocialBatchDto,
  ListSocialPostsQueryDto,
  SocialSummaryQueryDto,
  UpdateSocialSourceDto,
} from './dto/social.dto';
import { SocialIngestGuard } from './social-ingest.guard';
import { SocialService } from './social.service';
import { PulseforgeSyncService } from './pulseforge/pulseforge-sync.service';

/** Roles allowed to manage and read social listening. */
const SOCIAL_ROLES = [
  CampaignRole.CAMPAIGN_DIRECTOR,
  CampaignRole.CANDIDATE,
  CampaignRole.MEDIA_TEAM,
  CampaignRole.DATA_ANALYST,
] as const;

@ApiTags('ai')
@Controller('ai/social')
export class SocialController {
  constructor(
    private socialService: SocialService,
    private pulseforge: PulseforgeSyncService,
  ) {}

  /**
   * Ingest endpoint for the external fetcher. Authenticated by service token
   * rather than a user JWT, so it is @Public() to the JWT guard and gated by
   * SocialIngestGuard instead.
   */
  @Post('ingest')
  @Public()
  @UseGuards(SocialIngestGuard)
  @ApiSecurity('social-ingest-token')
  @ApiOperation({
    summary: 'Ingest a batch of social posts (service token)',
    description:
      'Idempotent on (campaign, platform, externalId). Re-sending a post refreshes its ' +
      'text but preserves any analysis already computed.',
  })
  @ApiServiceUnavailableResponse({
    description: 'SOCIAL_INGEST_TOKEN is not configured',
  })
  ingest(@Body() dto: IngestSocialBatchDto) {
    return this.socialService.ingest(dto);
  }

  @Post('pulseforge/sync')
  @Roles(...SOCIAL_ROLES)
  @AuditAction('ai.social.sync')
  // Pulls the upstream aggregate; metered because it hits a third party.
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Pull the latest Pulseforge sentiment into scope snapshots',
    description:
      'Writes one snapshot per matched state and LGA, plus a campaign roll-up. Places with no upstream posts get no snapshot and stay "not measured".',
  })
  async syncPulseforge(@CurrentUser() user: JwtPayload) {
    return this.pulseforge.sync(user.campaignId!);
  }

  @Get('mood')
  @Roles(...SOCIAL_ROLES)
  @ApiOperation({
    summary: 'Public mood by state, with explicit coverage',
    description:
      'Reads stored snapshots. States with no upstream posts are absent from rows and counted in coverage, never shown as calm.',
  })
  mood(@CurrentUser() user: JwtPayload) {
    return this.pulseforge.mood(user.campaignId!);
  }

  @Get('feed')
  @Roles(...SOCIAL_ROLES)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Recent posts, proxied live from Pulseforge',
    description: 'Not mirrored locally; the board deep-links back for the full thread.',
  })
  feed(
    @Query('state') state?: string,
    @Query('lga') lga?: string,
    @Query('limit') limit?: string,
  ) {
    return this.pulseforge.feed({
      state,
      lga,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('mood/state/:code')
  @Roles(...SOCIAL_ROLES)
  @ApiOperation({
    summary: 'One state: its mood and every LGA in it that has a reading',
    description:
      'A state with no upstream posts still answers, with empty rows and its coverage — that is information, not an error.',
  })
  stateMood(@CurrentUser() user: JwtPayload, @Param('code') code: string) {
    return this.pulseforge.stateMood(user.campaignId!, code);
  }

  @Get('opinion')
  @Roles(...SOCIAL_ROLES)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Daily opinion index, national or per state' })
  opinion(@Query('state') state?: string) {
    return this.pulseforge.opinion(state);
  }

  @Get('voices')
  @Roles(...SOCIAL_ROLES)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Loudest accounts and the amplifiers who actually carry a message',
  })
  voices(@Query('state') state?: string) {
    return this.pulseforge.voices(state);
  }

  @Get('narratives')
  @Roles(...SOCIAL_ROLES)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Story clusters by growth',
    description: 'National only — the upstream ignores a state filter.',
  })
  narratives() {
    return this.pulseforge.narratives();
  }

  @Get('alerts')
  @Roles(...SOCIAL_ROLES)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: "Pulseforge's own detections, above the noise floor",
    description: 'Context only. These never feed the risk score.',
  })
  alerts() {
    return this.pulseforge.alerts();
  }

  @Get('stance')
  @Roles(...SOCIAL_ROLES)
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Pro / anti / neutral toward tracked figures',
    description:
      'Sentiment and stance differ: an angry post can be supportive. Polarization separates divisive from broadly disliked.',
  })
  stances() {
    return this.pulseforge.stances();
  }

  @Get('sources')
  @ApiBearerAuth(SWAGGER_BEARER_AUTH)
  @Roles(...SOCIAL_ROLES)
  @ApiOperation({ summary: 'List monitored social sources' })
  listSources(
    @CurrentUser() user: JwtPayload,
    @Query('campaignId') campaignId: string,
  ) {
    return this.socialService.listSources(user, campaignId);
  }

  @Post('sources')
  @ApiBearerAuth(SWAGGER_BEARER_AUTH)
  @Roles(...SOCIAL_ROLES)
  @AuditAction('ai.social.source_create')
  @ApiOperation({ summary: 'Add a social source to monitor' })
  createSource(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateSocialSourceDto,
  ) {
    return this.socialService.createSource(user, dto);
  }

  @Patch('sources/:id')
  @ApiBearerAuth(SWAGGER_BEARER_AUTH)
  @Roles(...SOCIAL_ROLES)
  @AuditAction('ai.social.source_update')
  @ApiOperation({ summary: 'Update or deactivate a social source' })
  updateSource(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateSocialSourceDto,
  ) {
    return this.socialService.updateSource(user, id, dto);
  }

  @Get('posts')
  @ApiBearerAuth(SWAGGER_BEARER_AUTH)
  @Roles(...SOCIAL_ROLES)
  @ApiOperation({ summary: 'List captured posts with sentiment' })
  listPosts(
    @CurrentUser() user: JwtPayload,
    @Query() query: ListSocialPostsQueryDto,
  ) {
    return this.socialService.listPosts(user, query);
  }

  @Get('summary')
  @ApiBearerAuth(SWAGGER_BEARER_AUTH)
  @Roles(...SOCIAL_ROLES)
  @ApiOperation({ summary: 'Latest sentiment window and ingest counts' })
  getSummary(
    @CurrentUser() user: JwtPayload,
    @Query() query: SocialSummaryQueryDto,
  ) {
    return this.socialService.getSummary(user, query.campaignId);
  }
}
