import { parseAiEc8aJson } from './ec8a-ai-parse';

describe('parseAiEc8aJson', () => {
  it('parses fenced JSON and party votes', () => {
    const raw = `\`\`\`json
{
  "fields": {
    "registeredVoters": "1,234",
    "accreditedVoters": 900,
    "ballotPapersIssued": 950,
    "unusedBallotPapers": 40,
    "spoiledBallotPapers": 5,
    "invalidVotes": 10,
    "votesCast": 845,
    "usedBallotPapers": 860
  },
  "partyResults": { "apc": 500, "PDP": 345, "ZZZ": 1 },
  "confidence": 0.88,
  "unreadable": false
}
\`\`\``;

    const result = parseAiEc8aJson(raw, ['APC', 'PDP', 'LP']);
    expect(result.unreadable).toBe(false);
    expect(result.fields.registeredVoters).toBe(1234);
    expect(result.fields.accreditedVoters).toBe(900);
    expect(result.partyResults).toEqual({ APC: 500, PDP: 345 });
    expect(result.confidence).toBe(0.88);
  });

  it('marks empty extracts unreadable', () => {
    const result = parseAiEc8aJson(
      JSON.stringify({ fields: {}, partyResults: {}, confidence: 0.1, unreadable: false }),
      ['APC'],
    );
    expect(result.unreadable).toBe(true);
    expect(result.error).toMatch(/could not read clear figures/i);
  });
});
