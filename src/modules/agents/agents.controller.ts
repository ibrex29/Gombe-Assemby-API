import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CampaignRole, ScopeType, type JwtPayload } from '@electromon/shared';
import { Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/swagger.config';
import { AgentsService } from './agents.service';
import {
  AgentResponseDto,
  CreateAgentDto,
  ListAgentsQueryDto,
  UpdateAgentDto,
  ScopeContactsQueryDto,
} from './dto/agents.dto';

const AGENT_VIEW_ROLES = [
  CampaignRole.CAMPAIGN_DIRECTOR,
  CampaignRole.CANDIDATE,
  CampaignRole.STATE_COLLATION_OFFICER,
  CampaignRole.LGA_COLLATION_OFFICER,
  CampaignRole.WARD_RA_OFFICER,
] as const;

const AGENT_MANAGE_ROLES = [
  CampaignRole.CAMPAIGN_DIRECTOR,
  CampaignRole.CANDIDATE,
  CampaignRole.STATE_COLLATION_OFFICER,
] as const;

@ApiTags('agents')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@Controller('agents')
export class AgentsController {
  constructor(private agentsService: AgentsService) {}

  @Get('options')
  @Roles(...AGENT_VIEW_ROLES)
  @ApiOperation({
    summary:
      'List wards/PUs for filters (LGA/admin) or own ward PUs (ward coordinator)',
  })
  listOptions(
    @CurrentUser() user: JwtPayload,
    @Query('campaignId') campaignId: string,
    @Query('lgaId') lgaId?: string,
  ) {
    return this.agentsService.listOptions(user, campaignId, lgaId);
  }

  @Get()
  @Roles(...AGENT_VIEW_ROLES)
  @ApiOperation({
    summary:
      'List agents (admin: state/LGA/ward/PU; LGA: ward+PU; ward coordinator: PU agents)',
  })
  @ApiOkResponse({ type: [AgentResponseDto] })
  list(@CurrentUser() user: JwtPayload, @Query() query: ListAgentsQueryDto) {
    return this.agentsService.list(user, query);
  }

  @Get('contacts')
  @Roles(...AGENT_VIEW_ROLES)
  @ApiOperation({
    summary: 'Who is responsible for a place, nearest first, then up the chain',
    description:
      'Returns the polling unit agent, ward coordinator, LGA and state officers for a scope, so an incident can be escalated without a second lookup.',
  })
  scopeContacts(
    @CurrentUser() user: JwtPayload,
    @Query() query: ScopeContactsQueryDto,
  ) {
    return this.agentsService.getScopeContacts(
      user,
      query.campaignId,
      query.scopeType as unknown as ScopeType,
      query.scopeId,
    );
  }

  @Get(':membershipId/activities')
  @Roles(...AGENT_VIEW_ROLES)
  @ApiOperation({ summary: 'Collation and incident activity for an agent' })
  listActivities(
    @CurrentUser() user: JwtPayload,
    @Param('membershipId') membershipId: string,
  ) {
    return this.agentsService.listActivities(user, membershipId);
  }

  @Post()
  @Roles(...AGENT_MANAGE_ROLES)
  @ApiOperation({
    summary:
      'Create or assign a state / LGA / ward coordinator or polling unit agent (admin or state coordinator within scope)',
  })
  @ApiOkResponse({ type: AgentResponseDto })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateAgentDto) {
    return this.agentsService.create(user, dto);
  }

  @Patch(':membershipId')
  @Roles(...AGENT_MANAGE_ROLES)
  @ApiOperation({
    summary:
      'Update a state / LGA / ward coordinator or polling unit agent (admin or state coordinator within scope)',
  })
  @ApiOkResponse({ type: AgentResponseDto })
  update(
    @CurrentUser() user: JwtPayload,
    @Param('membershipId') membershipId: string,
    @Body() dto: UpdateAgentDto,
  ) {
    return this.agentsService.update(user, membershipId, dto);
  }
}
