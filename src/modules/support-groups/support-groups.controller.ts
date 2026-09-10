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
  CreateSupportGroupDto,
  ListSupportGroupsQueryDto,
  UpdateSupportGroupDto,
} from './dto/support-group.dto';
import { SupportGroupResponseDto } from './dto/support-group-response.dto';
import { SupportGroupsService } from './support-groups.service';

@ApiTags('support-groups')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@Controller('support-groups')
export class SupportGroupsController {
  constructor(private supportGroupsService: SupportGroupsService) {}

  @Get()
  @ApiOperation({ summary: 'List support groups for a Jigawa campaign' })
  @ApiOkResponse({ type: [SupportGroupResponseDto] })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  list(@CurrentUser() user: JwtPayload, @Query() query: ListSupportGroupsQueryDto) {
    return this.supportGroupsService.list(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get support group by ID' })
  @ApiOkResponse({ type: SupportGroupResponseDto })
  findOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.supportGroupsService.findOne(user, id);
  }

  @Post()
  @Roles(
    CampaignRole.CAMPAIGN_DIRECTOR,
    CampaignRole.STATE_COLLATION_OFFICER,
    CampaignRole.LGA_COLLATION_OFFICER,
  )
  @AuditAction('support_group.create')
  @ApiOperation({ summary: 'Register a new support group' })
  @ApiCreatedResponse({ type: SupportGroupResponseDto })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateSupportGroupDto) {
    return this.supportGroupsService.create(user, dto);
  }

  @Patch(':id')
  @Roles(
    CampaignRole.CAMPAIGN_DIRECTOR,
    CampaignRole.STATE_COLLATION_OFFICER,
    CampaignRole.LGA_COLLATION_OFFICER,
  )
  @AuditAction('support_group.update')
  @ApiOperation({ summary: 'Update a support group' })
  @ApiOkResponse({ type: SupportGroupResponseDto })
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateSupportGroupDto,
  ) {
    return this.supportGroupsService.update(user, id, dto);
  }

  @Delete(':id')
  @Roles(CampaignRole.CAMPAIGN_DIRECTOR, CampaignRole.STATE_COLLATION_OFFICER)
  @AuditAction('support_group.delete')
  @ApiOperation({ summary: 'Delete a support group' })
  @ApiOkResponse({ type: MessageResponseDto })
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.supportGroupsService.remove(user, id);
  }
}
