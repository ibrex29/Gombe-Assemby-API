/**
 * Wire types for the OpenRouter chat-completions API (OpenAI-compatible shape).
 *
 * Deliberately hand-rolled rather than pulled from the Vercel AI SDK: that
 * package and its OpenRouter provider are ESM-only, and this service is
 * compiled to CommonJS and runs on node:20-alpine, where require() of an ESM
 * module is not reliably available. See docs/AI-ASSISTANT.md.
 */

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON text, not an object — parse defensively, models emit malformed JSON. */
    arguments: string;
  };
}

/** OpenAI-compatible multimodal parts (OpenRouter vision models). */
export type LlmTextPart = { type: 'text'; text: string };
export type LlmImagePart = {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
};
export type LlmAudioPart = {
  type: 'input_audio';
  input_audio: { data: string; format: string };
};
export type LlmContentPart = LlmTextPart | LlmImagePart | LlmAudioPart;

export interface LlmMessage {
  role: LlmRole;
  /** Plain text, or multimodal parts for vision/OCR tasks. */
  content: string | LlmContentPart[] | null;
  tool_calls?: LlmToolCall[];
  /** Set on role:'tool' messages to bind the result to its call. */
  tool_call_id?: string;
  name?: string;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

/** 'required' forces a tool call on this turn — used by the grounding retry. */
export type LlmToolChoice = 'auto' | 'none' | 'required';

export interface LlmCompletionRequest {
  messages: LlmMessage[];
  model?: string;
  tools?: LlmToolDefinition[];
  toolChoice?: LlmToolChoice;
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for a JSON object back (sentiment classification / OCR). */
  jsonResponse?: boolean;
  /** Override the default provider timeout (ms). OCR needs more headroom. */
  timeoutMs?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface LlmCompletion {
  content: string | null;
  toolCalls: LlmToolCall[];
  finishReason: string | null;
  usage: LlmUsage;
  model: string;
}

/** Provider-side failure, already stripped of anything not safe to surface. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Sanitized provider detail safe to show operators (e.g. key limit). */
    readonly providerDetail?: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
