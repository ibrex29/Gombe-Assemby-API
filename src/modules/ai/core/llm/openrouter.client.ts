import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LlmCompletion,
  LlmCompletionRequest,
  LlmError,
  LlmToolCall,
} from './llm.types';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_STT_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';
/**
 * Per model call, not per request.
 *
 * 60s was too tight: a briefing that legitimately chains three or four tools
 * measured 60-72s end to end, so questions like "what is the biggest threat"
 * aborted mid-answer and fell back to an apology. The assistant loop caps tool
 * steps, so the worst case is bounded rather than open-ended.
 */
const REQUEST_TIMEOUT_MS = 120_000;
const OCR_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Parity with the reference implementation this port is based on. Operators are
 * expected to set AI_MODEL explicitly — see infra/env/*.env.example. Kept as a
 * named constant so the fallback is greppable rather than buried in a string.
 */
const DEFAULT_MODEL = 'minimax/minimax-m3';

/** EC8A photo reads — same MiniMax vision stack as assistant when AI_OCR_MODEL is unset. */
const DEFAULT_OCR_MODEL = 'minimax/minimax-m3';

/** Whisper-class STT default when AI_STT_MODEL is unset. */
const DEFAULT_STT_MODEL = 'openai/whisper-large-v3';

/** Which env var supplies the model id for each caller. */
export type LlmTask = 'assistant' | 'social' | 'ocr' | 'audio';

const TASK_MODEL_ENV: Record<LlmTask, string> = {
  assistant: 'AI_MODEL',
  social: 'AI_SOCIAL_MODEL',
  ocr: 'AI_OCR_MODEL',
  audio: 'AI_STT_MODEL',
};

/**
 * Single LLM entry point for every AI submodule.
 *
 * Follows the graceful-degradation shape of GoogleVisionService: when the key
 * is missing the service constructs fine and reports isConfigured() === false,
 * so callers decide between a 503 and silently skipping work.
 */
@Injectable()
export class OpenRouterClient {
  private readonly logger = new Logger(OpenRouterClient.name);
  private readonly apiKey: string | null;
  private warnedUnconfigured = false;

  constructor(private config: ConfigService) {
    this.apiKey = this.config.get<string>('OPENROUTER_API_KEY')?.trim() || null;
    if (!this.apiKey) {
      this.logger.warn(
        'OPENROUTER_API_KEY is not set; AI features are disabled',
      );
    }
  }

  isConfigured() {
    return this.apiKey != null;
  }

  /**
   * Model id for a task.
   * - `assistant` falls back to DEFAULT_MODEL
   * - `ocr` uses AI_OCR_MODEL → AI_MODEL → DEFAULT_OCR_MODEL (vision-capable)
   * - `social` does not fall back — unset AI_SOCIAL_MODEL means skip sentiment
   * - `audio` uses AI_STT_MODEL only when it looks like an STT model
   */
  getModelId(task: LlmTask): string | null {
    if (task === 'audio') {
      const configured = this.config.get<string>(TASK_MODEL_ENV.audio)?.trim();
      const assistant = this.config.get<string>('AI_MODEL')?.trim();
      if (configured && isSttModel(configured) && configured !== assistant) {
        return configured;
      }
      if (configured && !isSttModel(configured)) {
        this.logger.warn(
          `AI_STT_MODEL=${configured} is not a transcription model; using ${DEFAULT_STT_MODEL}`,
        );
      }
      return DEFAULT_STT_MODEL;
    }

    const configured = this.config.get<string>(TASK_MODEL_ENV[task])?.trim();
    if (configured) return configured;
    if (task === 'assistant') {
      if (!this.warnedUnconfigured) {
        this.logger.warn(
          `AI_MODEL is not set; falling back to ${DEFAULT_MODEL}. Set AI_MODEL explicitly.`,
        );
        this.warnedUnconfigured = true;
      }
      return DEFAULT_MODEL;
    }
    if (task === 'ocr') {
      const assistantModel = this.config.get<string>('AI_MODEL')?.trim();
      return assistantModel || DEFAULT_OCR_MODEL;
    }
    return null;
  }

  async complete(
    task: LlmTask,
    request: LlmCompletionRequest,
  ): Promise<LlmCompletion> {
    if (!this.apiKey) {
      throw new LlmError('AI provider is not configured');
    }

    const model = request.model ?? this.getModelId(task);
    if (!model) {
      throw new LlmError(`No model configured for ${task}`);
    }

    const body: Record<string, unknown> = {
      model,
      messages: request.messages,
    };
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      body.tool_choice = request.toolChoice ?? 'auto';
    }
    if (request.temperature !== undefined)
      body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.jsonResponse) body.response_format = { type: 'json_object' };

    const timeoutMs =
      request.timeoutMs ??
      (task === 'ocr' || task === 'audio'
        ? OCR_REQUEST_TIMEOUT_MS
        : REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          // OpenRouter attribution headers; harmless if the dashboard ignores them.
          'HTTP-Referer':
            this.config.get<string>('API_PUBLIC_URL') ??
            'https://electromon.ng',
          'X-Title': 'Electromon',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown';
      this.logger.warn({ err: error }, 'AI provider request failed');
      throw new LlmError(
        reason === 'TimeoutError'
          ? 'AI provider timed out'
          : 'AI provider is unreachable',
      );
    }

    if (!response.ok) {
      // Provider errors can echo the request back; log fully, surface a summary.
      const detail = await response.text().catch(() => '');
      this.logger.warn(
        { status: response.status, detail: detail.slice(0, 500) },
        'AI provider returned an error',
      );
      let providerDetail: string | undefined;
      try {
        const parsed = JSON.parse(detail) as {
          error?: { message?: string };
        };
        providerDetail = parsed.error?.message?.trim() || undefined;
      } catch {
        providerDetail = undefined;
      }
      throw new LlmError(
        providerDetail ?? `AI provider error (${response.status})`,
        response.status,
        providerDetail,
      );
    }

    const payload = (await response.json()) as OpenRouterResponse;
    return this.toCompletion(payload, model);
  }

  /**
   * Speech-to-text via OpenRouter's dedicated transcription endpoint.
   * Chat completions with input_audio is not supported on most routed models.
   */
  async transcribeAudio(input: {
    base64: string;
    format: string;
    language?: string;
  }): Promise<{ text: string; language?: string }> {
    if (!this.apiKey) {
      throw new LlmError('AI provider is not configured');
    }

    const model = this.getModelId('audio');
    if (!model) {
      throw new LlmError('No STT model configured for audio');
    }

    const body: Record<string, unknown> = {
      model,
      input_audio: {
        data: input.base64,
        format: input.format,
      },
    };
    if (input.language) body.language = input.language;

    let response: Response;
    try {
      response = await fetch(OPENROUTER_STT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer':
            this.config.get<string>('API_PUBLIC_URL') ??
            'https://electromon.ng',
          'X-Title': 'Electromon',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(OCR_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown';
      this.logger.warn({ err: error }, 'STT provider request failed');
      throw new LlmError(
        reason === 'TimeoutError'
          ? 'STT provider timed out'
          : 'STT provider is unreachable',
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.warn(
        { status: response.status, detail: detail.slice(0, 500) },
        'STT provider returned an error',
      );
      throw new LlmError(
        `STT provider error (${response.status})`,
        response.status,
      );
    }

    const payload = (await response.json()) as SttResponse;
    const text = payload.text?.trim() ?? '';
    if (!text) {
      throw new LlmError('STT provider returned empty transcription');
    }
    return { text, language: payload.language };
  }

  private toCompletion(
    payload: OpenRouterResponse,
    requestedModel: string,
  ): LlmCompletion {
    const choice = payload?.choices?.[0];
    if (!choice) {
      throw new LlmError('AI provider returned no choices');
    }

    const rawCalls = choice.message?.tool_calls ?? [];
    const toolCalls: LlmToolCall[] = rawCalls
      .filter((call) => call?.function?.name)
      .map((call, index) => ({
        // Some providers omit ids; the loop needs one to pair results back.
        id: call.id ?? `call_${index}`,
        type: 'function',
        function: {
          name: call.function.name,
          arguments: call.function.arguments ?? '{}',
        },
      }));

    return {
      content: choice.message?.content ?? null,
      toolCalls,
      finishReason: choice.finish_reason ?? null,
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
        totalTokens: payload.usage?.total_tokens ?? 0,
      },
      model: payload.model ?? requestedModel,
    };
  }
}

interface OpenRouterResponse {
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function: { name: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface SttResponse {
  text?: string;
  language?: string;
}

function isSttModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return (
    id.includes('whisper') ||
    id.includes('transcribe') ||
    id.includes('chirp') ||
    id.includes('speech-to-text')
  );
}
