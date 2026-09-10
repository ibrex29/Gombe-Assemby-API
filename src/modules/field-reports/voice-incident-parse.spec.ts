import { IncidentSeverity, IncidentType } from '@electromon/shared';
import { parseVoiceIncidentJson } from './voice-incident-parse';

describe('parseVoiceIncidentJson', () => {
  it('parses a valid voice incident payload', () => {
    const result = parseVoiceIncidentJson(
      JSON.stringify({
        language: 'ha',
        originalTranscript: 'An sace akwatin kuri\'a',
        englishSummary: 'Ballot box was snatched at the polling unit.',
        incidentType: 'BALLOT_SNATCHING',
        incidentSeverity: 'CRITICAL',
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.language).toBe('ha');
    expect(result.incidentType).toBe(IncidentType.BALLOT_SNATCHING);
    expect(result.incidentSeverity).toBe(IncidentSeverity.CRITICAL);
    expect(result.englishSummary).toContain('Ballot box');
  });

  it('falls back to OTHERS for unknown incident types', () => {
    const result = parseVoiceIncidentJson(
      JSON.stringify({
        originalTranscript: 'Something odd happened',
        englishSummary: 'Something odd happened',
        incidentType: 'ALIEN_INVASION',
        incidentSeverity: 'LOW',
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.incidentType).toBe(IncidentType.OTHERS);
  });

  it('fails on malformed JSON', () => {
    const result = parseVoiceIncidentJson('not-json');
    expect(result.ok).toBe(false);
  });

  it('unwraps fenced JSON', () => {
    const result = parseVoiceIncidentJson(
      '```json\n{"originalTranscript":"test","englishSummary":"test","incidentType":"OTHERS","incidentSeverity":"MEDIUM"}\n```',
    );
    expect(result.ok).toBe(true);
  });
});
