import {
  CampaignRole,
  FieldReportSource,
  FieldReportType,
  IncidentSeverity,
  IncidentType,
  ScopeType,
  WhatsAppInboundStatus,
} from '@electromon/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FieldReportsService } from '../field-reports/field-reports.service';
import { OpenRouterClient } from '../ai/core/llm/openrouter.client';
import { UploadsService } from '../uploads/uploads.service';
import { WhatsAppClient } from './whatsapp.client';
import { WhatsAppInboundWorker } from './whatsapp-inbound.worker';

function inbound(overrides: Record<string, unknown> = {}) {
  return {
    id: 'in-1',
    wamid: 'wamid.1',
    fromPhone: '2348031234567',
    status: WhatsAppInboundStatus.RECEIVED,
    payload: {
      wamid: 'wamid.1',
      from: '2348031234567',
      type: 'text',
      text: 'Thugs blocking the gate',
    },
    ...overrides,
  };
}

describe('WhatsAppInboundWorker', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WHATSAPP_CAMPAIGN_ID;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('replies and ignores an unregistered phone', async () => {
    const prisma = {
      whatsAppInboundMessage: {
        findUnique: jest.fn().mockResolvedValue(inbound()),
        update: jest.fn().mockResolvedValue({}),
      },
      user: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const fieldReports = { create: jest.fn() } as unknown as FieldReportsService;
    const client = { sendText: jest.fn().mockResolvedValue(undefined) } as unknown as WhatsAppClient;
    const worker = new WhatsAppInboundWorker(
      prisma,
      fieldReports,
      {} as UploadsService,
      client,
      { isConfigured: () => false } as OpenRouterClient,
    );

    await worker.handle({ inboundId: 'in-1' });

    expect(fieldReports.create).not.toHaveBeenCalled();
    expect(client.sendText).toHaveBeenCalledWith(
      '2348031234567',
      expect.stringContaining('not registered'),
    );
    expect(prisma.whatsAppInboundMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WhatsAppInboundStatus.IGNORED,
          ignoreReason: 'unregistered',
        }),
      }),
    );
  });

  it('creates a WhatsApp incident for a registered PU agent', async () => {
    const prisma = {
      whatsAppInboundMessage: {
        findUnique: jest.fn().mockResolvedValue(inbound()),
        update: jest.fn().mockResolvedValue({}),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'user-1',
          email: 'agent@electromon.ng',
          phoneNumber: '+2348031234567',
          memberships: [
            {
              campaignId: 'camp-1',
              role: CampaignRole.POLLING_AGENT,
              scopeType: ScopeType.POLLING_UNIT,
              scopeId: 'pu-1',
            },
          ],
        }),
      },
      pollingUnit: {
        findUnique: jest.fn().mockResolvedValue({ wardId: 'ward-1' }),
      },
      fieldReport: { update: jest.fn() },
    } as unknown as PrismaService;

    const fieldReports = {
      create: jest.fn().mockResolvedValue({
        id: 'report-1',
        pollingUnit: { code: '17-13-10-001' },
      }),
    } as unknown as FieldReportsService;

    const client = { sendText: jest.fn().mockResolvedValue(undefined) } as unknown as WhatsAppClient;
    const llm = {
      isConfigured: () => true,
      getModelId: () => 'minimax/minimax-m3',
      complete: jest.fn().mockResolvedValue({
        content: JSON.stringify({
          language: 'en',
          originalTranscript: 'Thugs blocking the gate',
          englishSummary: 'Thugs are blocking the polling unit gate.',
          incidentType: IncidentType.VIOLENCE_THUGGERY,
          incidentSeverity: IncidentSeverity.HIGH,
        }),
      }),
    } as unknown as OpenRouterClient;

    const worker = new WhatsAppInboundWorker(
      prisma,
      fieldReports,
      {} as UploadsService,
      client,
      llm,
    );

    await worker.handle({ inboundId: 'in-1' });

    expect(fieldReports.create).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-1', campaignId: 'camp-1' }),
      expect.objectContaining({
        campaignId: 'camp-1',
        type: FieldReportType.INCIDENT,
        pollingUnitId: 'pu-1',
        wardId: 'ward-1',
        description: 'Thugs blocking the gate',
      }),
      expect.objectContaining({
        source: FieldReportSource.WHATSAPP,
        sourceMessageId: 'wamid.1',
      }),
    );
    expect(client.sendText).toHaveBeenCalledWith(
      '2348031234567',
      expect.stringContaining('PU 17-13-10-001'),
    );
    expect(prisma.whatsAppInboundMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WhatsAppInboundStatus.PROCESSED,
          fieldReportId: 'report-1',
        }),
      }),
    );
  });

  it('does not create a report for help', async () => {
    const prisma = {
      whatsAppInboundMessage: {
        findUnique: jest.fn().mockResolvedValue(
          inbound({
            payload: { wamid: 'wamid.1', from: '2348031234567', type: 'text', text: 'help' },
          }),
        ),
        update: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const fieldReports = { create: jest.fn() } as unknown as FieldReportsService;
    const client = { sendText: jest.fn().mockResolvedValue(undefined) } as unknown as WhatsAppClient;
    const worker = new WhatsAppInboundWorker(
      prisma,
      fieldReports,
      {} as UploadsService,
      client,
      { isConfigured: () => false } as OpenRouterClient,
    );

    await worker.handle({ inboundId: 'in-1' });

    expect(fieldReports.create).not.toHaveBeenCalled();
    expect(client.sendText).toHaveBeenCalledWith(
      '2348031234567',
      expect.stringContaining('text, photo, or voice note'),
    );
  });

  it('uploads a voice note and creates a report with audioUrl', async () => {
    const prisma = {
      whatsAppInboundMessage: {
        findUnique: jest.fn().mockResolvedValue(
          inbound({
            payload: {
              wamid: 'wamid.VOICE',
              from: '2348031234567',
              type: 'audio',
              audio: {
                url: 'https://cdn.termii.com/voice.ogg',
                mimeType: 'audio/ogg; codecs=opus',
              },
            },
          }),
        ),
        update: jest.fn().mockResolvedValue({}),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'user-1',
          email: 'agent@electromon.ng',
          phoneNumber: '+2348031234567',
          memberships: [
            {
              campaignId: 'camp-1',
              role: CampaignRole.POLLING_AGENT,
              scopeType: ScopeType.POLLING_UNIT,
              scopeId: 'pu-1',
            },
          ],
        }),
      },
      pollingUnit: {
        findUnique: jest.fn().mockResolvedValue({ wardId: 'ward-1' }),
      },
    } as unknown as PrismaService;

    const fieldReports = {
      create: jest.fn().mockResolvedValue({
        id: 'report-voice',
        pollingUnit: { code: '17-13-10-001' },
      }),
    } as unknown as FieldReportsService;
    const uploads = {
      saveBuffer: jest.fn().mockResolvedValue({ url: 'https://cdn.example.com/voice.ogg' }),
    } as unknown as UploadsService;
    const client = {
      sendText: jest.fn().mockResolvedValue(undefined),
      downloadMedia: jest.fn().mockResolvedValue({
        buffer: Buffer.from('ogg'),
        mimeType: 'audio/ogg; codecs=opus',
      }),
    } as unknown as WhatsAppClient;

    const worker = new WhatsAppInboundWorker(
      prisma,
      fieldReports,
      uploads,
      client,
      { isConfigured: () => false } as OpenRouterClient,
    );

    await worker.handle({ inboundId: 'in-1' });

    expect(client.downloadMedia).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://cdn.termii.com/voice.ogg' }),
    );
    expect(uploads.saveBuffer).toHaveBeenCalled();
    expect(fieldReports.create).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ audioUrl: 'https://cdn.example.com/voice.ogg' }),
      expect.objectContaining({
        source: FieldReportSource.WHATSAPP,
        sourceMessageId: 'wamid.VOICE',
      }),
    );
  });

  it('ignores a duplicate sourceMessageId instead of creating a second report', async () => {
    const prisma = {
      whatsAppInboundMessage: {
        findUnique: jest.fn().mockResolvedValue(inbound()),
        update: jest.fn().mockResolvedValue({}),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'user-1',
          email: 'agent@electromon.ng',
          phoneNumber: '+2348031234567',
          memberships: [
            {
              campaignId: 'camp-1',
              role: CampaignRole.POLLING_AGENT,
              scopeType: ScopeType.POLLING_UNIT,
              scopeId: 'pu-1',
            },
          ],
        }),
      },
      pollingUnit: {
        findUnique: jest.fn().mockResolvedValue({ wardId: 'ward-1' }),
      },
    } as unknown as PrismaService;
    const fieldReports = {
      create: jest.fn().mockRejectedValue({ code: 'P2002' }),
    } as unknown as FieldReportsService;
    const client = { sendText: jest.fn().mockResolvedValue(undefined) } as unknown as WhatsAppClient;
    const worker = new WhatsAppInboundWorker(
      prisma,
      fieldReports,
      {} as UploadsService,
      client,
      { isConfigured: () => false } as OpenRouterClient,
    );

    await worker.handle({ inboundId: 'in-1' });

    expect(client.sendText).not.toHaveBeenCalled();
    expect(prisma.whatsAppInboundMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WhatsAppInboundStatus.IGNORED,
          ignoreReason: 'duplicate sourceMessageId',
        }),
      }),
    );
  });
});
