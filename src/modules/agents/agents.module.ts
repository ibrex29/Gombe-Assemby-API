import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

@Module({
  controllers: [AgentsController],
  providers: [AgentsService],
  // Exported so the assistant's contact-lookup tool reuses this service's
  // authorization rather than reimplementing who may see a phone number.
  exports: [AgentsService],
})
export class AgentsModule {}
