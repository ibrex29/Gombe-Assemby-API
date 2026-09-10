import { Module, forwardRef } from '@nestjs/common';
import { MetricsModule } from '../../common/metrics/metrics.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { CollationModule } from '../collation/collation.module';
import { IrevClient } from './irev.client';
import { IrevController } from './irev.controller';
import { IrevFetchWorker } from './irev-fetch.worker';
import { IrevGeoService } from './irev-geo.service';
import { IrevQueueService } from './irev-queue.service';
import { IrevRateLimiter } from './irev-rate-limiter';
import { IrevCommandCenterService } from './irev-command-center.service';
import { IrevOfficialStatsService } from './irev-official-stats.service';
import { IrevResultsService } from './irev-results.service';
import { IrevService } from './irev.service';
import { IrevSweepService } from './irev-sweep.service';
import { IrevElectionResolver } from './irev-election.resolver';

@Module({
  imports: [PrismaModule, MetricsModule, forwardRef(() => CollationModule)],
  controllers: [IrevController],
  providers: [
    IrevClient,
    IrevRateLimiter,
    IrevGeoService,
    IrevElectionResolver,
    IrevFetchWorker,
    IrevQueueService,
    IrevSweepService,
    IrevService,
    IrevOfficialStatsService,
    IrevCommandCenterService,
    IrevResultsService,
  ],
  exports: [IrevQueueService, IrevClient],
})
export class IrevModule {}
