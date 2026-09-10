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
  CreatePollingUnitDto,
  ListPollingUnitsQueryDto,
  UpdatePollingUnitDto,
} from './dto/polling-unit.dto';
import { PollingUnitResponseDto } from './dto/polling-unit-response.dto';
import { PollingUnitsService } from './polling-units.service';

@ApiTags('polling-units')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@Controller('polling-units')
export class PollingUnitsController {
  constructor(private pollingUnitsService: PollingUnitsService) {}

  @Get()
  @ApiOperation({ summary: 'List polling units for a Jigawa campaign' })
  @ApiOkResponse({ type: [PollingUnitResponseDto] })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  list(@CurrentUser() user: JwtPayload, @Query() query: ListPollingUnitsQueryDto) {
    return this.pollingUnitsService.list(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get polling unit by ID' })
  @ApiQuery({ name: 'campaignId', required: true })
  @ApiOkResponse({ type: PollingUnitResponseDto })
  findOne(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('campaignId') campaignId: string,
  ) {
    return this.pollingUnitsService.findOne(user, id, campaignId);
  }

  @Post()
  @Roles(
    CampaignRole.CAMPAIGN_DIRECTOR,
    CampaignRole.STATE_COLLATION_OFFICER,
    CampaignRole.LGA_COLLATION_OFFICER,
    CampaignRole.WARD_RA_OFFICER,
    CampaignRole.POLLING_AGENT_COORDINATOR,
  )
  @AuditAction('polling_unit.create')
  @ApiOperation({ summary: 'Register a polling unit' })
  @ApiCreatedResponse({ type: PollingUnitResponseDto })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreatePollingUnitDto) {
    return this.pollingUnitsService.create(user, dto);
  }

  @Patch(':id')
  @Roles(
    CampaignRole.CAMPAIGN_DIRECTOR,
    CampaignRole.STATE_COLLATION_OFFICER,
    CampaignRole.LGA_COLLATION_OFFICER,
    CampaignRole.WARD_RA_OFFICER,
    CampaignRole.POLLING_AGENT_COORDINATOR,
    CampaignRole.POLLING_AGENT,
  )
  @AuditAction('polling_unit.update')
  @ApiOperation({ summary: 'Update polling unit intelligence' })
  @ApiOkResponse({ type: PollingUnitResponseDto })
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdatePollingUnitDto,
  ) {
    return this.pollingUnitsService.update(user, id, dto);
  }

  @Delete(':id')
  @Roles(CampaignRole.CAMPAIGN_DIRECTOR, CampaignRole.STATE_COLLATION_OFFICER)
  @AuditAction('polling_unit.delete')
  @ApiOperation({ summary: 'Delete a polling unit' })
  @ApiQuery({ name: 'campaignId', required: true })
  @ApiOkResponse({ type: MessageResponseDto })
  remove(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('campaignId') campaignId: string,
  ) {
    return this.pollingUnitsService.remove(user, id, campaignId);
  }
}
