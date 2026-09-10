import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CampaignRole } from '@electromon/shared';
import type { JwtPayload } from '@electromon/shared';
import { AuditAction } from '../../common/audit/audit.decorators';
import { Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiErrorResponseDto, MessageResponseDto } from '../../common/dto/api-response.dto';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/swagger.config';
import {
  CreateSituationUpdateDto,
  ListSituationUpdatesQueryDto,
  PulseActionDto,
  PulseMeQueryDto,
  PulseRollupQueryDto,
  PulseUnitsQueryDto,
  SituationSummaryQueryDto,
  UpdateSituationUpdateDto,
} from './dto/situation-update.dto';
import {
  PulseRollupDto,
  SituationSummaryDto,
  SituationUpdateResponseDto,
} from './dto/situation-update-response.dto';
import { SituationRoomService } from './situation-room.service';

const PULSE_WRITE_ROLES = [
  CampaignRole.CAMPAIGN_DIRECTOR,
  CampaignRole.STATE_COLLATION_OFFICER,
  CampaignRole.LGA_COLLATION_OFFICER,
  CampaignRole.WARD_RA_OFFICER,
  CampaignRole.POLLING_AGENT_COORDINATOR,
  CampaignRole.POLLING_AGENT,
] as const;

@ApiTags('situation-room')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@Controller('situation-room')
export class SituationRoomController {
  constructor(private situationRoomService: SituationRoomService) {}

  @Get('pulse/me')
  @ApiOperation({ summary: 'Latest pulse for the assigned polling unit' })
  getMyPulse(@CurrentUser() user: JwtPayload, @Query() query: PulseMeQueryDto) {
    return this.situationRoomService.getMyPulse(user, query.campaignId);
  }

  @Post('pulse/check-in')
  @Roles(...PULSE_WRITE_ROLES)
  @AuditAction('situation_update.check_in')
  @ApiOperation({ summary: 'One-tap arrival at the assigned polling unit' })
  @ApiCreatedResponse({ type: SituationUpdateResponseDto })
  checkIn(@CurrentUser() user: JwtPayload, @Body() dto: PulseActionDto) {
    return this.situationRoomService.checkIn(user, dto);
  }

  @Post('pulse/heartbeat')
  @Roles(...PULSE_WRITE_ROLES)
  @AuditAction('situation_update.heartbeat')
  @ApiOperation({ summary: 'Keep the unit live without changing answers' })
  heartbeat(@CurrentUser() user: JwtPayload, @Body() dto: PulseActionDto) {
    return this.situationRoomService.heartbeat(user, dto);
  }

  @Get('pulse/units')
  @ApiOperation({ summary: 'Latest pulse per polling unit in a ward or LGA' })
  listUnits(@CurrentUser() user: JwtPayload, @Query() query: PulseUnitsQueryDto) {
    return this.situationRoomService.listPulseUnits(user, query);
  }

  @Get('pulse/units/:pollingUnitId/history')
  @ApiOperation({ summary: 'Pulse history for one polling unit' })
  @ApiQuery({ name: 'campaignId', required: true })
  history(
    @CurrentUser() user: JwtPayload,
    @Param('pollingUnitId') pollingUnitId: string,
    @Query('campaignId') campaignId: string,
  ) {
    return this.situationRoomService.listPulseHistory(user, campaignId, pollingUnitId);
  }

  @Get('pulse')
  @ApiOperation({ summary: 'Process and rival-play rollup for a scope' })
  @ApiOkResponse({ type: PulseRollupDto })
  pulse(@CurrentUser() user: JwtPayload, @Query() query: PulseRollupQueryDto) {
    return this.situationRoomService.getPulseRollup(user, query);
  }

  @Get('summary')
  @ApiOperation({ summary: 'Election day situation summary' })
  @ApiOkResponse({ type: SituationSummaryDto })
  summary(@CurrentUser() user: JwtPayload, @Query() query: SituationSummaryQueryDto) {
    return this.situationRoomService.getSummary(user, query.campaignId);
  }

  @Get('updates')
  @ApiOperation({ summary: 'List situation updates for a campaign' })
  @ApiOkResponse({ type: [SituationUpdateResponseDto] })
  list(@CurrentUser() user: JwtPayload, @Query() query: ListSituationUpdatesQueryDto) {
    return this.situationRoomService.list(user, query);
  }

  @Get('updates/:id')
  @ApiOperation({ summary: 'Get situation update by ID' })
  @ApiQuery({ name: 'campaignId', required: true })
  @ApiOkResponse({ type: SituationUpdateResponseDto })
  findOne(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('campaignId') campaignId: string,
  ) {
    return this.situationRoomService.findOne(user, id, campaignId);
  }

  @Post('updates')
  @Roles(...PULSE_WRITE_ROLES)
  @AuditAction('situation_update.create')
  @ApiOperation({ summary: 'Post an election-day pulse from the field' })
  @ApiCreatedResponse({ type: SituationUpdateResponseDto })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateSituationUpdateDto) {
    return this.situationRoomService.create(user, dto);
  }

  @Patch('updates/:id')
  @Roles(...PULSE_WRITE_ROLES)
  @AuditAction('situation_update.update')
  @ApiOperation({ summary: 'Update a situation update' })
  @ApiOkResponse({ type: SituationUpdateResponseDto })
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateSituationUpdateDto,
  ) {
    return this.situationRoomService.update(user, id, dto);
  }

  @Delete('updates/:id')
  @Roles(CampaignRole.CAMPAIGN_DIRECTOR, CampaignRole.STATE_COLLATION_OFFICER)
  @AuditAction('situation_update.delete')
  @ApiOperation({ summary: 'Delete a situation update' })
  @ApiQuery({ name: 'campaignId', required: true })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  remove(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('campaignId') campaignId: string,
  ) {
    return this.situationRoomService.remove(user, id, campaignId);
  }
}
