import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  CampaignRole,
  FieldReportSource,
  FieldReportType,
  isIncidentSeverityUrgent,
  JwtPayload,
  ScopeType,
  WhatsAppInboundStatus,
} from '@electromon/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { phoneLookupCandidates } from '../auth/phone.util';
import { FieldReportsService } from '../field-reports/field-reports.service';
import { classifyIncidentNarrative } from '../field-reports/incident-classify';
import { INCIDENT_TYPE_TITLES } from '../field-reports/voice-incident-parse';
import { OpenRouterClient } from '../ai/core/llm/openrouter.client';
import { UploadsService } from '../uploads/uploads.service';
import {
  isHelpCommand,
  parseStoredWhatsAppMessage,
  UNSUPPORTED_WHATSAPP_TYPES,
  type ParsedWhatsAppMessage,
} from './whatsapp-inbound.parser';
import { WhatsAppClient } from './whatsapp.client';
import { WHATSAPP_INBOUND_EVENT, type WhatsAppInboundJob } from './whatsapp.events';

const REPLY = {
  notRegistered:
    'This number is not registered as a Pantamiyya field agent. Ask your ward officer to add you, then try again.',
  help: 'To report an incident, send a text, photo, or voice note to this number.\n\nUse My Unit in Pantamiyya for result sheets.',
  unsupported:
    'Please send a text, photo, or voice note. We cannot file videos or documents as incidents.',
  failed: 'We could not save that. Try again or report it in My Unit.',
};

@Injectable()
export class WhatsAppInboundWorker {
  private readonly logger = new Logger(WhatsAppInboundWorker.name);

  constructor(
    private prisma: PrismaService,
    private fieldReports: FieldReportsService,
    private uploads: UploadsService,
    private client: WhatsAppClient,
    private llm: OpenRouterClient,
  ) {}

  @OnEvent(WHATSAPP_INBOUND_EVENT, { async: true })
  async onInbound(job: WhatsAppInboundJob) {
    await this.handle(job);
  }

  async handle(job: WhatsAppInboundJob) {
    const inbound = await this.prisma.whatsAppInboundMessage.findUnique({
      where: { id: job.inboundId },
    });
    if (!inbound) return;
    if (
      inbound.status === WhatsAppInboundStatus.PROCESSED ||
      inbound.status === WhatsAppInboundStatus.IGNORED
    ) {
      return;
    }

    const message = parseStoredWhatsAppMessage(inbound.payload);
    if (!message) {
      await this.mark(inbound.id, WhatsAppInboundStatus.IGNORED, 'unreadable payload');
      return;
    }

    try {
      if (isHelpCommand(message.text) && !message.image && !message.audio) {
        await this.client.sendText(message.from, REPLY.help);
        await this.mark(inbound.id, WhatsAppInboundStatus.IGNORED, 'help');
        return;
      }

      const hasContent = Boolean(
        message.text || message.image || message.audio || message.location,
      );
      if (!hasContent || (UNSUPPORTED_WHATSAPP_TYPES.has(message.type) && !hasContent)) {
        await this.client.sendText(message.from, REPLY.unsupported);
        await this.mark(inbound.id, WhatsAppInboundStatus.IGNORED, `unsupported:${message.type}`);
        return;
      }

      const agent = await this.resolveAgent(message.from);
      if (!agent) {
        await this.client.sendText(message.from, REPLY.notRegistered);
        await this.mark(inbound.id, WhatsAppInboundStatus.IGNORED, 'unregistered');
        return;
      }

      const created = await this.createReport(agent, message);
      if (!created) {
        await this.client.sendText(message.from, REPLY.failed);
        await this.mark(inbound.id, WhatsAppInboundStatus.FAILED, 'create failed');
        return;
      }

      await this.prisma.whatsAppInboundMessage.update({
        where: { id: inbound.id },
        data: {
          status: WhatsAppInboundStatus.PROCESSED,
          fieldReportId: created.id,
        },
      });

      const puCode = created.pollingUnit?.code;
      await this.client.sendText(
        message.from,
        `Incident logged${puCode ? ` for PU ${puCode}` : ''}. Ref ${created.id}.`,
      );
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        await this.mark(inbound.id, WhatsAppInboundStatus.IGNORED, 'duplicate sourceMessageId');
        return;
      }
      this.logger.warn({ err: error, inboundId: inbound.id }, 'WhatsApp inbound processing failed');
      await this.mark(inbound.id, WhatsAppInboundStatus.FAILED, 'processing error');
      await this.client.sendText(message.from, REPLY.failed);
    }
  }

  private async createReport(
    agent: ResolvedAgent,
    message: ParsedWhatsAppMessage,
  ) {
    const user = this.toJwtPayload(agent);
    let photoUrls: string[] = [];
    let audioUrl: string | undefined;
    let latitude = message.location?.latitude;
    let longitude = message.location?.longitude;

    if (message.image) {
      const media = await this.client.downloadMedia(message.image);
      if (!media) return null;
      const uploaded = await this.uploads.saveBuffer({
        buffer: media.buffer,
        mimeType: message.image.mimeType || media.mimeType,
        originalname: `whatsapp-${message.wamid}.jpg`,
      });
      photoUrls = [uploaded.url];
    }

    if (message.audio) {
      const media = await this.client.downloadMedia(message.audio);
      if (!media) return null;
      const uploaded = await this.uploads.saveBuffer({
        buffer: media.buffer,
        mimeType: message.audio.mimeType || media.mimeType,
        originalname: `whatsapp-${message.wamid}.ogg`,
      });
      audioUrl = uploaded.url;
    }

    const caption = message.image?.caption?.trim();
    const narrative = message.text?.trim() || caption || '';
    const locationOnly = Boolean(message.location) && !narrative && !photoUrls.length && !audioUrl;

    const created = await this.fieldReports.create(
      user,
      {
        campaignId: agent.membership.campaignId,
        type: FieldReportType.INCIDENT,
        title: undefined,
        description:
          narrative ||
          (locationOnly
            ? 'Agent shared a location.'
            : photoUrls.length
              ? 'Photo submitted via WhatsApp.'
              : undefined),
        pollingUnitId: agent.pollingUnitId,
        wardId: agent.wardId,
        latitude,
        longitude,
        photoUrls,
        audioUrl,
      },
      {
        source: FieldReportSource.WHATSAPP,
        sourceMessageId: message.wamid,
      },
    );

    if (narrative && !audioUrl) {
      await this.classifyTextReport(created.id, narrative);
    }

    return created;
  }

  private async classifyTextReport(reportId: string, narrative: string) {
    if (!this.llm.isConfigured() || !this.llm.getModelId('assistant')) return;
    try {
      const parsed = await classifyIncidentNarrative(this.llm, narrative);
      if (!parsed.ok) return;
      const isUrgent = isIncidentSeverityUrgent(parsed.incidentSeverity);
      await this.prisma.fieldReport.update({
        where: { id: reportId },
        data: {
          description: parsed.englishSummary,
          title: INCIDENT_TYPE_TITLES[parsed.incidentType],
          incidentType: parsed.incidentType,
          incidentSeverity: parsed.incidentSeverity,
          isUrgent,
          sourceLanguage: parsed.language,
          originalTranscript: parsed.originalTranscript || narrative,
        },
      });
    } catch (error) {
      this.logger.warn({ err: error, reportId }, 'WhatsApp text classification failed');
    }
  }

  private async resolveAgent(from: string): Promise<ResolvedAgent | null> {
    const candidates = [
      ...phoneLookupCandidates(from.startsWith('+') ? from : `+${from}`),
      from,
    ];
    const unique = [...new Set(candidates.filter(Boolean))];
    const campaignId = process.env.WHATSAPP_CAMPAIGN_ID?.trim();

    const user = await this.prisma.user.findFirst({
      where: { isActive: true, phoneNumber: { in: unique } },
      include: {
        memberships: {
          where: { isActive: true, ...(campaignId ? { campaignId } : {}) },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!user || user.memberships.length === 0) return null;

    const membership =
      user.memberships.find((row) => row.scopeType === ScopeType.POLLING_UNIT) ??
      user.memberships.find((row) => row.scopeType === ScopeType.WARD) ??
      user.memberships[0];

    let pollingUnitId: string | undefined;
    let wardId: string | undefined;
    if (membership.scopeType === ScopeType.POLLING_UNIT && membership.scopeId) {
      pollingUnitId = membership.scopeId;
      const unit = await this.prisma.pollingUnit.findUnique({
        where: { id: membership.scopeId },
        select: { wardId: true },
      });
      wardId = unit?.wardId;
    } else if (membership.scopeType === ScopeType.WARD && membership.scopeId) {
      wardId = membership.scopeId;
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        phoneNumber: user.phoneNumber,
      },
      membership: {
        campaignId: membership.campaignId,
        role: membership.role as CampaignRole,
        scopeType: (membership.scopeType as ScopeType | null) ?? null,
        scopeId: membership.scopeId,
      },
      pollingUnitId,
      wardId,
    };
  }

  private toJwtPayload(agent: ResolvedAgent): JwtPayload {
    return {
      sub: agent.user.id,
      email: agent.user.email,
      phoneNumber: agent.user.phoneNumber,
      campaignId: agent.membership.campaignId,
      role: agent.membership.role,
      scopeType: agent.membership.scopeType ?? undefined,
      scopeId: agent.membership.scopeId ?? undefined,
    };
  }

  private async mark(id: string, status: WhatsAppInboundStatus, ignoreReason?: string) {
    await this.prisma.whatsAppInboundMessage.update({
      where: { id },
      data: { status, ignoreReason: ignoreReason ?? null },
    });
  }

  private isUniqueViolation(error: unknown) {
    return (
      typeof error === 'object' &&
      error != null &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    );
  }
}

type ResolvedAgent = {
  user: {
    id: string;
    email: string;
    phoneNumber: string | null;
  };
  membership: {
    campaignId: string;
    role: CampaignRole;
    scopeType: ScopeType | null;
    scopeId: string | null;
  };
  pollingUnitId?: string;
  wardId?: string;
};
