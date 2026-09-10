import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { JwtPayload } from '@electromon/shared';
import { IrevCommandCenterService } from './irev-command-center.service';
import { IrevResultsService } from './irev-results.service';
import { IrevService } from './irev.service';
import { IrevSweepService } from './irev-sweep.service';

@Controller('irev')
export class IrevController {
  constructor(
    private irev: IrevService,
    private commandCenter: IrevCommandCenterService,
    private results: IrevResultsService,
    private sweep: IrevSweepService,
  ) {}

  @Get('results')
  listResults(
    @CurrentUser() user: JwtPayload,
    @Query('status') status?: string,
    @Query('stateId') stateId?: string,
    @Query('lgaId') lgaId?: string,
    @Query('wardId') wardId?: string,
    @Query('zone') zone?: string,
    @Query('search') search?: string,
    @Query('sort') sort?: string,
    @Query('limit') limit?: string,
  ) {
    return this.results.listResults(user, {
      status,
      stateId,
      lgaId,
      wardId,
      zone,
      search,
      sort,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('race-analytics')
  getRaceAnalytics(@CurrentUser() user: JwtPayload, @Query('stateId') stateId?: string) {
    return this.results.getRaceAnalytics(user, stateId);
  }

  @Get('command-center')
  getCommandCenter(
    @CurrentUser() user: JwtPayload,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('lgaId') lgaId?: string,
    @Query('wardId') wardId?: string,
    @Query('stateId') stateId?: string,
    @Query('view') view?: string,
  ) {
    return this.commandCenter.getCommandCenter(user, {
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      search,
      status,
      lgaId,
      wardId,
      stateId,
      view,
    });
  }

  @Get('pu/:pollingUnitId')
  getPuSnapshot(@CurrentUser() user: JwtPayload, @Param('pollingUnitId') pollingUnitId: string) {
    return this.irev.getPuSnapshot(user, pollingUnitId);
  }

  @Post('refresh/:resultId')
  refreshResult(@CurrentUser() user: JwtPayload, @Param('resultId') resultId: string) {
    return this.irev.refreshResult(user, resultId);
  }

  @Post('refresh-pending')
  queuePendingChecks(
    @CurrentUser() user: JwtPayload,
    @Query('stateId') stateId?: string,
    @Query('lgaId') lgaId?: string,
    @Query('wardId') wardId?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    return this.commandCenter.queuePendingChecks(user, {
      stateId,
      lgaId,
      wardId,
      search,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('backfill-ocr')
  async backfillOcr(@CurrentUser() user: JwtPayload, @Query('limit') limit?: string) {
    const result = await this.sweep.enqueueOcrBackfill(limit ? Number(limit) : undefined);
    const campaignIds = user.campaignId ? [user.campaignId] : [];
    const status = await this.sweep.getOcrPipelineStatus(campaignIds);
    return { ...result, status };
  }

  @Get('ocr-status')
  async getOcrStatus(@CurrentUser() user: JwtPayload) {
    const campaignIds = user.campaignId ? [user.campaignId] : [];
    return this.sweep.getOcrPipelineStatus(campaignIds);
  }
}
