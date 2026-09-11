import { IncidentSeverity, IncidentType } from '@electromon/shared';
import { OpenRouterClient } from '../ai/core/llm/openrouter.client';
import {
  parseVoiceIncidentJson,
  type VoiceIncidentParseResult,
} from './voice-incident-parse';

/**
 * Shared classifier for voice transcripts, WhatsApp text, and photo captions.
 * Voice still runs STT first; this only turns narrative into type/severity/summary.
 */
export async function classifyIncidentNarrative(
  llm: OpenRouterClient,
  text: string,
): Promise<VoiceIncidentParseResult> {
  const incidentTypes = Object.values(IncidentType).join(', ');
  const severities = Object.values(IncidentSeverity).join(', ');

  const system = `You normalize Nigerian election-day incident reports for polling unit agents.

The text may be in English, Hausa, Igbo, Yoruba, or Nigerian Pidgin. It may be a voice transcript, a WhatsApp message, or a photo caption.

Return JSON only in this exact shape:
{
  "language": "ha|ig|yo|pcm|en|other",
  "originalTranscript": "the text as written or spoken, lightly cleaned",
  "englishSummary": "One or two clear English sentences for senior officers who will not listen to audio or read the original.",
  "incidentType": "<one of: ${incidentTypes}>",
  "incidentSeverity": "<one of: ${severities}>"
}

Classify incidentType from what happened (violence, ballot snatching, vote buying, intimidation, BVAS issues, etc.).
Use CRITICAL or HIGH only for immediate physical danger or ballot box snatching in progress.
Never invent details not present in the text.`;

  const completion = await llm.complete('assistant', {
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `Classify this incident report:\n\n${text}`,
      },
    ],
    temperature: 0,
    maxTokens: 800,
    jsonResponse: true,
  });

  if (!completion.content?.trim()) {
    return { ok: false as const, error: 'AI returned an empty incident classification' };
  }

  return parseVoiceIncidentJson(completion.content);
}
