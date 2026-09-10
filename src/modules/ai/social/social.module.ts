import { Module } from '@nestjs/common';
import { SocialController } from './social.controller';
import { SocialService } from './social.service';
import { PulseforgeClient } from './pulseforge/pulseforge.client';
import { PulseforgeSyncService } from './pulseforge/pulseforge-sync.service';
import { SocialQueueService } from './social-queue.service';
import { SocialAnalyzeWorker } from './social-analyze.worker';
import { SocialIngestGuard } from './social-ingest.guard';

@Module({
  controllers: [SocialController],
  providers: [
    SocialService,
    SocialQueueService,
    SocialAnalyzeWorker,
    SocialIngestGuard,
    PulseforgeClient,
    PulseforgeSyncService,
  ],
  exports: [PulseforgeSyncService, SocialService],
})
export class SocialModule {}
