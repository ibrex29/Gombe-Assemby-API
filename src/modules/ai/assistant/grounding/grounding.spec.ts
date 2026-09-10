import {
  ToolOutcome,
  buildToolResultHaystack,
  extractAnswerNumbers,
  isGrounded,
} from './grounding';

const ok = (output: unknown): ToolOutcome => ({
  tool: 'run_sql',
  ok: true,
  output,
});
const failed = (output: unknown): ToolOutcome => ({
  tool: 'run_sql',
  ok: false,
  output,
});

describe('extractAnswerNumbers', () => {
  it('picks up comma-grouped and bare long numbers', () => {
    expect(
      extractAnswerNumbers('APC polled 12,345 votes against 9876'),
    ).toEqual(['12345', '9876']);
  });

  it('ignores one and two digit numbers as ordinary prose', () => {
    expect(extractAnswerNumbers('the top 5 LGAs, 12 wards, 99 units')).toEqual(
      [],
    );
  });

  it('deduplicates repeated figures', () => {
    expect(extractAnswerNumbers('1,234 then 1234 again')).toEqual(['1234']);
  });

  it('does not treat a percentage decimal as a claim', () => {
    expect(extractAnswerNumbers('turnout was 45.3%')).toEqual([]);
  });
});

describe('buildToolResultHaystack', () => {
  it('excludes failed tool calls', () => {
    const haystack = buildToolResultHaystack([
      ok({ rows: [{ votes: 4321 }] }),
      failed({ error: 'relation "users" does not exist: 9999' }),
    ]);
    expect(haystack).toContain('4321');
    expect(haystack).not.toContain('9999');
  });
});

describe('isGrounded', () => {
  it('passes when every figure came from a successful tool result', () => {
    const verdict = isGrounded('APC leads with 12,345 votes.', [
      ok({ rows: [{ v: 12345 }] }),
    ]);
    expect(verdict).toEqual({ grounded: true, missing: [] });
  });

  it('passes a purely qualitative answer with no tool calls', () => {
    expect(
      isGrounded('I could not find any unresolved incidents.', []).grounded,
    ).toBe(true);
  });

  it('fails when a figure appears nowhere in the results', () => {
    const verdict = isGrounded('Turnout will reach 45,000 voters.', [
      ok({ rows: [{ v: 120 }] }),
    ]);
    expect(verdict.grounded).toBe(false);
    expect(verdict.missing).toContain('45000');
  });

  it('fails when the only source for a figure was a failed call', () => {
    // The number existed, but the query that produced it errored — that is
    // exactly the case the check exists to catch.
    const verdict = isGrounded('There were 8,412 accredited voters.', [
      failed({ error: 'timeout after 8412 ms' }),
    ]);
    expect(verdict.grounded).toBe(false);
  });

  it('matches regardless of comma formatting in either direction', () => {
    expect(
      isGrounded('Total 1,000,000 votes.', [ok({ total: 1000000 })]).grounded,
    ).toBe(true);
  });
});
