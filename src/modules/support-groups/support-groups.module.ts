import { Module } from '@nestjs/common';
import { SupportGroupsController } from './support-groups.controller';
import { SupportGroupsService } from './support-groups.service';

@Module({
  controllers: [SupportGroupsController],
  providers: [SupportGroupsService],
})
export class SupportGroupsModule {}
