import type { LlmToolCall } from '../core/llm/llm.types';

/** minimax sometimes escapes `<` as `[<]` in leaked tool markup. */
export function normalizeBracketTags(text: string): string {
  return text
    .replace(/\[\<\]/g, '<')
    .replace(/\[\>\]/g, '>')
    .replace(/<([a-zA-Z_:-]+)\]/g, '<$1>')
    .replace(/\[<\//g, '</');
}

/** OpenRouter/minimax pipe-delimited special tokens, e.g. `<|minimax|>`. */
export function normalizeSpecialTokens(text: string): string {
  return text.replace(/<\|([^|]+)\|>/g, (_, token: string) => `<${token.trim()}>`);
}

const LEAKED_TOOL_MARKERS =
  /(?:<\/?(?:minimax|tool_call|invoke|parameter|sql)\b|\[\<\](?:minimax|tool_call|invoke|sql))/i;

const SPECIAL_TOKEN_MARKERS =
  /<\|(?:\/?(?:minimax|tool_call|invoke|parameter|sql)|[^|]+)\|>/i;

const BRACKETED_SPECIAL_TOKEN = /\]\s*<\|[^|]+\|>\s*\[/;

export function looksLikeLeakedToolContent(text: string): boolean {
  return (
    LEAKED_TOOL_MARKERS.test(text) ||
    SPECIAL_TOKEN_MARKERS.test(text) ||
    BRACKETED_SPECIAL_TOKEN.test(text)
  );
}

/** True when text is empty or only brackets, pipes, and whitespace after stripping. */
export function isScaffoldingOnly(text: string): boolean {
  const stripped = stripLeakedToolMarkup(text);
  return stripped.length === 0 || /^[\s\[\]|]+$/.test(stripped);
}

/** Remove leaked tool-call markup so it never renders in the chat UI. */
export function stripLeakedToolMarkup(text: string): string {
  let out = normalizeSpecialTokens(normalizeBracketTags(text))
    .replace(/<\/?minimax>/gi, '')
    .replace(/<\/?tool_call>/gi, '')
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, '')
    .replace(/<\/?invoke\b[^>]*>/gi, '')
    .replace(/<\/?parameter\b[^>]*>[\s\S]*?<\/parameter>/gi, '')
    .replace(/<\/?sql\b[^>]*>[\s\S]*?<\/sql>/gi, '')
    .replace(/<\/?sql\b[^>]*>/gi, '');

  // Pipe-delimited special tokens left before or after normalization.
  out = out.replace(/<\|[^|]+\|>/g, '');
  out = out.replace(/\]\s*<\|[^|]+\|>\s*\[/g, '');

  // Orphan minimax/bracket tokens left after partial strips.
  out = out.replace(/\[\<\]minimax\[\>\]/gi, '');
  out = out.replace(/\[\s*\]/g, '');
  out = out.replace(/^\s*[\[\]|]+\s*$/gm, '');

  out = out.replace(/\n{3,}/g, '\n\n').trim();
  if (/^[\s\[\]|]+$/.test(out)) {
    return '';
  }
  return out;
}

function normalizeToolName(name: string): string {
  return name.trim().replace(/-/g, '_');
}

function parseInvokeBody(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  const paramRe = /<parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/gi;
  for (const match of body.matchAll(paramRe)) {
    args[match[1]] = match[2].trim();
  }

  const sqlMatch = body.match(/<sql\b[^>]*>\]?([\s\S]*?)<\/sql>/i);
  if (sqlMatch && args.sql === undefined) {
    args.sql = sqlMatch[1].trim();
  }

  return args;
}

/**
 * Recover structured tool calls when a provider puts them in `content` instead
 * of the OpenAI `tool_calls` field (common with minimax via OpenRouter).
 */
export function extractLeakedToolCalls(raw: string): LlmToolCall[] {
  const normalized = normalizeSpecialTokens(normalizeBracketTags(raw)).replace(
    /<\/?minimax>/gi,
    '',
  );
  const calls: LlmToolCall[] = [];
  let index = 0;

  const invokeRe = /<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/gi;
  for (const match of normalized.matchAll(invokeRe)) {
    const name = normalizeToolName(match[1]);
    const args = parseInvokeBody(match[2]);
    calls.push({
      id: `leaked_${index}`,
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    });
    index += 1;
  }

  return calls;
}

export function sanitizeAssistantText(raw: string): string {
  return stripLeakedToolMarkup(raw).trim();
}
