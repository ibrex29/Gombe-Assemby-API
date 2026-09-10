import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CampaignRole, ScopeType } from '@electromon/shared';
import type { JwtPayload } from '@electromon/shared';
import { AuditAction } from '../../../common/audit/audit.decorators';
import { Roles } from '../../../common/decorators/auth.decorators';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { SWAGGER_BEARER_AUTH } from '../../../common/swagger/swagger.config';
import {
  DRILL_LEVEL_TO_COLLATION,
  TriageAcknowledgeDto,
  TriageTransitionsQueryDto,
  SWEEP_LEVEL_TO_COLLATION,
  TriageChildrenQueryDto,
  TriageOverviewQueryDto,
  TriageRescoreDto,
  TriageScopeQueryDto,
  TriageSweepLevel,
} from './dto/triage.dto';
import { TriageService } from './triage.service';

/** Reading a risk board is broader than rescoring it. */
const READ_ROLES = [
  CampaignRole.CANDIDATE,
  CampaignRole.CAMPAIGN_DIRECTOR,
  CampaignRole.DATA_ANALYST,
  CampaignRole.STATE_COLLATION_OFFICER,
  CampaignRole.NATIONAL_COLLATION_OFFICER,
] as const;

@ApiTags('ai')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@Controller('ai/triage')
export class TriageController {
  constructor(private triageService: TriageService) {}

  @Get('overview')
  @Roles(...READ_ROLES)
  @ApiOperation({
    summary: 'Risk board — every scored scope, worst first',
    description: 'Reads stored scores; never recomputes on read.',
  })
  overview(
    @CurrentUser() user: JwtPayload,
    @Query() query: TriageOverviewQueryDto,
  ) {
    const level =
      SWEEP_LEVEL_TO_COLLATION[query.level ?? TriageSweepLevel.STATE];
    return this.triageService.overview(user, level, query.riskLevel);
  }

  @Get('children')
  @Roles(...READ_ROLES)
  // Unlike the board, this scores on the way in, so it is metered tighter.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Drill into a scope: wards of an LGA, or polling units of a ward',
    description:
      'Scores the children on demand. Wards and polling units are never swept wholesale.',
  })
  children(
    @CurrentUser() user: JwtPayload,
    @Query() query: TriageChildrenQueryDto,
  ) {
    return this.triageService.children(
      user,
      DRILL_LEVEL_TO_COLLATION[query.level],
      query.parentId,
      query.electionMode ?? true,
    );
  }

  @Get('transitions')
  @Roles(...READ_ROLES)
  @ApiOperation({
    summary: 'Recent risk movements — what changed since you last looked',
    description:
      'RAISED means the band got worse by the risk ladder, not by score. Rows carry whether the move has since been acknowledged.',
  })
  transitions(
    @CurrentUser() user: JwtPayload,
    @Query() query: TriageTransitionsQueryDto,
  ) {
    return this.triageService.transitions(user, {
      limit: query.limit,
      direction: query.direction,
    });
  }

  @Post('scopes/:scopeType/:scopeId/acknowledge')
  @Roles(
    CampaignRole.CANDIDATE,
    CampaignRole.CAMPAIGN_DIRECTOR,
    CampaignRole.STATE_COLLATION_OFFICER,
    CampaignRole.LGA_COLLATION_OFFICER,
    CampaignRole.WARD_RA_OFFICER,
  )
  @AuditAction('ai.triage.acknowledge')
  @ApiOperation({
    summary: 'Take responsibility for a hot scope',
    description:
      'Records who has it and an optional note. A later risk movement voids the acknowledgement automatically.',
  })
  acknowledge(
    @CurrentUser() user: JwtPayload,
    @Param('scopeType') scopeType: ScopeType,
    @Param('scopeId') scopeId: string,
    @Body() dto: TriageAcknowledgeDto,
  ) {
    return this.triageService.acknowledge(user, scopeType, scopeId, dto.note);
  }

  @Get('scopes/:scopeId')
  @Roles(...READ_ROLES)
  @ApiOperation({ summary: 'One scope, with its recent score history' })
  scope(
    @CurrentUser() user: JwtPayload,
    @Param('scopeId') scopeId: string,
    @Query() query: TriageScopeQueryDto,
  ) {
    return this.triageService.scopeDetail(user, query.scopeType, scopeId);
  }

  @Post('rescore')
  @Roles(CampaignRole.CAMPAIGN_DIRECTOR, CampaignRole.DATA_ANALYST)
  @AuditAction('ai.triage.rescore')
  // A sweep touches every scope at a level; metered well below the global default.
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @ApiOperation({ summary: 'Recompute scores for a level' })
  async rescore(
    @CurrentUser() user: JwtPayload,
    @Body() dto: TriageRescoreDto,
  ) {
    const level = SWEEP_LEVEL_TO_COLLATION[dto.level ?? TriageSweepLevel.STATE];
    return this.triageService.rescore(
      user.campaignId!,
      level,
      dto.electionMode ?? true,
      // A manual rescore is somebody's action, so its movements notify.
      user.sub,
    );
  }
}
