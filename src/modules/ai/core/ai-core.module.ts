import { Global, Module } from '@nestjs/common';
import { OpenRouterClient } from './llm/openrouter.client';

/**
 * Shared AI plumbing. Global so every AI submodule (assistant, social, and
 * triage later) resolves one provider instance rather than each building its own.
 */
@Global()
@Module({
  providers: [OpenRouterClient],
  exports: [OpenRouterClient],
})
export class AiCoreModule {}
