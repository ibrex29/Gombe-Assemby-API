import {
  extractLeakedToolCalls,
  isScaffoldingOnly,
  looksLikeLeakedToolContent,
  normalizeBracketTags,
  normalizeSpecialTokens,
  sanitizeAssistantText,
  stripLeakedToolMarkup,
} from './sanitize-model-output';

describe('sanitize model output', () => {
  const leaked = [
    '[<]minimax[>][<tool_call>]',
    '[<]minimax[>][<invoke name="run_sql">]',
    '[<]minimax[>][<sql>]SELECT count(*) AS total FROM field_reports;[<]/sql[>]',
    '[<]/invoke[>]',
    '[<]/tool_call[>]',
  ].join('');

  /** Exact garbled pattern from production chat screenshots. */
  const garbledSpecialTokens = ']<|minimax|>[ ]<|minimax|>[ ]<|minimax|>[';

  it('detects leaked tool markup', () => {
    expect(looksLikeLeakedToolContent(leaked)).toBe(true);
    expect(looksLikeLeakedToolContent('Turnout is 51%.')).toBe(false);
  });

  it('detects minimax special-token scaffolding', () => {
    expect(looksLikeLeakedToolContent(garbledSpecialTokens)).toBe(true);
    expect(looksLikeLeakedToolContent('<|tool_call|>')).toBe(true);
    expect(looksLikeLeakedToolContent('<|invoke|>')).toBe(true);
    expect(looksLikeLeakedToolContent(']<|minimax|>[')).toBe(true);
  });

  it('strips leaked tool markup from display text', () => {
    expect(sanitizeAssistantText(`${leaked}\n\nThere are 12 open reports.`)).toBe(
      'There are 12 open reports.',
    );
    expect(stripLeakedToolMarkup(leaked)).toBe('');
  });

  it('strips minimax special-token scaffolding from display text', () => {
    expect(sanitizeAssistantText(garbledSpecialTokens)).toBe('');
    expect(stripLeakedToolMarkup(garbledSpecialTokens)).toBe('');
    expect(isScaffoldingOnly(garbledSpecialTokens)).toBe(true);
  });

  it('preserves real answers after special-token stripping', () => {
    expect(
      sanitizeAssistantText(`${garbledSpecialTokens}\n\nTurnout is 51%.`),
    ).toBe('Turnout is 51%.');
  });

  it('normalizes bracket-escaped tags', () => {
    expect(normalizeBracketTags('[<]invoke name="run_sql"[>]')).toBe(
      '<invoke name="run_sql">',
    );
  });

  it('normalizes pipe-delimited special tokens to angle tags', () => {
    expect(normalizeSpecialTokens('<|minimax|><|invoke name="run_sql"|>')).toBe(
      '<minimax><invoke name="run_sql">',
    );
    expect(normalizeSpecialTokens('<|/invoke|>')).toBe('</invoke>');
  });

  it('extracts run_sql from minimax-style invoke blocks', () => {
    const calls = extractLeakedToolCalls(leaked);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('run_sql');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({
      sql: 'SELECT count(*) AS total FROM field_reports;',
    });
  });

  it('maps hyphenated tool names to underscores', () => {
    const calls = extractLeakedToolCalls(
      '<invoke name="run-sql"><sql>SELECT 1</sql></invoke>',
    );
    expect(calls[0].function.name).toBe('run_sql');
  });
});
