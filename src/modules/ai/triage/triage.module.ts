import { Module } from '@nestjs/common';
import { TriageController } from './triage.controller';
import { TriageService } from './triage.service';
import { TriageTriggerService } from './triage-trigger.service';
import { TriageInputCollectorService } from './triage-input-collector.service';
import { TriageSchedulerService } from './triage-scheduler.service';

@Module({
  controllers: [TriageController],
  providers: [
    TriageService,
    TriageInputCollectorService,
    TriageSchedulerService,
    TriageTriggerService,
  ],
  exports: [TriageService],
})
export class TriageModule {}
