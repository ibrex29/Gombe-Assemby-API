import { ConfigService } from '@nestjs/config';
import { OpenRouterClient } from './openrouter.client';

describe('OpenRouterClient.getModelId', () => {
  it('uses Whisper for STT even when AI_STT_MODEL is a chat model', () => {
    const config = {
      get: (key: string) => {
        if (key === 'OPENROUTER_API_KEY') return 'sk-test';
        if (key === 'AI_MODEL') return 'minimax/minimax-m3';
        if (key === 'AI_STT_MODEL') return 'minimax/minimax-m3';
        return undefined;
      },
    } as unknown as ConfigService;

    const client = new OpenRouterClient(config);
    expect(client.getModelId('audio')).toBe('openai/whisper-large-v3');
    expect(client.getModelId('assistant')).toBe('minimax/minimax-m3');
  });

  it('keeps an explicit Whisper STT model', () => {
    const config = {
      get: (key: string) => {
        if (key === 'OPENROUTER_API_KEY') return 'sk-test';
        if (key === 'AI_STT_MODEL') return 'openai/whisper-1';
        return undefined;
      },
    } as unknown as ConfigService;

    const client = new OpenRouterClient(config);
    expect(client.getModelId('audio')).toBe('openai/whisper-1');
  });
});
