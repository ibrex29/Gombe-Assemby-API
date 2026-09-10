import { Module } from '@nestjs/common';
import { AgentsModule } from '../../agents/agents.module';
import { CollationModule } from '../../collation/collation.module';
import { SocialModule } from '../social/social.module';
import { TriageModule } from '../triage/triage.module';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';
import { AssistantThreadsService } from './assistant-threads.service';
import { ReadonlyDbService } from './sql/readonly-db.service';
import { EvidenceService } from './evidence/evidence.service';

// CollationModule exports CollationBrowseService, which the race-summary and
// incident-hotspot tools reuse instead of duplicating the aggregation rules.
@Module({
  imports: [AgentsModule, CollationModule, SocialModule, TriageModule],
  controllers: [AssistantController],
  providers: [AssistantService, AssistantThreadsService, ReadonlyDbService, EvidenceService],
})
export class AssistantModule {}
