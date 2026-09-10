import { Module } from '@nestjs/common';
import { VolunteersController } from './volunteers.controller';
import { VolunteersService } from './volunteers.service';

@Module({
  controllers: [VolunteersController],
  providers: [VolunteersService],
})
export class VolunteersModule {}
