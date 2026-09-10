import { ForbiddenException, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  TRIAGE_DIRTY_EVENT,
  type TriageDirtyPayload,
} from '../ai/triage/triage.events';
import { Prisma } from '@electromon/db';
import { FieldReportStatus, FieldReportType, IncidentType, IncidentSeverity, isIncidentSeverityUrgent, JwtPayload, NotificationType, PulseSource, pulsePatchFromIncident } from '@electromon/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  getLgaScopeId,
  getStateScopeId,
  getWardScopeId,
  isLgaScopedUser,
  isStateScopedUser,
  isWardScopedUser,
  assertPollingUnitInWard,
} from '../../common/scoping/campaign-scope';
import {
  CreateFieldReportDto,
  ListFieldReportsQueryDto,
  UpdateFieldReportStatusDto,
} from './dto/field-report.dto';
import {
  NOTIFICATION_DISPATCH_EVENT,
  NotificationDispatchPayload,
} from '../notifications/notification.events';
import {
  VOICE_INCIDENT_PROCESS_EVENT,
  type VoiceIncidentProcessJob,
} from './voice-incident.events';
import { SituationRoomService } from '../situation-room/situation-room.service';

const VOICE_REPORT_TITLE = 'Voice report';
const VOICE_REPORT_PROCESSING = 'Voice report — processing…';

@Injectable()
export class FieldReportsService {
  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
    private situationRoom: SituationRoomService,
  ) {}

  private readonly include = {
    reporter: { select: { id: true, firstName: true, lastName: true } },
    handledBy: { select: { id: true, firstName: true, lastName: true } },
    ward: { select: { id: true, name: true, lgaId: true } },
    pollingUnit: {
      select: {
        id: true,
        code: true,
        name: true,
        ward: { select: { id: true, name: true, lgaId: true } },
      },
    },
  } as const;

  private async assertCampaignAccess(userId: string, campaignId: string) {
    const membership = await this.prisma.campaignMembership.findFirst({
      where: { userId, campaignId, isActive: true },
    });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this campaign');
    }
    return membership;
  }

  async list(user: JwtPayload, query: ListFieldReportsQueryDto) {
    await this.assertCampaignAccess(user.sub, query.campaignId);

    const wardScopeId = getWardScopeId(user);
    const lgaScopeId = getLgaScopeId(user);
    const stateScopeId = getStateScopeId(user);

    if (wardScopeId && query.wardId && query.wardId !== wardScopeId) {
      throw new ForbiddenException('You can only view incidents in your assigned ward');
    }

    if (lgaScopeId && query.lgaId && query.lgaId !== lgaScopeId) {
      throw new ForbiddenException('You can only view incidents in your assigned LGA');
    }

    if (stateScopeId && query.stateId && query.stateId !== stateScopeId) {
      throw new ForbiddenException('You can only view incidents in your assigned state');
    }

    const effectiveWardId = wardScopeId ?? query.wardId;
    const effectiveLgaId = wardScopeId ? undefined : lgaScopeId ?? query.lgaId;
    const effectiveStateId =
      wardScopeId || effectiveLgaId ? undefined : stateScopeId ?? query.stateId;

    if (stateScopeId && query.lgaId) {
      const lga = await this.prisma.lGA.findFirst({
        where: { id: query.lgaId, stateId: stateScopeId },
        select: { id: true },
      });
      if (!lga) {
        throw new ForbiddenException('You can only view incidents in your assigned state');
      }
    }

    if (stateScopeId && query.wardId && !wardScopeId) {
      const ward = await this.prisma.ward.findFirst({
        where: { id: query.wardId, lga: { stateId: stateScopeId } },
        select: { id: true },
      });
      if (!ward) {
        throw new ForbiddenException('You can only view incidents in your assigned state');
      }
    }

    if (wardScopeId && query.pollingUnitId) {
      await assertPollingUnitInWard(this.prisma, query.pollingUnitId, wardScopeId);
    }

    if (stateScopeId && query.pollingUnitId) {
      const unit = await this.prisma.pollingUnit.findFirst({
        where: { id: query.pollingUnitId, ward: { lga: { stateId: stateScopeId } } },
        select: { id: true },
      });
      if (!unit) {
        throw new ForbiddenException('You can only view incidents in your assigned state');
      }
    }

    const and: Prisma.FieldReportWhereInput[] = [];

    if (effectiveWardId) {
      and.push({
        OR: [{ wardId: effectiveWardId }, { pollingUnit: { wardId: effectiveWardId } }],
      });
    } else if (effectiveLgaId) {
      and.push({
        OR: [
          { ward: { lgaId: effectiveLgaId } },
          { pollingUnit: { ward: { lgaId: effectiveLgaId } } },
        ],
      });
    } else if (effectiveStateId) {
      and.push({
        OR: [
          { ward: { lga: { stateId: effectiveStateId } } },
          { pollingUnit: { ward: { lga: { stateId: effectiveStateId } } } },
        ],
      });
    }

    if (query.search) {
      and.push({
        OR: [
          { title: { contains: query.search, mode: 'insensitive' } },
          { description: { contains: query.search, mode: 'insensitive' } },
        ],
      });
    }

    const where: Prisma.FieldReportWhereInput = {
      campaignId: query.campaignId,
      ...(query.type && { type: query.type }),
      ...(query.incidentType && { incidentType: query.incidentType }),
      ...(query.incidentSeverity && { incidentSeverity: query.incidentSeverity }),
      ...(query.status && { status: query.status }),
      ...(query.isUrgent !== undefined && { isUrgent: query.isUrgent }),
      ...(query.pollingUnitId && { pollingUnitId: query.pollingUnitId }),
      ...(query.reportedById && { reportedById: query.reportedById }),
      ...(and.length ? { AND: and } : {}),
    };

    return this.prisma.fieldReport.findMany({
      where,
      include: this.include,
      orderBy: [{ isUrgent: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
  }

  async create(user: JwtPayload, dto: CreateFieldReportDto) {
    await this.assertCampaignAccess(user.sub, dto.campaignId);

    const isIncident =
      dto.type === FieldReportType.INCIDENT || dto.type === FieldReportType.SECURITY_CONCERN;
    const isVoiceReport = Boolean(dto.audioUrl?.trim());

    if (isIncident && !isVoiceReport && !dto.incidentType) {
      throw new BadRequestException('incidentType is required for incident reports');
    }
    if (isIncident && !isVoiceReport && !dto.incidentSeverity) {
      throw new BadRequestException('incidentSeverity is required for incident reports');
    }

    const incidentType =
      dto.incidentType ?? (isVoiceReport ? IncidentType.OTHERS : undefined);
    const incidentSeverity =
      dto.incidentSeverity ?? (isVoiceReport ? IncidentSeverity.MEDIUM : undefined);
    const title = dto.title?.trim() || (isVoiceReport ? VOICE_REPORT_TITLE : '');
    const description =
      dto.description?.trim() || (isVoiceReport ? VOICE_REPORT_PROCESSING : '');

    if (!title) {
      throw new BadRequestException('title is required');
    }
    if (!description) {
      throw new BadRequestException('description is required');
    }

    const isUrgent =
      dto.isUrgent ??
      (incidentSeverity ? isIncidentSeverityUrgent(incidentSeverity) : false);

    const wardScopeId = isWardScopedUser(user) ? getWardScopeId(user) : null;
    let wardId = dto.wardId;

    if (wardScopeId) {
      if (dto.wardId && dto.wardId !== wardScopeId) {
        throw new ForbiddenException('You can only report incidents for your assigned ward');
      }
      wardId = wardScopeId;
    }

    const stateScopeId = getStateScopeId(user);

    if (dto.pollingUnitId) {
      const campaign = await this.prisma.campaign.findUniqueOrThrow({
        where: { id: dto.campaignId },
        select: { stateId: true, isNational: true },
      });
      const unit = await this.prisma.pollingUnit.findFirst({
        where: campaign.isNational
          ? { id: dto.pollingUnitId }
          : { id: dto.pollingUnitId, ward: { lga: { stateId: campaign.stateId } } },
      });
      if (!unit) throw new NotFoundException('Polling unit not found in campaign geography');
      if (wardScopeId) {
        await assertPollingUnitInWard(this.prisma, dto.pollingUnitId, wardScopeId);
      }
      if (stateScopeId) {
        const inState = await this.prisma.pollingUnit.findFirst({
          where: { id: dto.pollingUnitId, ward: { lga: { stateId: stateScopeId } } },
          select: { id: true },
        });
        if (!inState) {
          throw new ForbiddenException('You can only report incidents in your assigned state');
        }
      }
      wardId = wardId ?? unit.wardId;
    }

    if (wardScopeId && !wardId) {
      wardId = wardScopeId;
    }

    if (stateScopeId && wardId) {
      const ward = await this.prisma.ward.findFirst({
        where: { id: wardId, lga: { stateId: stateScopeId } },
        select: { id: true },
      });
      if (!ward) {
        throw new ForbiddenException('You can only report incidents in your assigned state');
      }
    }

    // Ward officers escalate to LGA on create; PU agents leave as OPEN for ward triage.
    const initialStatus =
      wardScopeId && isIncident ? FieldReportStatus.ESCALATED : FieldReportStatus.OPEN;

    const created = await this.prisma.fieldReport.create({
      data: {
        campaignId: dto.campaignId,
        reportedById: user.sub,
        type: dto.type,
        incidentType,
        incidentSeverity,
        title,
        description,
        wardId,
        pollingUnitId: dto.pollingUnitId,
        latitude: dto.latitude,
        longitude: dto.longitude,
        isUrgent,
        photoUrls: dto.photoUrls ?? [],
        audioUrl: dto.audioUrl?.trim() || null,
        status: initialStatus,
        ...(initialStatus === FieldReportStatus.ESCALATED
          ? { handledById: user.sub, handledAt: new Date() }
          : {}),
      },
      include: this.include,
    });

    if (isVoiceReport && created.audioUrl) {
      const job: VoiceIncidentProcessJob = { reportId: created.id };
      this.eventEmitter.emit(VOICE_INCIDENT_PROCESS_EVENT, job);
    }

    if (isIncident) {
      this.emitNotification({
        type:
          initialStatus === FieldReportStatus.ESCALATED
            ? NotificationType.INCIDENT_ESCALATED
            : NotificationType.INCIDENT_REPORTED,
        campaignId: created.campaignId,
        actorUserId: user.sub,
        entityType: 'FIELD_REPORT',
        entityId: created.id,
        sourceEventId: `${created.id}:${initialStatus}`,
        sendPush: initialStatus === FieldReportStatus.OPEN,
        fieldReport: {
          wardId: created.wardId,
          pollingUnitId: created.pollingUnitId,
          reportedById: created.reportedById,
          isUrgent: created.isUrgent,
          incidentSeverity: created.incidentSeverity,
          status: created.status,
        },
      });
      await this.ingestIncidentPulse(user, created);
    }

    return created;
  }

  async updateStatus(user: JwtPayload, id: string, dto: UpdateFieldReportStatusDto) {
    const report = await this.prisma.fieldReport.findUnique({
      where: { id },
      include: {
        ward: { select: { id: true, lgaId: true } },
        pollingUnit: { select: { wardId: true, ward: { select: { lgaId: true } } } },
      },
    });
    if (!report) throw new NotFoundException('Field report not found');

    await this.assertCampaignAccess(user.sub, report.campaignId);

    const reportWardId = report.wardId ?? report.pollingUnit?.wardId ?? report.ward?.id;
    const reportLgaId =
      report.ward?.lgaId ?? report.pollingUnit?.ward?.lgaId ?? undefined;

    if (isWardScopedUser(user)) {
      const wardScopeId = getWardScopeId(user)!;
      if (reportWardId !== wardScopeId) {
        throw new ForbiddenException('You can only manage incidents in your assigned ward');
      }
      if (dto.status === FieldReportStatus.RESOLVED && report.status === FieldReportStatus.ESCALATED) {
        throw new ForbiddenException(
          'Escalated incidents are resolved by the LGA coordinator',
        );
      }
      if (report.status === FieldReportStatus.RESOLVED) {
        throw new ForbiddenException('This incident is already resolved');
      }
    } else if (isLgaScopedUser(user)) {
      const lgaScopeId = getLgaScopeId(user)!;
      if (reportLgaId && reportLgaId !== lgaScopeId) {
        throw new ForbiddenException('You can only manage incidents in your assigned LGA');
      }
      if (!reportLgaId && reportWardId) {
        const ward = await this.prisma.ward.findUnique({
          where: { id: reportWardId },
          select: { lgaId: true },
        });
        if (ward?.lgaId !== lgaScopeId) {
          throw new ForbiddenException('You can only manage incidents in your assigned LGA');
        }
      }
    } else if (isStateScopedUser(user)) {
      const assignedStateId = getStateScopeId(user)!;
      const reportStateId = await this.resolveReportStateId(report);
      if (!reportStateId || reportStateId !== assignedStateId) {
        throw new ForbiddenException('You can only manage incidents in your assigned state');
      }
    }

    if (
      dto.status !== FieldReportStatus.ESCALATED &&
      dto.status !== FieldReportStatus.RESOLVED &&
      dto.status !== FieldReportStatus.OPEN
    ) {
      throw new ForbiddenException('Invalid status transition');
    }

    const updated = await this.prisma.fieldReport.update({
      where: { id },
      data: {
        status: dto.status,
        wardComment: dto.wardComment ?? report.wardComment,
        handledById: user.sub,
        handledAt: new Date(),
      },
      include: this.include,
    });

    if (dto.status === FieldReportStatus.RESOLVED) {
      this.emitNotification({
        type: NotificationType.INCIDENT_RESOLVED,
        campaignId: updated.campaignId,
        actorUserId: user.sub,
        entityType: 'FIELD_REPORT',
        entityId: updated.id,
        sourceEventId: `${updated.id}:RESOLVED`,
        sendPush: true,
        fieldReport: {
          wardId: updated.wardId,
          pollingUnitId: updated.pollingUnitId,
          reportedById: updated.reportedById,
          isUrgent: updated.isUrgent,
          incidentSeverity: updated.incidentSeverity,
          status: updated.status,
        },
      });
    } else if (dto.status === FieldReportStatus.ESCALATED) {
      this.emitNotification({
        type: NotificationType.INCIDENT_ESCALATED,
        campaignId: updated.campaignId,
        actorUserId: user.sub,
        entityType: 'FIELD_REPORT',
        entityId: updated.id,
        sourceEventId: `${updated.id}:ESCALATED`,
        sendPush: false,
        fieldReport: {
          wardId: updated.wardId,
          pollingUnitId: updated.pollingUnitId,
          reportedById: updated.reportedById,
          isUrgent: updated.isUrgent,
          incidentSeverity: updated.incidentSeverity,
          status: updated.status,
        },
      });
    }

    return updated;
  }

  private async resolveReportStateId(report: {
    wardId?: string | null;
    pollingUnitId?: string | null;
    ward?: { lgaId?: string | null } | null;
    pollingUnit?: { ward?: { lgaId?: string | null } } | null;
  }): Promise<string | undefined> {
    const lgaId = report.ward?.lgaId ?? report.pollingUnit?.ward?.lgaId ?? undefined;
    if (lgaId) {
      const lga = await this.prisma.lGA.findUnique({
        where: { id: lgaId },
        select: { stateId: true },
      });
      return lga?.stateId;
    }
    if (report.wardId) {
      const ward = await this.prisma.ward.findUnique({
        where: { id: report.wardId },
        select: { lga: { select: { stateId: true } } },
      });
      return ward?.lga.stateId;
    }
    if (report.pollingUnitId) {
      const pu = await this.prisma.pollingUnit.findUnique({
        where: { id: report.pollingUnitId },
        select: { ward: { select: { lga: { select: { stateId: true } } } } },
      });
      return pu?.ward.lga.stateId;
    }
    return undefined;
  }

  private async ingestIncidentPulse(
    user: JwtPayload,
    created: {
      campaignId: string;
      pollingUnitId: string | null;
      incidentType: IncidentType | string | null;
      isUrgent: boolean;
    },
  ) {
    if (!created.pollingUnitId) return;
    const patch = pulsePatchFromIncident(created.incidentType);
    try {
      await this.situationRoom.ingestInferredPulse({
        campaignId: created.campaignId,
        pollingUnitId: created.pollingUnitId,
        reportedById: user.sub,
        source: PulseSource.INCIDENT,
        heartbeatOnly: patch.heartbeatOnly === true,
        notify: patch.heartbeatOnly !== true,
        atmosphere: patch.atmosphere,
        bvasStatus: patch.bvasStatus,
        materialsComplete: patch.materialsComplete,
        rivalMobilization: patch.rivalMobilization,
        rivalTactics: patch.rivalTactics,
        isUrgent: created.isUrgent || patch.isUrgent,
      });
    } catch {
      // Incident create must not fail because pulse ingest blipped.
    }
  }

  private emitNotification(payload: NotificationDispatchPayload) {
    this.eventEmitter.emit(NOTIFICATION_DISPATCH_EVENT, payload);

    // Incidents feed the risk score, so anything worth notifying about is also
    // worth rescoring. Riding the same seam keeps the two in step.
    if (payload.fieldReport && payload.campaignId) {
      void this.emitTriageDirty({
        campaignId: payload.campaignId,
        wardId: payload.fieldReport.wardId,
        pollingUnitId: payload.fieldReport.pollingUnitId,
        isUrgent: payload.fieldReport.isUrgent,
        incidentSeverity: payload.fieldReport.incidentSeverity,
      });
    }
  }

  /**
   * Tell the risk engine this place needs rescoring.
   *
   * Fire-and-forget, and emitted rather than called so this module never has to
   * import TriageModule — the same decoupling the notification dispatch uses.
   * An urgent or high-severity report earns an immediate ward pass instead of
   * waiting for the next drain.
   */
  private async emitTriageDirty(report: {
    campaignId: string;
    wardId?: string | null;
    pollingUnitId?: string | null;
    isUrgent?: boolean;
    incidentSeverity?: string | null;
  }) {
    try {
      const chain = await this.resolveTriageChain(report);
      const payload: TriageDirtyPayload = {
        campaignId: report.campaignId,
        ...chain,
        urgent:
          Boolean(report.isUrgent) ||
          report.incidentSeverity === 'HIGH' ||
          report.incidentSeverity === 'CRITICAL',
      };
      this.eventEmitter.emit(TRIAGE_DIRTY_EVENT, payload);
    } catch {
      // Risk scoring is downstream of reporting; never fail a report over it.
    }
  }

  /** Ward and LGA (and their state) for whichever geography the report carries. */
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
