import { EvidencePhoto, toEvidenceDigest } from './evidence.service';
import {
  SPOKEN_MARKER,
  deriveSpoken,
  splitSpoken,
  stripReasoning,
} from '../prompts/system-prompt';

const photo = (ref: number): EvidencePhoto => ({
  ref,
  kind: 'ec8a',
  url: `/uploads/sheet-${ref}.jpg`,
  caption: `EC8A — unit ${ref}`,
  takenAt: '2026-08-21T09:00:00.000Z',
});

describe('toEvidenceDigest', () => {
  it('withholds URLs from the model', () => {
    // The model cites photos by ref; it never sees a link, so it cannot invent
    // one that looks plausible enough to render.
    const digest = toEvidenceDigest([photo(1), photo(2)]);

    expect(digest).toEqual([
      {
        ref: 1,
        kind: 'ec8a',
        caption: 'EC8A — unit 1',
        takenAt: '2026-08-21T09:00:00.000Z',
      },
      {
        ref: 2,
        kind: 'ec8a',
        caption: 'EC8A — unit 2',
        takenAt: '2026-08-21T09:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(digest)).not.toContain('/uploads/');
  });
});

describe('splitSpoken', () => {
  it('separates the written answer from the spoken summary', () => {
    const { reply, spoken } = splitSpoken(
      `APC leads in 23 states.\n\n${SPOKEN_MARKER}\nWe are ahead in 23 states.`,
    );
    expect(reply).toBe('APC leads in 23 states.');
    expect(spoken).toBe('We are ahead in 23 states.');
  });

  it('treats the whole text as the reply when the marker is missing', () => {
    const { reply, spoken } = splitSpoken('Nothing to report.');
    expect(reply).toBe('Nothing to report.');
    expect(spoken).toBeNull();
  });

  it('strips markdown so speech does not read punctuation aloud', () => {
    const { spoken } = splitSpoken(
      `x\n${SPOKEN_MARKER}\n**About 173,000** votes | so far`,
    );
    expect(spoken).toBe('About 173,000 votes  so far');
  });

  it('returns null rather than an empty string when nothing follows the marker', () => {
    const { reply, spoken } = splitSpoken(`Answer.\n${SPOKEN_MARKER}\n   `);
    expect(reply).toBe('Answer.');
    expect(spoken).toBeNull();
  });

  it('never leaves the marker visible in the reply', () => {
    const { reply } = splitSpoken(`Answer.\n${SPOKEN_MARKER}\nSpoken.`);
    expect(reply).not.toContain(SPOKEN_MARKER);
  });
});

describe('stripReasoning', () => {
  it('removes a complete reasoning block', () => {
    expect(stripReasoning('<mm:think>scratch</mm:think>The answer.')).toBe(
      'The answer.',
    );
  });

  it('removes an orphaned closing tag', () => {
    // The real failure: a truncated block leaves a bare closing tag, which
    // rendered to the user as literal `</mm:think>` at the head of the answer.
    expect(stripReasoning('</mm:think>The answer.')).toBe('The answer.');
  });

  it('handles unprefixed think tags too', () => {
    expect(stripReasoning('<think>scratch</think>The answer.')).toBe(
      'The answer.',
    );
  });

  it('leaves ordinary prose alone', () => {
    const prose = 'Rethinking the margin, turnout is 51%.';
    expect(stripReasoning(prose)).toBe(prose);
  });

  it('strips reasoning before the spoken split, so neither half carries a tag', () => {
    const { reply, spoken } = splitSpoken(
      `<mm:think>scratch</mm:think>Written answer.
${SPOKEN_MARKER}
Spoken answer.`,
    );
    expect(reply).toBe('Written answer.');
    expect(spoken).toBe('Spoken answer.');
  });
});

describe('deriveSpoken', () => {
  const answer = [
    '## National coverage',
    '',
    'APC leads with 33.1% of valid votes reported so far. Reporting stands at 2.3% of polling units.',
    '',
    '| State | Share |',
    '|---|---|',
    '| Kano | 40.2 |',
    '',
    '- Jigawa is the only state above 30% reporting',
  ].join('\n');

  it('speaks the prose and never the table or headings', () => {
    const spoken = deriveSpoken(answer) ?? '';
    expect(spoken).toContain('APC leads with 33.1%');
    expect(spoken).not.toContain('|');
    expect(spoken).not.toContain('##');
  });

  it('reuses figures verbatim, so a derived summary stays grounded', () => {
    // It only ever copies from an answer that already passed grounding, so no
    // number can appear here that was not checked against a tool result.
    const spoken = deriveSpoken(answer) ?? '';
    for (const figure of spoken.match(/\d[\d.,]*/g) ?? []) {
      expect(answer).toContain(figure);
    }
  });

  it('returns null rather than speaking a stub', () => {
    expect(deriveSpoken('OK.')).toBeNull();
    expect(deriveSpoken('')).toBeNull();
  });

  it('fills in when the model omits the marker', () => {
    const { reply, spoken } = splitSpoken(answer);
    expect(reply).toBe(answer);
    expect(spoken).toBeTruthy();
  });

  it('still prefers a summary the model supplied itself', () => {
    const { spoken } = splitSpoken(
      `Written answer here.\n${SPOKEN_MARKER}\nModel spoken line.`,
    );
    expect(spoken).toBe('Model spoken line.');
  });
});
