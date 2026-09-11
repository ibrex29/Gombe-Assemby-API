import { Module } from '@nestjs/common';
import { FieldReportsController } from './field-reports.controller';
import { FieldReportsService } from './field-reports.service';
import { VoiceIncidentWorker } from './voice-incident.worker';
import { SituationRoomModule } from '../situation-room/situation-room.module';

@Module({
  imports: [SituationRoomModule],
  controllers: [FieldReportsController],
  providers: [FieldReportsService, VoiceIncidentWorker],
  exports: [FieldReportsService],
})
export class FieldReportsModule {}
