import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { JwtPayload } from '@electromon/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/swagger.config';
import { AnalyticsOverviewQueryDto } from './dto/analytics.dto';
import { AnalyticsOverviewDto } from './dto/analytics-response.dto';
import { AnalyticsService } from './analytics.service';

@ApiTags('analytics')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@Controller('analytics')
export class AnalyticsController {
  constructor(private analyticsService: AnalyticsService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Campaign KPIs and performance overview' })
  @ApiOkResponse({ type: AnalyticsOverviewDto })
  overview(@CurrentUser() user: JwtPayload, @Query() query: AnalyticsOverviewQueryDto) {
    return this.analyticsService.getOverview(user, query.campaignId);
  }
}
