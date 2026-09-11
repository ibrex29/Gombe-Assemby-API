import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, join } from 'path';
import {
  IncidentSeverity,
  isIncidentSeverityUrgent,
} from '@electromon/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OpenRouterClient } from '../ai/core/llm/openrouter.client';
import {
  TRIAGE_DIRTY_EVENT,
  type TriageDirtyPayload,
} from '../ai/triage/triage.events';
import { INCIDENT_TYPE_TITLES } from './voice-incident-parse';
import { classifyIncidentNarrative } from './incident-classify';
import {
  VOICE_INCIDENT_PROCESS_EVENT,
  type VoiceIncidentProcessJob,
} from './voice-incident.events';

const VOICE_TRANSCRIPTION_FAILED =
  'Voice report — transcription failed. Play the audio.';

@Injectable()
export class VoiceIncidentWorker implements OnModuleInit {
  private readonly logger = new Logger(VoiceIncidentWorker.name);

  constructor(
    private prisma: PrismaService,
    private llm: OpenRouterClient,
    private eventEmitter: EventEmitter2,
  ) {}

  onModuleInit() {
    if (this.isConfigured()) {
      this.logger.log(
        `Voice incident worker ready (stt: ${this.llm.getModelId('audio')}, classify: ${this.llm.getModelId('assistant')})`,
      );
    } else {
      this.logger.warn(
        'OPENROUTER_API_KEY is not set; voice incident processing is disabled',
      );
    }
  }

  isConfigured() {
    return (
      this.llm.isConfigured() &&
      this.llm.getModelId('audio') != null &&
      this.llm.getModelId('assistant') != null
    );
  }

  @OnEvent(VOICE_INCIDENT_PROCESS_EVENT, { async: true })
  async onProcessEvent(job: VoiceIncidentProcessJob) {
    await this.handle(job);
  }

  async handle(job: VoiceIncidentProcessJob) {
    if (!this.isConfigured()) return;

    const report = await this.prisma.fieldReport.findUnique({
      where: { id: job.reportId },
      select: {
        id: true,
        audioUrl: true,
        campaignId: true,
        wardId: true,
        pollingUnitId: true,
      },
    });

    if (!report?.audioUrl) return;

    try {
      const audio = await this.readAudio(report.audioUrl);
      if (!audio) {
        await this.markFailed(report.id, null);
        return;
      }

      const parsed = await this.transcribeAndClassify(audio);
      if (!parsed.ok) {
        await this.markFailed(report.id, parsed.originalTranscript ?? null, parsed.language);
        return;
      }

      const isUrgent = isIncidentSeverityUrgent(parsed.incidentSeverity);
      const updated = await this.prisma.fieldReport.update({
        where: { id: report.id },
        data: {
          description: parsed.englishSummary,
          title: INCIDENT_TYPE_TITLES[parsed.incidentType],
          incidentType: parsed.incidentType,
          incidentSeverity: parsed.incidentSeverity,
          isUrgent,
          sourceLanguage: parsed.language,
          originalTranscript: parsed.originalTranscript,
        },
        select: {
          campaignId: true,
          wardId: true,
          pollingUnitId: true,
          isUrgent: true,
          incidentSeverity: true,
        },
      });

      if (
        isUrgent ||
        parsed.incidentSeverity === IncidentSeverity.HIGH ||
        parsed.incidentSeverity === IncidentSeverity.CRITICAL
      ) {
        await this.emitTriageDirty({
          campaignId: updated.campaignId,
          wardId: updated.wardId,
          pollingUnitId: updated.pollingUnitId,
          isUrgent: updated.isUrgent,
          incidentSeverity: updated.incidentSeverity as IncidentSeverity | null,
        });
      }
    } catch (error) {
      this.logger.warn({ err: error, reportId: job.reportId }, 'Voice incident processing failed');
      await this.markFailed(job.reportId, null);
    }
  }

  private async transcribeAndClassify(audio: { mime: string; base64: string; format: string }) {
    const stt = await this.llm.transcribeAudio({
      base64: audio.base64,
      format: audio.format,
    });

    const parsed = await classifyIncidentNarrative(this.llm, stt.text);
    if (!parsed.ok) return parsed;

    return {
      ...parsed,
      language: parsed.language ?? stt.language ?? null,
      originalTranscript: parsed.originalTranscript || stt.text,
    };
  }

  private async markFailed(
    reportId: string,
    originalTranscript: string | null,
    language?: string | null,
  ) {
    await this.prisma.fieldReport.update({
      where: { id: reportId },
      data: {
        description: VOICE_TRANSCRIPTION_FAILED,
        ...(originalTranscript ? { originalTranscript } : {}),
        ...(language ? { sourceLanguage: language } : {}),
      },
    });
  }

  private async readAudio(url: string): Promise<{
    mime: string;
    base64: string;
    format: string;
  } | null> {
    let content: Buffer | null = null;
    if (/^https?:\/\//i.test(url)) {
      content = await this.downloadRemote(url);
    } else {
      const filename = this.filenameFromUrl(url);
      if (!filename) return null;
      const fullPath = join(process.cwd(), 'uploads', filename);
      if (!existsSync(fullPath)) return null;
      content = await readFile(fullPath);
    }
    if (!content || content.length === 0) return null;

    const mime = sniffAudioMime(content, url);
    return {
      mime,
      base64: content.toString('base64'),
      format: audioFormatForMime(mime, url),
    };
  }

  private async downloadRemote(url: string): Promise<Buffer | null> {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'audio/*,*/*' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        this.logger.warn({ url, status: response.status }, 'Remote voice download failed');
        return null;
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      this.logger.warn({ err: error, url }, 'Remote voice download error');
      return null;
    }
  }

  private filenameFromUrl(url: string): string | null {
    const marker = '/uploads/';
    const index = url.lastIndexOf(marker);
    const raw = index >= 0 ? url.slice(index + marker.length) : basename(url);
    const filename = raw.split('?')[0]?.split('#')[0];
    if (
      !filename ||
      filename.includes('..') ||
      filename.includes('/') ||
      filename.includes('\\')
    ) {
      return null;
    }
    return filename;
  }

  private async emitTriageDirty(report: {
    campaignId: string;
    wardId?: string | null;
    pollingUnitId?: string | null;
    isUrgent?: boolean;
    incidentSeverity?: IncidentSeverity | null;
  }) {
    try {
      const chain = await this.resolveTriageChain(report);
      const payload: TriageDirtyPayload = {
        campaignId: report.campaignId,
        ...chain,
        urgent:
          Boolean(report.isUrgent) ||
          report.incidentSeverity === IncidentSeverity.HIGH ||
          report.incidentSeverity === IncidentSeverity.CRITICAL,
      };
      this.eventEmitter.emit(TRIAGE_DIRTY_EVENT, payload);
    } catch {
      // Risk scoring is downstream; never fail processing over it.
    }
  }

  private async resolveTriageChain(report: {
    wardId?: string | null;
    pollingUnitId?: string | null;
  }): Promise<{ stateId?: string; lgaId?: string; wardId?: string }> {
    if (report.wardId) {
      const ward = await this.prisma.ward.findUnique({
        where: { id: report.wardId },
        select: { id: true, lgaId: true, lga: { select: { stateId: true } } },
      });
      return ward
        ? { stateId: ward.lga.stateId, lgaId: ward.lgaId, wardId: ward.id }
        : {};
    }
    if (report.pollingUnitId) {
      const pu = await this.prisma.pollingUnit.findUnique({
        where: { id: report.pollingUnitId },
        select: {
          wardId: true,
          ward: { select: { lgaId: true, lga: { select: { stateId: true } } } },
        },
      });
      return pu
        ? {
            stateId: pu.ward.lga.stateId,
            lgaId: pu.ward.lgaId,
            wardId: pu.wardId,
          }
        : {};
    }
    return {};
  }
}

function audioFormatForMime(mime: string, url: string): string {
  const lower = url.toLowerCase();
  if (mime.includes('mpeg') || lower.endsWith('.mp3')) return 'mp3';
  if (mime.includes('wav') || lower.endsWith('.wav')) return 'wav';
  if (mime.includes('webm') || lower.endsWith('.webm')) return 'webm';
  if (mime.includes('ogg') || lower.endsWith('.ogg')) return 'ogg';
  if (mime.includes('aac') || lower.endsWith('.aac')) return 'aac';
  if (mime.includes('mp4') || lower.endsWith('.m4a')) return 'm4a';
  return 'webm';
}

function sniffAudioMime(buf: Buffer, url: string): string {
  const lower = url.toLowerCase();
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.webm')) return 'audio/webm';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.aac')) return 'audio/aac';
  if (lower.endsWith('.m4a')) return 'audio/mp4';

  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    return 'audio/mpeg';
  }
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'RIFF') {
    return 'audio/wav';
  }
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'fLaC') {
    return 'audio/flac';
  }
  if (buf.length >= 8 && buf.toString('ascii', 4, 8) === 'ftyp') {
    return 'audio/mp4';
  }
  return 'audio/mp4';
}
