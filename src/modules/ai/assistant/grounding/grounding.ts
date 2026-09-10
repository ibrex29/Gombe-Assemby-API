/**
 * Grounding check — the enforced half of "never state a figure you did not query".
 *
 * The system prompt asks the model not to invent numbers, but a prompt is a
 * request, not a guarantee. This module is the code-level backstop: every
 * number-looking figure in the final answer must appear somewhere in the JSON
 * of a tool result that actually succeeded during this turn.
 *
 * Pure and dependency-free so the rule can be tested without a model.
 */

/** One recorded tool result from the agent loop. */
export interface ToolOutcome {
  tool: string;
  ok: boolean;
  /** Raw result payload for successes; error text for failures. */
  output: unknown;
}

/**
 * Comma-grouped numbers (12,345) or bare runs of 3+ digits. One- and two-digit
 * numbers are ignored: they show up constantly in ordinary prose ("the top 5
 * LGAs", "3 wards") and treating them as claims makes the check useless.
 */
const NUMBER_PATTERN = /\d{1,3}(?:,\d{3})+|\d{3,}/g;

export function extractAnswerNumbers(text: string): string[] {
  const matches = text.match(NUMBER_PATTERN) ?? [];
  const normalized = matches.map((value) => value.replace(/,/g, ''));
  return [...new Set(normalized)];
}

/**
 * Flattens every successful tool result into one searchable string. Failed
 * calls are excluded on purpose — a number that only ever appeared in an error
 * message was never real data.
 */
export function buildToolResultHaystack(outcomes: ToolOutcome[]): string {
  return outcomes
    .filter((outcome) => outcome.ok)
    .map((outcome) => {
      try {
        return JSON.stringify(outcome.output);
      } catch {
        return String(outcome.output);
      }
    })
    .join(' ')
    .replace(/,/g, '');
}

export interface GroundingResult {
  grounded: boolean;
  /** Figures in the answer that could not be traced to a tool result. */
  missing: string[];
}

export function isGrounded(
  answer: string,
  outcomes: ToolOutcome[],
): GroundingResult {
  const numbers = extractAnswerNumbers(answer);
  if (numbers.length === 0) {
    // A purely qualitative answer has nothing to fabricate.
    return { grounded: true, missing: [] };
  }

  const haystack = buildToolResultHaystack(outcomes);
  const missing = numbers.filter((value) => !haystack.includes(value));
  return { grounded: missing.length === 0, missing };
}
