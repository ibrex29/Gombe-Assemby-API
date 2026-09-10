import { EventEmitter2 } from '@nestjs/event-emitter';
import { IncidentSeverity, IncidentType } from '@electromon/shared';
import { OpenRouterClient } from '../ai/core/llm/openrouter.client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { VoiceIncidentWorker } from './voice-incident.worker';

describe('VoiceIncidentWorker', () => {
  it('updates the field report after a successful AI read', async () => {
    const prisma = {
      fieldReport: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'report-1',
          audioUrl: 'https://cdn.example.com/voice.m4a',
          campaignId: 'camp-1',
          wardId: 'ward-1',
          pollingUnitId: 'pu-1',
        }),
        update: jest.fn().mockResolvedValue({
          campaignId: 'camp-1',
          wardId: 'ward-1',
          pollingUnitId: 'pu-1',
          isUrgent: true,
          incidentSeverity: IncidentSeverity.CRITICAL,
        }),
      },
      ward: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ward-1',
          lgaId: 'lga-1',
          lga: { stateId: 'state-1' },
        }),
      },
    } as unknown as PrismaService;

    const llm = {
      isConfigured: () => true,
      getModelId: (task: string) =>
        task === 'audio' ? 'openai/whisper-large-v3' : 'minimax/minimax-m3',
      transcribeAudio: jest.fn().mockResolvedValue({
        text: 'Anụpụla bọks',
        language: 'ig',
      }),
      complete: jest.fn().mockResolvedValue({
        content: JSON.stringify({
          language: 'ig',
          originalTranscript: 'Anụpụla bọks',
          englishSummary: 'Ballot box snatched at the unit.',
          incidentType: IncidentType.BALLOT_SNATCHING,
          incidentSeverity: IncidentSeverity.CRITICAL,
        }),
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        model: 'google/gemini-2.5-flash',
      }),
    } as unknown as OpenRouterClient;

    const events = { emit: jest.fn() } as unknown as EventEmitter2;
    const worker = new VoiceIncidentWorker(prisma, llm, events);

    jest.spyOn(worker as any, 'readAudio').mockResolvedValue({
      mime: 'audio/mp4',
      base64: 'ZmFrZQ==',
      format: 'mp3',
    });

    await worker.handle({ reportId: 'report-1' });

    expect(llm.transcribeAudio).toHaveBeenCalled();
    expect(llm.complete).toHaveBeenCalledWith(
      'assistant',
      expect.objectContaining({
        jsonResponse: true,
      }),
    );
    expect(prisma.fieldReport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'report-1' },
        data: expect.objectContaining({
          description: 'Ballot box snatched at the unit.',
          incidentType: IncidentType.BALLOT_SNATCHING,
          incidentSeverity: IncidentSeverity.CRITICAL,
        }),
      }),
    );
    expect(events.emit).toHaveBeenCalled();
  });

  it('readAudio downloads HTTPS Cloudinary voice URLs', async () => {
    const prisma = {} as unknown as PrismaService;
    const llm = { isConfigured: () => true } as unknown as OpenRouterClient;
    const events = { emit: jest.fn() } as unknown as EventEmitter2;
    const worker = new VoiceIncidentWorker(prisma, llm, events);

    const cloudinaryUrl =
      'https://res.cloudinary.com/prnykq8x/video/upload/v1/electromon/uploads/voice/clip-id.m4a';
    const audioBytes = Buffer.alloc(12);
    audioBytes.writeUInt32BE(8, 0);
    audioBytes.write('ftyp', 4);
    audioBytes.write('M4A ', 8);

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () =>
        audioBytes.buffer.slice(
          audioBytes.byteOffset,
          audioBytes.byteOffset + audioBytes.byteLength,
        ),
    });
    global.fetch = fetchMock as typeof fetch;

    const result = await (worker as any).readAudio(cloudinaryUrl);

    expect(fetchMock).toHaveBeenCalledWith(
      cloudinaryUrl,
      expect.objectContaining({ headers: { Accept: 'audio/*,*/*' } }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        mime: 'audio/mp4',
        format: 'm4a',
      }),
    );
    expect(result.base64).toBeTruthy();
  });
});
