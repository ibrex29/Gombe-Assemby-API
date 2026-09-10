import { Module } from '@nestjs/common';
import { PollingUnitsController } from './polling-units.controller';
import { PollingUnitsService } from './polling-units.service';

@Module({
  controllers: [PollingUnitsController],
  providers: [PollingUnitsService],
})
export class PollingUnitsModule {}
