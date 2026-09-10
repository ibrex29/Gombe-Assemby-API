import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CampaignRole } from '@electromon/shared';
import type { JwtPayload } from '@electromon/shared';
import { AuditAction } from '../../common/audit/audit.decorators';
import { Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/swagger.config';
import { CreateFieldReportDto, ListFieldReportsQueryDto, UpdateFieldReportStatusDto } from './dto/field-report.dto';
import { FieldReportsService } from './field-reports.service';

@ApiTags('field-reports')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@Controller('field-reports')
export class FieldReportsController {
  constructor(private fieldReportsService: FieldReportsService) {}

  @Get()
  @ApiOperation({ summary: 'List field reports for a campaign' })
  list(@CurrentUser() user: JwtPayload, @Query() query: ListFieldReportsQueryDto) {
    return this.fieldReportsService.list(user, query);
  }

  @Post()
  @Roles(
    CampaignRole.CAMPAIGN_DIRECTOR,
    CampaignRole.STATE_COLLATION_OFFICER,
    CampaignRole.LGA_COLLATION_OFFICER,
    CampaignRole.WARD_RA_OFFICER,
    CampaignRole.POLLING_AGENT,
    CampaignRole.VOLUNTEER,
    CampaignRole.VOLUNTEER_COORDINATOR,
  )
  @AuditAction('field_report.create')
  @ApiOperation({ summary: 'Submit a field report' })
  @ApiCreatedResponse({ description: 'Field report created' })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateFieldReportDto) {
    return this.fieldReportsService.create(user, dto);
  }

  @Patch(':id/status')
  @Roles(
    CampaignRole.CAMPAIGN_DIRECTOR,
    CampaignRole.STATE_COLLATION_OFFICER,
    CampaignRole.LGA_COLLATION_OFFICER,
    CampaignRole.WARD_RA_OFFICER,
  )
  @AuditAction('field_report.update_status')
  @ApiOperation({ summary: 'Escalate, resolve, or comment on a field report' })
  updateStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateFieldReportStatusDto,
  ) {
    return this.fieldReportsService.updateStatus(user, id, dto);
  }
}
