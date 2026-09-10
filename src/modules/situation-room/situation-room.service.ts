import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@electromon/db';
import {
  CampaignRole,
  CollationLevel,
  CollationResultStatus,
  ElectionDayPhase,
  JwtPayload,
  NotificationType,
  PulseAtmosphere,
  PulseBvasStatus,
  PulseSource,
  RivalMobilization,
  RivalTactic,
  ScopeType,
  SituationStatus,
  emptyPartyTotals,
  getPartyCodes,
  hasOpened,
  isMaterialPulseChange,
  isPulseSilent,
  laterElectionDayPhase,
  mapPhaseToStatus,
  mapStatusToPhase,
  mergeRivalTactics,
  normalizeTrackedParties,
  observedLead,
  parseObservedPartyResults,
  parsePartyTotals,
  sumPartyMaps,
} from '@electromon/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContestService } from '../../common/contest/contest.service';
import {
  CreateSituationUpdateDto,
  ListSituationUpdatesQueryDto,
  PulseActionDto,
  PulseRollupQueryDto,
  PulseUnitsQueryDto,
  UpdateSituationUpdateDto,
} from './dto/situation-update.dto';
import {
  NOTIFICATION_DISPATCH_EVENT,
  NotificationDispatchPayload,
} from '../notifications/notification.events';

const historyInclude = {
  pollingUnit: {
    select: {
      id: true,
      code: true,
      name: true,
      wardId: true,
      ward: { select: { id: true, name: true, lgaId: true } },
    },
  },
  reporter: { select: { id: true, firstName: true, lastName: true } },
} as const;

const WRITE_ROLES = new Set<CampaignRole>([
  CampaignRole.CAMPAIGN_DIRECTOR,
  CampaignRole.STATE_COLLATION_OFFICER,
  CampaignRole.LGA_COLLATION_OFFICER,
  CampaignRole.WARD_RA_OFFICER,
  CampaignRole.POLLING_AGENT_COORDINATOR,
  CampaignRole.POLLING_AGENT,
  CampaignRole.POLLING_UNIT_OFFICER,
  CampaignRole.LGA_COORDINATOR,
  CampaignRole.WARD_COORDINATOR,
  CampaignRole.STATE_COORDINATOR,
]);

export type IngestPulseInput = {
  campaignId: string;
  pollingUnitId: string;
  reportedById: string;
  source: PulseSource;
  phase?: ElectionDayPhase;
  status?: SituationStatus;
  atmosphere?: PulseAtmosphere | null;
  bvasStatus?: PulseBvasStatus | null;
  queue?: CreateSituationUpdateDto['queue'];
  materialsComplete?: boolean | null;
  securityPresent?: boolean | null;
  turnoutBand?: CreateSituationUpdateDto['turnoutBand'];
  estimatedAccredited?: number | null;
  rivalAgentPresent?: boolean | null;
  rivalMobilization?: RivalMobilization | null;
  crowdLean?: CreateSituationUpdateDto['crowdLean'];
  whoLooksAhead?: CreateSituationUpdateDto['whoLooksAhead'];
  rivalTactics?: RivalTactic[];
  observedPartyResults?: Record<string, number> | null;
  observedConfidence?: CreateSituationUpdateDto['observedConfidence'];
  photoUrls?: string[];
  notes?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  isUrgent?: boolean;
  heartbeatOnly?: boolean;
  notify?: boolean;
};

@Injectable()
export class SituationRoomService {
  constructor(
    private prisma: PrismaService,
    private contests: ContestService,
    private eventEmitter: EventEmitter2,
  ) {}

  private async assertCampaignAccess(userId: string, campaignId: string) {
    const membership = await this.prisma.campaignMembership.findFirst({
      where: { userId, campaignId, isActive: true },
    });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this campaign');
    }
    return membership;
  }

  private async getCampaignGeo(campaignId: string) {
    return this.prisma.campaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: {
        stateId: true,
        isNational: true,
        clientPartyCode: true,
        trackedParties: true,
      },
    });
  }

  private async assertPollingUnitInCampaign(campaignId: string, pollingUnitId: string) {
    const campaign = await this.getCampaignGeo(campaignId);
    const unit = await this.prisma.pollingUnit.findFirst({
      where: campaign.isNational
        ? { id: pollingUnitId }
        : { id: pollingUnitId, ward: { lga: { stateId: campaign.stateId } } },
      include: { ward: { select: { id: true, lgaId: true, lga: { select: { stateId: true } } } } },
    });
    if (!unit) {
      throw new NotFoundException('Polling unit not found in campaign state');
    }
    return unit;
  }

  private assertWriteScope(user: JwtPayload, unit: { id: string; ward: { id: string; lgaId: string; lga: { stateId: string } } }) {
    if (!user.role || !WRITE_ROLES.has(user.role as CampaignRole)) {
      throw new ForbiddenException('Insufficient permissions');
    }
    if (user.role === CampaignRole.CAMPAIGN_DIRECTOR || user.role === CampaignRole.POLLING_AGENT_COORDINATOR) {
      return;
    }
    if (
      user.role === CampaignRole.POLLING_AGENT ||
      user.role === CampaignRole.POLLING_UNIT_OFFICER ||
      user.scopeType === ScopeType.POLLING_UNIT
    ) {
      if (user.scopeId !== unit.id) {
        throw new ForbiddenException('You can only update your assigned polling unit');
      }
      return;
    }
    if (
      user.role === CampaignRole.WARD_RA_OFFICER ||
      user.role === CampaignRole.WARD_COORDINATOR ||
      user.scopeType === ScopeType.WARD
    ) {
      if (user.scopeId !== unit.ward.id) {
        throw new ForbiddenException('Polling unit is outside your assigned ward');
      }
      return;
    }
    if (
      user.role === CampaignRole.LGA_COLLATION_OFFICER ||
      user.role === CampaignRole.LGA_COORDINATOR ||
      user.scopeType === ScopeType.LGA
    ) {
      if (user.scopeId !== unit.ward.lgaId) {
        throw new ForbiddenException('Polling unit is outside your assigned LGA');
      }
      return;
    }
    if (
      user.role === CampaignRole.STATE_COLLATION_OFFICER ||
      user.role === CampaignRole.STATE_COORDINATOR ||
      user.scopeType === ScopeType.STATE
    ) {
      if (user.scopeId !== unit.ward.lga.stateId) {
        throw new ForbiddenException('Polling unit is outside your assigned state');
      }
    }
  }

  private async campaignPuFilter(campaignId: string): Promise<Prisma.SituationUpdateWhereInput> {
    const campaign = await this.getCampaignGeo(campaignId);
    if (campaign.isNational) return { campaignId };
    return {
      pollingUnit: { ward: { lga: { stateId: campaign.stateId } } },
    };
  }

  async list(user: JwtPayload, query: ListSituationUpdatesQueryDto) {
    await this.assertCampaignAccess(user.sub, query.campaignId);
    const geoFilter = await this.campaignPuFilter(query.campaignId);

    const where: Prisma.SituationUpdateWhereInput = {
      ...geoFilter,
      ...(query.status && { status: query.status }),
      ...(query.phase && { phase: query.phase }),
      ...(query.pollingUnitId && { pollingUnitId: query.pollingUnitId }),
      ...(query.reportedById && { reportedById: query.reportedById }),
      ...(query.isUrgent !== undefined && { isUrgent: query.isUrgent }),
    };

    return this.prisma.situationUpdate.findMany({
      where,
      include: historyInclude,
      orderBy: [{ isUrgent: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
  }

  async getSummary(user: JwtPayload, campaignId: string) {
    const rollup = await this.getPulseRollup(user, { campaignId });
    return {
      campaignId,
      totalUpdates: rollup.checkedIn,
      open: rollup.voting,
      reporting: rollup.counting,
      closed: rollup.closed,
      incidents: 0,
      urgent: rollup.bvasDown + rollup.tenseOrDisrupted,
      totalPollingUnits: rollup.totalPollingUnits,
      unitsWithUpdates: rollup.checkedIn,
      checkedIn: rollup.checkedIn,
      opened: rollup.opened,
      voting: rollup.voting,
      counting: rollup.counting,
      silent: rollup.silent,
      bvasDown: rollup.bvasDown,
      rivalHeavy: rollup.rivalHeavy,
    };
  }

  async findOne(user: JwtPayload, id: string, campaignId: string) {
    await this.assertCampaignAccess(user.sub, campaignId);

    const update = await this.prisma.situationUpdate.findFirst({
      where: { id, ...(await this.campaignPuFilter(campaignId)) },
      include: historyInclude,
    });
    if (!update) {
      throw new NotFoundException('Situation update not found');
    }
    return update;
  }

  async getMyPulse(user: JwtPayload, campaignId?: string) {
    const resolvedCampaignId = campaignId ?? user.campaignId;
    if (!resolvedCampaignId) {
      throw new ForbiddenException('Campaign membership required');
    }
    await this.assertCampaignAccess(user.sub, resolvedCampaignId);
    if (!user.scopeId) {
      throw new ForbiddenException('No polling unit is assigned to this account');
    }
    const unit = await this.assertPollingUnitInCampaign(resolvedCampaignId, user.scopeId);
    this.assertWriteScope(user, unit);
    const pulse = await this.prisma.pollingUnitPulse.findUnique({
      where: {
        campaignId_pollingUnitId: {
          campaignId: resolvedCampaignId,
          pollingUnitId: unit.id,
        },
      },
      include: {
        pollingUnit: { select: { id: true, code: true, name: true, wardId: true } },
        reporter: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    if (!pulse) {
      return {
        pollingUnitId: unit.id,
        pollingUnit: { id: unit.id, code: unit.code, name: unit.name },
        phase: null,
        silent: true,
      };
    }
    return {
      ...pulse,
      silent: isPulseSilent({ phase: pulse.phase, lastPulseAt: pulse.lastPulseAt }),
    };
  }

  async getPulseRollup(user: JwtPayload, query: PulseRollupQueryDto) {
    await this.assertCampaignAccess(user.sub, query.campaignId);
    const campaign = await this.getCampaignGeo(query.campaignId);
    const level = query.level ?? this.defaultRollupLevel(user);
    const scopeId = query.scopeId ?? this.defaultScopeId(user, campaign.stateId, query.campaignId, level);
    const puWhere = this.puWhereForScope(level, scopeId, campaign);
    const partyCodes = getPartyCodes(normalizeTrackedParties(campaign.trackedParties));

    const [totalPollingUnits, pulses] = await Promise.all([
      this.prisma.pollingUnit.count({ where: puWhere }),
      this.prisma.pollingUnitPulse.findMany({
        where: { campaignId: query.campaignId, pollingUnit: puWhere },
      }),
    ]);

    const now = new Date();
    let liveNonSilent = 0;
    let opened = 0;
    let voting = 0;
    let closed = 0;
    let counting = 0;
    let materialsIncomplete = 0;
    let bvasDown = 0;
    let tenseOrDisrupted = 0;
    let rivalHeavy = 0;
    let withObserved = 0;
    const observedTotals: Record<string, number>[] = [];

    for (const pulse of pulses) {
      const isSilent = isPulseSilent({
        phase: pulse.phase,
        lastPulseAt: pulse.lastPulseAt,
        now,
      });
      if (!isSilent) liveNonSilent += 1;
      if (hasOpened(pulse.phase)) opened += 1;
      if (pulse.phase === ElectionDayPhase.VOTING) voting += 1;
      if (pulse.phase === ElectionDayPhase.CLOSED) closed += 1;
      if (pulse.phase === ElectionDayPhase.COUNTING) counting += 1;
      if (pulse.materialsComplete === false) materialsIncomplete += 1;
      if (pulse.bvasStatus === PulseBvasStatus.DOWN) bvasDown += 1;
      if (pulse.atmosphere === PulseAtmosphere.TENSE || pulse.atmosphere === PulseAtmosphere.DISRUPTED) {
        tenseOrDisrupted += 1;
      }
      if (pulse.rivalMobilization === RivalMobilization.HEAVY) rivalHeavy += 1;
      if (pulse.observedPartyResults) {
        withObserved += 1;
        observedTotals.push(parsePartyTotals(pulse.observedPartyResults, partyCodes));
      }
    }

    const official =
      level === CollationLevel.WARD || level === CollationLevel.LGA
        ? pulses.length === 0
          ? []
          : await this.prisma.collationResult.findMany({
              where: {
                campaignId: query.campaignId,
                contestId: this.contests.current()?.id,
                level: CollationLevel.POLLING_UNIT,
                scopeId: { in: pulses.map((row) => row.pollingUnitId) },
                status: { in: [CollationResultStatus.SUBMITTED, CollationResultStatus.APPROVED] },
              },
              select: { partyResults: true },
            })
        : await this.prisma.collationResult.findMany({
            where:
              level === CollationLevel.POLLING_UNIT
                ? {
                    campaignId: query.campaignId,
                    level: CollationLevel.POLLING_UNIT,
                    scopeId,
                    status: { in: [CollationResultStatus.SUBMITTED, CollationResultStatus.APPROVED] },
                  }
                : level === CollationLevel.STATE
                  ? {
                      campaignId: query.campaignId,
                      level: CollationLevel.STATE,
                      scopeId,
                      status: { in: [CollationResultStatus.SUBMITTED, CollationResultStatus.APPROVED] },
                    }
                  : {
                      campaignId: query.campaignId,
                      level: CollationLevel.NATIONAL,
                      status: { in: [CollationResultStatus.SUBMITTED, CollationResultStatus.APPROVED] },
                    },
            select: { partyResults: true },
          });

    return {
      campaignId: query.campaignId,
      level,
      scopeId,
      totalPollingUnits,
      checkedIn: pulses.length,
      opened,
      voting,
      closed,
      counting,
      silent: Math.max(0, totalPollingUnits - liveNonSilent),
      materialsIncomplete,
      bvasDown,
      tenseOrDisrupted,
      rivalHeavy,
      withObserved,
      officialSheetIn: official.length,
      partyTotals: {
        observed: observedTotals.length ? sumPartyMaps(observedTotals) : emptyPartyTotals(partyCodes),
        official: sumPartyMaps(official.map((row) => parsePartyTotals(row.partyResults, partyCodes))),
      },
    };
  }

  async listPulseUnits(user: JwtPayload, query: PulseUnitsQueryDto) {
    await this.assertCampaignAccess(user.sub, query.campaignId);
    if (!query.wardId && !query.lgaId) {
      throw new BadRequestException('wardId or lgaId is required');
    }
    if (query.wardId) this.assertReadWard(user, query.wardId);
    if (query.lgaId) this.assertReadLga(user, query.lgaId);

    const pus = await this.prisma.pollingUnit.findMany({
      where: query.wardId
        ? { wardId: query.wardId }
        : { ward: { lgaId: query.lgaId } },
      select: {
        id: true,
        code: true,
        name: true,
        wardId: true,
        latitude: true,
        longitude: true,
        ward: { select: { id: true, name: true, lgaId: true } },
      },
      orderBy: { code: 'asc' },
      take: query.take ?? 2500,
    });
    const pulses = await this.prisma.pollingUnitPulse.findMany({
      where: {
        campaignId: query.campaignId,
        pollingUnitId: { in: pus.map((pu) => pu.id) },
      },
      include: {
        reporter: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    const byPu = new Map(pulses.map((row) => [row.pollingUnitId, row]));
    const now = new Date();
    const rows = pus.map((pu) => {
      const pulse = byPu.get(pu.id);
      const silent = isPulseSilent({ phase: pulse?.phase, lastPulseAt: pulse?.lastPulseAt, now });
      return {
        pollingUnit: pu,
        pollingUnitId: pu.id,
        silent,
        ...pulse,
        phase: pulse?.phase ?? null,
      };
    });
    return rows.filter((row) => {
      if (query.phase && row.phase !== query.phase) return false;
      if (query.silent === true && !row.silent) return false;
      if (query.silent === false && row.silent) return false;
      return true;
    });
  }

  async listPulseHistory(user: JwtPayload, campaignId: string, pollingUnitId: string) {
    await this.assertCampaignAccess(user.sub, campaignId);
    await this.assertPollingUnitInCampaign(campaignId, pollingUnitId);
    return this.prisma.situationUpdate.findMany({
      where: { campaignId, pollingUnitId },
      include: historyInclude,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async checkIn(user: JwtPayload, dto: PulseActionDto) {
    const { campaignId, pollingUnitId } = await this.resolveAgentUnit(user, dto);
    const previous = await this.prisma.pollingUnitPulse.findUnique({
      where: { campaignId_pollingUnitId: { campaignId, pollingUnitId } },
    });
    if (previous) {
      return this.getMyPulse(user, campaignId);
    }
    await this.ingestInferredPulse({
      campaignId,
      pollingUnitId,
      reportedById: user.sub,
      source: PulseSource.CHECK_IN,
      phase: ElectionDayPhase.CHECKED_IN,
    });
    return this.getMyPulse(user, campaignId);
  }

  async heartbeat(user: JwtPayload, dto: PulseActionDto) {
    const { campaignId, pollingUnitId } = await this.resolveAgentUnit(user, dto);
    const previous = await this.prisma.pollingUnitPulse.findUnique({
      where: { campaignId_pollingUnitId: { campaignId, pollingUnitId } },
    });
    if (!previous) {
      return this.getMyPulse(user, campaignId);
    }
    await this.ingestInferredPulse({
      campaignId,
      pollingUnitId,
      reportedById: user.sub,
      source: PulseSource.HEARTBEAT,
      heartbeatOnly: true,
      notify: false,
    });
    return this.getMyPulse(user, campaignId);
  }

  async ingestInferredPulse(input: IngestPulseInput) {
    const campaign = await this.getCampaignGeo(input.campaignId);
    const partyCodes = getPartyCodes(normalizeTrackedParties(campaign.trackedParties));

    const previous = await this.prisma.pollingUnitPulse.findUnique({
      where: {
        campaignId_pollingUnitId: {
          campaignId: input.campaignId,
          pollingUnitId: input.pollingUnitId,
        },
      },
    });

    if (input.heartbeatOnly) {
      if (!previous) return null;
      const now = new Date();
      await this.prisma.pollingUnitPulse.update({
        where: {
          campaignId_pollingUnitId: {
            campaignId: input.campaignId,
            pollingUnitId: input.pollingUnitId,
          },
        },
        data: { lastPulseAt: now, reportedById: input.reportedById },
      });
      return previous;
    }

    const requestedPhase =
      input.phase ?? (input.status ? mapStatusToPhase(input.status) : undefined);
    if (!requestedPhase && !previous && input.source === PulseSource.MANUAL) {
      throw new BadRequestException('phase or status is required');
    }

    const phase =
      input.source === PulseSource.MANUAL && requestedPhase
        ? requestedPhase
        : laterElectionDayPhase(
            previous?.phase as ElectionDayPhase | undefined,
            requestedPhase ??
              (previous?.phase as ElectionDayPhase | undefined) ??
              ElectionDayPhase.CHECKED_IN,
          );
    const status = input.status ?? mapPhaseToStatus(phase);

    let observed: Record<string, number> | null = null;
    if (input.observedPartyResults) {
      if (phase !== ElectionDayPhase.COUNTING) {
        throw new BadRequestException('Observed party totals are only allowed during COUNTING');
      }
      try {
        observed = parseObservedPartyResults(input.observedPartyResults, partyCodes);
      } catch (error) {
        throw new BadRequestException(error instanceof Error ? error.message : 'Invalid observed totals');
      }
    }

    const mergedTactics =
      input.rivalTactics != null
        ? input.source === PulseSource.INCIDENT
          ? mergeRivalTactics(previous?.rivalTactics as RivalTactic[] | undefined, input.rivalTactics)
          : input.rivalTactics
        : ((previous?.rivalTactics ?? []) as RivalTactic[]);

    const whoLooksAhead =
      input.whoLooksAhead ??
      (phase === ElectionDayPhase.COUNTING && observed
        ? observedLead(observed, campaign.clientPartyCode)
        : (previous?.whoLooksAhead ?? null));

    const snapshot = {
      campaignId: input.campaignId,
      pollingUnitId: input.pollingUnitId,
      reportedById: input.reportedById,
      status,
      phase,
      source: input.source,
      atmosphere: input.atmosphere ?? previous?.atmosphere ?? null,
      bvasStatus: input.bvasStatus ?? previous?.bvasStatus ?? null,
      queue: input.queue ?? previous?.queue ?? null,
      materialsComplete: input.materialsComplete ?? previous?.materialsComplete ?? null,
      securityPresent: input.securityPresent ?? previous?.securityPresent ?? null,
      turnoutBand: input.turnoutBand ?? previous?.turnoutBand ?? null,
      estimatedAccredited: input.estimatedAccredited ?? previous?.estimatedAccredited ?? null,
      rivalAgentPresent: input.rivalAgentPresent ?? previous?.rivalAgentPresent ?? null,
      rivalMobilization: input.rivalMobilization ?? previous?.rivalMobilization ?? null,
      crowdLean: input.crowdLean ?? previous?.crowdLean ?? null,
      whoLooksAhead,
      rivalTactics: mergedTactics,
      observedPartyResults:
        (phase === ElectionDayPhase.COUNTING
          ? (observed as Prisma.InputJsonValue | undefined) ?? previous?.observedPartyResults
          : Prisma.DbNull) ?? Prisma.JsonNull,
      observedConfidence:
        phase === ElectionDayPhase.COUNTING
          ? (input.observedConfidence ?? previous?.observedConfidence ?? null)
          : null,
      photoUrls: input.photoUrls ?? previous?.photoUrls ?? [],
      notes: input.notes ?? previous?.notes ?? null,
      latitude: input.latitude ?? previous?.latitude ?? null,
      longitude: input.longitude ?? previous?.longitude ?? null,
      isUrgent: input.isUrgent ?? false,
    };

    const material = isMaterialPulseChange(
      previous
        ? {
            phase: previous.phase,
            atmosphere: previous.atmosphere,
            bvasStatus: previous.bvasStatus,
            rivalMobilization: previous.rivalMobilization,
            observedPartyResults: parsePartyTotals(previous.observedPartyResults, partyCodes),
          }
        : null,
      {
        phase,
        atmosphere: snapshot.atmosphere,
        bvasStatus: snapshot.bvasStatus,
        rivalMobilization: snapshot.rivalMobilization,
        observedPartyResults: observed,
      },
      campaign.clientPartyCode,
    );
    const urgent =
      snapshot.isUrgent ||
      snapshot.bvasStatus === PulseBvasStatus.DOWN ||
      snapshot.atmosphere === PulseAtmosphere.DISRUPTED ||
      snapshot.rivalMobilization === RivalMobilization.HEAVY;

    const shouldNotify = input.notify !== false && material;

    const created = await this.prisma.$transaction(async (tx) => {
      const history = await tx.situationUpdate.create({
        data: {
          ...snapshot,
          isUrgent: urgent,
        },
        include: historyInclude,
      });
      await tx.pollingUnitPulse.upsert({
        where: {
          campaignId_pollingUnitId: {
            campaignId: input.campaignId,
            pollingUnitId: input.pollingUnitId,
          },
        },
        create: {
          ...snapshot,
          isUrgent: urgent,
          lastPulseAt: history.createdAt,
        },
        update: {
          ...snapshot,
          isUrgent: urgent,
          lastPulseAt: history.createdAt,
        },
      });
      return history;
    });

    if (shouldNotify) {
      this.emitNotification({
        type: NotificationType.SITUATION_UPDATE,
        campaignId: input.campaignId,
        actorUserId: input.reportedById,
        entityType: 'SITUATION_UPDATE',
        entityId: created.id,
        sourceEventId: created.id,
        sendPush: true,
        situationUpdate: {
          pollingUnitId: created.pollingUnitId,
          isUrgent: urgent,
          status: created.status,
        },
      });
    }

    return created;
  }

  async create(user: JwtPayload, dto: CreateSituationUpdateDto) {
    await this.assertCampaignAccess(user.sub, dto.campaignId);
    const unit = await this.assertPollingUnitInCampaign(dto.campaignId, dto.pollingUnitId);
    this.assertWriteScope(user, unit);

    const previous = await this.prisma.pollingUnitPulse.findUnique({
      where: {
        campaignId_pollingUnitId: {
          campaignId: dto.campaignId,
          pollingUnitId: dto.pollingUnitId,
        },
      },
    });
    if (!dto.phase && !dto.status && !previous) {
      throw new BadRequestException('phase or status is required');
    }

    return this.ingestInferredPulse({
      campaignId: dto.campaignId,
      pollingUnitId: dto.pollingUnitId,
      reportedById: user.sub,
      source: dto.source ?? PulseSource.MANUAL,
      phase: dto.phase,
      status: dto.status,
      atmosphere: dto.atmosphere,
      bvasStatus: dto.bvasStatus,
      queue: dto.queue,
      materialsComplete: dto.materialsComplete,
      securityPresent: dto.securityPresent,
      turnoutBand: dto.turnoutBand,
      estimatedAccredited: dto.estimatedAccredited,
      rivalAgentPresent: dto.rivalAgentPresent,
      rivalMobilization: dto.rivalMobilization,
      crowdLean: dto.crowdLean,
      whoLooksAhead: dto.whoLooksAhead,
      rivalTactics: dto.rivalTactics,
      observedPartyResults: dto.observedPartyResults ?? null,
      observedConfidence: dto.observedConfidence,
      photoUrls: dto.photoUrls,
      notes: dto.notes,
      latitude: dto.latitude,
      longitude: dto.longitude,
      isUrgent: dto.isUrgent,
    });
  }

  async update(user: JwtPayload, id: string, dto: UpdateSituationUpdateDto) {
    if (!dto.campaignId) {
      throw new ForbiddenException('campaignId is required');
    }

    await this.findOne(user, id, dto.campaignId);

    if (dto.pollingUnitId) {
      const unit = await this.assertPollingUnitInCampaign(dto.campaignId, dto.pollingUnitId);
      this.assertWriteScope(user, unit);
    }

    if (dto.observedPartyResults && dto.phase && dto.phase !== ElectionDayPhase.COUNTING) {
      throw new BadRequestException('Observed party totals are only allowed during COUNTING');
    }

    const { campaignId: _campaignId, ...data } = dto;
    return this.prisma.situationUpdate.update({
      where: { id },
      data: {
        ...data,
        phase: dto.phase ?? (dto.status ? mapStatusToPhase(dto.status) : undefined),
        status: dto.status ?? (dto.phase ? mapPhaseToStatus(dto.phase) : undefined),
      },
      include: historyInclude,
    });
  }

  async remove(user: JwtPayload, id: string, campaignId: string) {
    await this.findOne(user, id, campaignId);
    await this.prisma.situationUpdate.delete({ where: { id } });
    return { success: true, message: 'Situation update deleted' };
  }

  private defaultRollupLevel(user: JwtPayload): CollationLevel {
    if (user.scopeType === ScopeType.WARD) return CollationLevel.WARD;
    if (user.scopeType === ScopeType.LGA) return CollationLevel.LGA;
    if (user.scopeType === ScopeType.STATE) return CollationLevel.STATE;
    if (user.scopeType === ScopeType.POLLING_UNIT) return CollationLevel.POLLING_UNIT;
    return CollationLevel.NATIONAL;
  }

  private defaultScopeId(
    user: JwtPayload,
    campaignStateId: string,
    campaignId: string,
    level: CollationLevel,
  ) {
    if (user.scopeId && level !== CollationLevel.NATIONAL) return user.scopeId;
    if (level === CollationLevel.STATE) return campaignStateId;
    return campaignId;
  }

  private puWhereForScope(
    level: CollationLevel,
    scopeId: string,
    campaign: { isNational: boolean; stateId: string },
  ): Prisma.PollingUnitWhereInput {
    if (level === CollationLevel.POLLING_UNIT) return { id: scopeId };
    if (level === CollationLevel.WARD) return { wardId: scopeId };
    if (level === CollationLevel.LGA) return { ward: { lgaId: scopeId } };
    if (level === CollationLevel.STATE) return { ward: { lga: { stateId: scopeId } } };
    if (!campaign.isNational) return { ward: { lga: { stateId: campaign.stateId } } };
    return {};
  }

  private assertReadWard(user: JwtPayload, wardId: string) {
    if (user.scopeType === ScopeType.WARD && user.scopeId !== wardId) {
      throw new ForbiddenException('You can only view pulse units in your assigned ward');
    }
  }

  private assertReadLga(user: JwtPayload, lgaId: string) {
    if (user.scopeType === ScopeType.LGA && user.scopeId !== lgaId) {
      throw new ForbiddenException('You can only view pulse units in your assigned LGA');
    }
    if (user.scopeType === ScopeType.WARD) {
      throw new ForbiddenException('Ward officers must pass wardId');
    }
  }

  private async resolveAgentUnit(user: JwtPayload, dto: PulseActionDto) {
    await this.assertCampaignAccess(user.sub, dto.campaignId);
    const pollingUnitId = dto.pollingUnitId ?? user.scopeId;
    if (!pollingUnitId) {
      throw new ForbiddenException('No polling unit is assigned to this account');
    }
    const unit = await this.assertPollingUnitInCampaign(dto.campaignId, pollingUnitId);
    this.assertWriteScope(user, unit);
    return { campaignId: dto.campaignId, pollingUnitId: unit.id };
  }

  private emitNotification(payload: NotificationDispatchPayload) {
    this.eventEmitter.emit(NOTIFICATION_DISPATCH_EVENT, payload);
  }
}
