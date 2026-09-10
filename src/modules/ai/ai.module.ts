import { Module } from '@nestjs/common';
import { AiCoreModule } from './core/ai-core.module';
import { AssistantModule } from './assistant/assistant.module';
import { SocialModule } from './social/social.module';
import { TriageModule } from './triage/triage.module';

/**
 * The AI engine: one module group, several subroutines sharing a provider,
 * prompt conventions, and queue patterns.
 *
 *   assistant/ — grounded natural-language Q&A over campaign data
 *   social/    — social listening ingest + sentiment (fetcher implemented separately)
 *   triage/    — deterministic risk scoring per scope
 */
@Module({
  imports: [AiCoreModule, AssistantModule, SocialModule, TriageModule],
})
export class AiModule {}
