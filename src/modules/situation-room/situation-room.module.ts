import { Module } from '@nestjs/common';
import { SituationRoomController } from './situation-room.controller';
import { SituationRoomService } from './situation-room.service';
import { PulseGeoService } from './pulse-geo.service';
import { PulseReminderSchedulerService } from './pulse-reminder-scheduler.service';

@Module({
  controllers: [SituationRoomController],
  providers: [SituationRoomService, PulseGeoService, PulseReminderSchedulerService],
  exports: [SituationRoomService, PulseGeoService],
})
export class SituationRoomModule {}
