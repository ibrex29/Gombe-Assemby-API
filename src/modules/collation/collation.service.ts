import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  TRIAGE_DIRTY_EVENT,
  type TriageDirtyPayload,
} from '../ai/triage/triage.events';
import {
  CampaignRole,
  CollationLevel,
  CollationResultStatus,
  ElectionDayPhase,
  JwtPayload,
  NotificationType,
  PulseSource,
  ScopeType,
  getParentLevel,
  getCollationLevelForRole,
  getPartyCodes,
  isCampaignAdminRole,
  normalizeTrackedParties,
  parsePartyTotals,
  normalizeZoneLabel,
  emptyPartyTotals,
  observedLead,
} from '@electromon/shared';
import { Prisma } from '@electromon/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContestService } from '../../common/contest/contest.service';
import { ScopeResolverService } from '../../common/collation/scope-resolver.service';
import { CreateCollationResultDto, RejectCollationResultDto, ApproveCollationResultDto } from './dto/collation.dto';
import {
  NOTIFICATION_DISPATCH_EVENT,
  NotificationDispatchPayload,
} from '../notifications/notification.events';
import {
  countPuVerifications,
  emptyPuVerificationCounts,
  ocrVerificationWrite,
  resolveOcrVerification,
  verificationSortRank,
  type CollationFigures,
} from './ocr-verification';
import { OcrQueueService } from './ocr-queue.service';
import { Ec8aPhotoReaderService } from './ec8a-photo-reader.service';
import { CollationBrowseService } from './collation-browse.service';
import { CollationReadinessService } from './collation-readiness.service';
import { IREV_FETCH_EVENT } from '../irev/irev-fetch.events';
import { resolveIrevVerification } from '../irev/irev-verification';
import { SituationRoomService } from '../situation-room/situation-room.service';
import type { VisionExtract } from './ocr-ec8a-parse';

export type LgaResultsSort = 'name' | 'total' | 'client' | 'turnout' | 'updated';

export interface ListResultsQuery {
  status?: CollationResultStatus | 'NOT_STARTED';
  stateId?: string;
  zone?: string;
  search?: string;
  sort?: LgaResultsSort;
  limit?: number;
}

type MapOutcome = 'WIN' | 'LOSS' | 'TIE' | 'PENDING';

function computeClientOutcome(
  parties: Record<string, number>,
  partyColumns: string[],
  clientPartyCode?: string | null,
): { outcome: MapOutcome; leadingParty: string | null; margin: number } {
  let max = 0;
  for (const code of partyColumns) {
    max = Math.max(max, parties[code] ?? 0);
  }
  if (max <= 0) return { outcome: 'PENDING', leadingParty: null, margin: 0 };

  const leaders = partyColumns.filter((code) => (parties[code] ?? 0) === max);
  const leadingParty = leaders[0] ?? null;
  const clientVotes = clientPartyCode ? (parties[clientPartyCode] ?? 0) : 0;

  if (!clientPartyCode) return { outcome: 'PENDING', leadingParty, margin: max - clientVotes };
  if (leaders.includes(clientPartyCode) && leaders.length > 1) {
    return { outcome: 'TIE', leadingParty: clientPartyCode, margin: 0 };
  }
  if (leaders[0] === clientPartyCode) {
    const second = Math.max(
      0,
      ...partyColumns
        .filter((code) => code !== clientPartyCode)
        .map((code) => parties[code] ?? 0),
    );
    return { outcome: 'WIN', leadingParty: clientPartyCode, margin: clientVotes - second };
  }
  return { outcome: 'LOSS', leadingParty, margin: clientVotes - max };
}

const EDITABLE_STATUSES = new Set<CollationResultStatus>([
  CollationResultStatus.DRAFT,
  CollationResultStatus.REJECTED,
]);

const PU_STATUS_RANK: Record<string, number> = {
  SUBMITTED: 0,
  REJECTED: 1,
  DRAFT: 2,
  NOT_STARTED: 3,
  APPROVED: 4,
};

type ContestBrief = {
  id: string;
  type: string;
  slug: string;
  label: string;
  isDefault: boolean;
};

function toContestBrief(contest: {
  id: string;
  type: string;
  slug: string;
  label: string;
  isDefault: boolean;
}): ContestBrief {
  return {
    id: contest.id,
    type: contest.type,
    slug: contest.slug,
    label: contest.label,
    isDefault: contest.isDefault,
  };
}

function pickMostActionableStatus(statuses: string[]): string {
  let best = 'NOT_STARTED';
  let bestRank = PU_STATUS_RANK.NOT_STARTED ?? 3;
  for (const status of statuses) {
    const rank = PU_STATUS_RANK[status] ?? 9;
    if (rank < bestRank) {
      best = status;
      bestRank = rank;
    }
  }
  return best;
}

function emptyStatusCounts(totalPus: number) {
  return {
    submitted: 0,
    approved: 0,
    rejected: 0,
    draft: 0,
    notStarted: 0,
    totalPus,
  };
}

@Injectable()
export class CollationService {
  constructor(
    private prisma: PrismaService,
    private contests: ContestService,
    private scopeResolver: ScopeResolverService,
    private eventEmitter: EventEmitter2,
    private ocrQueue: OcrQueueService,
    private photoReader: Ec8aPhotoReaderService,
    private browseService: CollationBrowseService,
    private readinessService: CollationReadinessService,
    private situationRoom: SituationRoomService,
  ) {}

  async getDashboard(user: JwtPayload) {
    if (!user.role || !user.campaignId) {
      throw new ForbiddenException('No active campaign membership');
    }

    if (isCampaignAdminRole(user.role)) {
      const campaign = await this.prisma.campaign.findUnique({
        where: { id: user.campaignId },
        include: { state: { select: { id: true, name: true } } },
      });
      if (!campaign) throw new ForbiddenException('Campaign not found');

      const submittedCount = await this.prisma.collationResult.count({
        where: {
          campaignId: user.campaignId,
          level: CollationLevel.POLLING_UNIT,
          status: CollationResultStatus.SUBMITTED,
        },
      });

      return {
        dashboard: {
          level: campaign.isNational ? CollationLevel.NATIONAL : CollationLevel.STATE,
          levelLabel: campaign.isNational ? 'National Campaign Command' : 'Campaign Command (Admin)',
          levelOrder: campaign.isNational ? 5 : 4,
          scopeType: campaign.isNational ? ScopeType.NATIONAL : ScopeType.STATE,
          scopeId: campaign.isNational ? 'NGA' : campaign.stateId,
          scopeName: campaign.isNational ? 'Nigeria' : campaign.state.name,
          canSubmit: false,
          canApprove: false,
          canComment: true,
          canRequestCorrection: true,
          route: '/dashboard/lgas',
        },
        scopeChain: {
          state: campaign.isNational
            ? { id: 'NGA', name: 'Nigeria' }
            : { id: campaign.state.id, name: campaign.state.name },
        },
        pendingApprovals: submittedCount,
        myResult: null,
        myResults: [],
      };
    }

    const dashboard = await this.scopeResolver.buildDashboard(
      user.role as CampaignRole,
      user.scopeType as ScopeType,
      user.scopeId,
    );

    const level = getCollationLevelForRole(user.role as CampaignRole);
    const pendingApprovals = level
      ? await this.countPendingApprovals(user.campaignId, level, user.scopeType as ScopeType, user.scopeId)
      : 0;

    const myResult = level
      ? await this.prisma.collationResult.findFirst({
          where: {
            campaignId: user.campaignId,
            contestId: this.contests.current()?.id,
            level,
            scopeType: user.scopeType as ScopeType,
            scopeId: user.scopeId ?? '',
          },
        })
      : null;

    const campaignContests = user.campaignId ? await this.contests.list(user.campaignId) : [];
    const myResultRows =
      level && campaignContests.length > 0
        ? await this.prisma.collationResult.findMany({
            where: {
              campaignId: user.campaignId,
              contestId: { in: campaignContests.map((contest) => contest.id) },
              level,
              scopeType: user.scopeType as ScopeType,
              scopeId: user.scopeId ?? '',
            },
          })
        : [];
    const myResultByContestId = new Map(myResultRows.map((row) => [row.contestId, row]));
    const myResults = campaignContests.map((contest) => ({
      contest: toContestBrief(contest),
      result: myResultByContestId.get(contest.id) ?? null,
    }));

    return {
      dashboard,
      scopeChain: user.scopeType && user.scopeId
        ? await this.scopeResolver.resolveScopeChain(user.scopeType as ScopeType, user.scopeId)
        : null,
      pendingApprovals,
      myResult,
      myResults,
    };
  }

  async listResults(user: JwtPayload, query: ListResultsQuery = {}) {
    if (isCampaignAdminRole(user.role)) {
      if (!user.campaignId) {
        throw new ForbiddenException('No active campaign membership');
      }
      if (!query.stateId) {
        return this.listStateCollationResults(user.campaignId, {
          ...query,
          limit: query.limit ?? 50,
        });
      }
      return this.listLgaCollationResults(user.campaignId, {
        ...query,
        limit: query.limit ?? 774,
      });
    }

    if (user.role === CampaignRole.STATE_COLLATION_OFFICER) {
      if (!user.campaignId || !user.scopeId) {
        throw new ForbiddenException('No active campaign membership');
      }
      return this.listLgaCollationResults(user.campaignId, {
        ...query,
        stateId: user.scopeId,
        limit: query.limit ?? 200,
      });
    }

    this.assertCollationUser(user);

    const level = getCollationLevelForRole(user.role as CampaignRole)!;
    const where: Record<string, unknown> = {
      campaignId: user.campaignId,
      level,
      scopeType: user.scopeType,
      scopeId: user.scopeId,
    };
    if (query.status) where.status = query.status;

    return this.prisma.collationResult.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: {
        submittedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        approvedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
  }

  private async listStateCollationResults(campaignId: string, query: ListResultsQuery = {}) {
    const { status, zone, search, sort = 'name', limit = 50 } = query;

    const campaign = await this.prisma.campaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: { clientPartyCode: true, trackedParties: true },
    });
    const partyColumns = getPartyCodes(normalizeTrackedParties(campaign.trackedParties));
    const clientPartyCode = campaign.clientPartyCode;

    const stateWhere: Prisma.StateWhereInput = {};
    if (zone) {
      const normalizedZone = normalizeZoneLabel(zone);
      if (!normalizedZone) return [];
      stateWhere.zone = normalizedZone;
    }
    if (search?.trim()) {
      stateWhere.name = { contains: search.trim(), mode: Prisma.QueryMode.insensitive };
    }

    const states = await this.prisma.state.findMany({
      where: stateWhere,
      orderBy: { name: 'asc' },
      take: limit,
      select: { id: true, name: true, code: true, zone: true },
    });
    if (!states.length) return [];

    const stateIds = states.map((s) => s.id);
    const [rows, lgaCounts] = await Promise.all([
      this.prisma.collationResult.findMany({
        where: {
          campaignId,
          level: CollationLevel.STATE,
          scopeId: { in: stateIds },
        },
        include: {
          submittedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
          approvedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      }),
      this.prisma.lGA.groupBy({
        by: ['stateId'],
        where: { stateId: { in: stateIds } },
        _count: { id: true },
      }),
    ]);
    const resultByState = new Map(rows.map((r) => [r.scopeId, r]));
    const lgaCountByState = new Map(lgaCounts.map((row) => [row.stateId, row._count.id]));

    const mapRow = (state: (typeof states)[number], r: (typeof rows)[number]) => {
      const parties = parsePartyTotals(r.partyResults, partyColumns);
      const totalVotes = Object.values(parties).reduce((sum, n) => sum + n, 0);
      const { outcome, leadingParty, margin } = computeClientOutcome(
        parties,
        partyColumns,
        clientPartyCode,
      );
      const registered = r.registeredVoters ?? 0;
      const cast = r.votesCast ?? totalVotes;
      const turnoutPercent = registered > 0 ? (cast / registered) * 100 : 0;
      const clientVotes = clientPartyCode ? (parties[clientPartyCode] ?? 0) : 0;
      const lgaCount = lgaCountByState.get(state.id) ?? 0;

      return {
        ...r,
        level: CollationLevel.STATE,
        scopeName: state.name,
        stateName: null,
        stateCode: state.code ?? null,
        stateZone: state.zone ?? null,
        areaCount: lgaCount,
        leadingParty,
        margin,
        outcome,
        totalVotes,
        clientVotes,
        turnoutPercent,
      };
    };

    let mapped = states.map((state) => {
      const existing = resultByState.get(state.id);
      if (existing) return mapRow(state, existing);

      const lgaCount = lgaCountByState.get(state.id) ?? 0;
      return {
        id: `not-started:${state.id}`,
        campaignId,
        level: CollationLevel.STATE,
        scopeType: ScopeType.STATE,
        scopeId: state.id,
        status: 'NOT_STARTED' as const,
        partyResults: emptyPartyTotals(partyColumns),
        registeredVoters: null,
        votesCast: null,
        accreditedVoters: null,
        updatedAt: new Date(0),
        submittedAt: null,
        submittedBy: null,
        approvedBy: null,
        scopeName: state.name,
        stateName: null,
        stateCode: state.code ?? null,
        stateZone: state.zone ?? null,
        areaCount: lgaCount,
        leadingParty: null,
        margin: 0,
        outcome: 'PENDING' as const,
        totalVotes: 0,
        clientVotes: 0,
        turnoutPercent: 0,
      };
    });

    if (status) {
      mapped = mapped.filter((row) => row.status === status);
    }

    mapped.sort((a, b) => {
      switch (sort) {
        case 'total':
          return (b.totalVotes ?? 0) - (a.totalVotes ?? 0);
        case 'client':
          return (b.clientVotes ?? 0) - (a.clientVotes ?? 0);
        case 'turnout':
          return (b.turnoutPercent ?? 0) - (a.turnoutPercent ?? 0);
        case 'updated':
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        case 'name':
        default:
          return (a.scopeName ?? '').localeCompare(b.scopeName ?? '', undefined, {
            sensitivity: 'base',
          });
      }
    });

    return mapped;
  }

  private async listLgaCollationResults(campaignId: string, query: ListResultsQuery = {}) {
    const { status, stateId, zone, search, sort = 'name', limit = 774 } = query;

    const campaign = await this.prisma.campaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: { clientPartyCode: true, trackedParties: true },
    });
    const partyColumns = getPartyCodes(normalizeTrackedParties(campaign.trackedParties));
    const clientPartyCode = campaign.clientPartyCode;

    const lgaWhere: Prisma.LGAWhereInput = {};
    if (stateId) lgaWhere.stateId = stateId;
    if (zone) {
      const normalizedZone = normalizeZoneLabel(zone);
      if (!normalizedZone) return [];
      lgaWhere.state = { zone: normalizedZone };
    }
    if (search?.trim()) {
      lgaWhere.OR = [
        { name: { contains: search.trim(), mode: Prisma.QueryMode.insensitive } },
        { state: { name: { contains: search.trim(), mode: Prisma.QueryMode.insensitive } } },
      ];
    }

    const lgas = await this.prisma.lGA.findMany({
      where: lgaWhere,
      orderBy: { name: 'asc' },
      take: limit,
      select: {
        id: true,
        name: true,
        state: { select: { name: true, code: true, zone: true } },
      },
    });
    if (!lgas.length) return [];

    const lgaIds = lgas.map((l) => l.id);
    const rows = await this.prisma.collationResult.findMany({
      where: {
        campaignId,
        level: CollationLevel.LGA,
        scopeId: { in: lgaIds },
      },
      include: {
        submittedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        approvedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
    const resultByLga = new Map(rows.map((r) => [r.scopeId, r]));

    const mapRow = (lga: (typeof lgas)[number], r: (typeof rows)[number]) => {
      const parties = parsePartyTotals(r.partyResults, partyColumns);
      const totalVotes = Object.values(parties).reduce((sum, n) => sum + n, 0);
      const { outcome, leadingParty, margin } = computeClientOutcome(
        parties,
        partyColumns,
        clientPartyCode,
      );
      const registered = r.registeredVoters ?? 0;
      const cast = r.votesCast ?? totalVotes;
      const turnoutPercent = registered > 0 ? (cast / registered) * 100 : 0;
      const clientVotes = clientPartyCode ? (parties[clientPartyCode] ?? 0) : 0;

      return {
        ...r,
        scopeName: lga.name,
        stateName: lga.state.name ?? null,
        stateCode: lga.state.code ?? null,
        stateZone: lga.state.zone ?? null,
        leadingParty,
        margin,
        outcome,
        totalVotes,
        clientVotes,
        turnoutPercent,
      };
    };

    let mapped = lgas.map((lga) => {
      const existing = resultByLga.get(lga.id);
      if (existing) return mapRow(lga, existing);

      return {
        id: `not-started:${lga.id}`,
        campaignId,
        level: CollationLevel.LGA,
        scopeType: ScopeType.LGA,
        scopeId: lga.id,
        status: 'NOT_STARTED' as const,
        partyResults: emptyPartyTotals(partyColumns),
        registeredVoters: null,
        votesCast: null,
        accreditedVoters: null,
        updatedAt: new Date(0),
        submittedAt: null,
        submittedBy: null,
        approvedBy: null,
        scopeName: lga.name,
        stateName: lga.state.name ?? null,
        stateCode: lga.state.code ?? null,
        stateZone: lga.state.zone ?? null,
        leadingParty: null,
        margin: 0,
        outcome: 'PENDING' as const,
        totalVotes: 0,
        clientVotes: 0,
        turnoutPercent: 0,
      };
    });

    if (status) {
      mapped = mapped.filter((row) => row.status === status);
    }

    mapped.sort((a, b) => {
      switch (sort) {
        case 'total':
          return (b.totalVotes ?? 0) - (a.totalVotes ?? 0);
        case 'client':
          return (b.clientVotes ?? 0) - (a.clientVotes ?? 0);
        case 'turnout':
          return (b.turnoutPercent ?? 0) - (a.turnoutPercent ?? 0);
        case 'updated':
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        case 'name':
        default:
          return (a.scopeName ?? '').localeCompare(b.scopeName ?? '', undefined, {
            sensitivity: 'base',
          });
      }
    });

    return mapped;
  }

  async getPollingUnitResultForViewer(user: JwtPayload, pollingUnitId: string) {
    if (!user.campaignId || !user.role) {
      throw new ForbiddenException('No active campaign membership');
    }

    const pu = await this.prisma.pollingUnit.findUnique({
      where: { id: pollingUnitId },
      include: { ward: { include: { lga: { select: { id: true, stateId: true, name: true } } } } },
    });
    if (!pu) throw new NotFoundException('Polling unit not found');

    const campaign = await this.prisma.campaign.findUnique({
      where: { id: user.campaignId },
      select: { stateId: true, isNational: true },
    });
    if (!campaign || (!campaign.isNational && pu.ward.lga.stateId !== campaign.stateId)) {
      throw new ForbiddenException('Polling unit is outside your campaign geography');
    }

    if (isCampaignAdminRole(user.role)) {
      // full state access
    } else if (
      user.role === CampaignRole.LGA_COLLATION_OFFICER ||
      user.scopeType === ScopeType.LGA
    ) {
      if (user.scopeId !== pu.ward.lgaId) {
        throw new ForbiddenException('Polling unit is outside your assigned LGA');
      }
    } else if (
      user.role === CampaignRole.WARD_RA_OFFICER ||
      user.scopeType === ScopeType.WARD
    ) {
      if (user.scopeId !== pu.wardId) {
        throw new ForbiddenException('Polling unit is outside your assigned ward');
      }
    } else if (
      user.role === CampaignRole.POLLING_AGENT ||
      user.scopeType === ScopeType.POLLING_UNIT
    ) {
      if (user.scopeId !== pollingUnitId) {
        throw new ForbiddenException('You can only view your assigned polling unit');
      }
    } else if (
      user.role === CampaignRole.STATE_COLLATION_OFFICER ||
      user.scopeType === ScopeType.STATE
    ) {
      if (user.scopeId !== pu.ward.lga.stateId) {
        throw new ForbiddenException('Polling unit is outside your assigned state');
      }
    } else {
      throw new ForbiddenException('Insufficient permissions');
    }

    const pollingUnit = {
      id: pu.id,
      name: pu.name,
      code: pu.code,
      wardId: pu.wardId,
      wardName: pu.ward.name,
      lgaName: pu.ward.lga.name,
    };

    const fallbackParties = await this.browseService.resolvePuDisplayParties(
      user.campaignId,
      pollingUnitId,
    );

    const allContests = !this.contests.explicit();
    const campaignContests = allContests
      ? await this.contests.list(user.campaignId)
      : this.contests.current()
        ? [this.contests.current()!]
        : [];

    if (allContests && campaignContests.length > 1) {
      const results = await this.prisma.collationResult.findMany({
        where: {
          campaignId: user.campaignId,
          contestId: { in: campaignContests.map((contest) => contest.id) },
          level: CollationLevel.POLLING_UNIT,
          scopeId: pollingUnitId,
        },
        include: {
          submittedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
          approvedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      });
      const resultByContestId = new Map(results.map((row) => [row.contestId, row]));
      return {
        pollingUnit,
        contests: campaignContests.map((contest) =>
          this.packPollingUnitResult(
            resultByContestId.get(contest.id) ?? null,
            pollingUnitId,
            fallbackParties,
            toContestBrief(contest),
          ),
        ),
      };
    }

    const result = await this.prisma.collationResult.findFirst({
      where: {
        campaignId: user.campaignId,
        contestId: this.contests.current()?.id,
        level: CollationLevel.POLLING_UNIT,
        scopeId: pollingUnitId,
      },
      include: {
        submittedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        approvedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });

    return {
      ...this.packPollingUnitResult(
        result,
        pollingUnitId,
        fallbackParties,
        this.contests.current() ? toContestBrief(this.contests.current()!) : null,
      ),
      pollingUnit,
    };
  }

  private packPollingUnitResult(
    result: {
      id: string;
      contestId: string;
      status: string;
      registeredVoters: number | null;
      accreditedVoters: number | null;
      ballotPapersIssued: number | null;
      unusedBallotPapers: number | null;
      spoiledBallotPapers: number | null;
      votesCast: number | null;
      invalidVotes: number | null;
      usedBallotPapers: number | null;
      partyResults: Prisma.JsonValue | null;
      ocrVerification?: Prisma.JsonValue | null;
      irevVerification?: Prisma.JsonValue | null;
      irevVerifiedAt: Date | null;
      ocrVerifiedAt: Date | null;
      rejectionReason: string | null;
      submittedAt: Date | null;
      approvedAt: Date | null;
      ec8aPhotoUrls: string[];
      submittedBy: unknown;
      approvedBy: unknown;
      level: string;
    } | null,
    pollingUnitId: string,
    fallbackParties: { parties: Record<string, number>; status?: string | null },
    contest: ContestBrief | null,
  ) {
    const partyResults =
      result?.partyResults != null &&
      Object.values(result.partyResults as Record<string, number>).some((n) => n > 0)
        ? (result.partyResults as Record<string, number>)
        : fallbackParties.parties;

    return {
      ...(result ?? {}),
      id: result?.id,
      contestId: contest?.id ?? result?.contestId ?? null,
      contest,
      status: result?.status ?? fallbackParties.status ?? null,
      registeredVoters: result?.registeredVoters ?? null,
      accreditedVoters: result?.accreditedVoters ?? null,
      ballotPapersIssued: result?.ballotPapersIssued ?? null,
      unusedBallotPapers: result?.unusedBallotPapers ?? null,
      spoiledBallotPapers: result?.spoiledBallotPapers ?? null,
      votesCast: result?.votesCast ?? null,
      invalidVotes: result?.invalidVotes ?? null,
      usedBallotPapers: result?.usedBallotPapers ?? null,
      partyResults,
      ocrVerification: result ? resolveOcrVerification(result) : null,
      irevVerification: result ? resolveIrevVerification(result) : null,
      irevVerifiedAt: result?.irevVerifiedAt ?? null,
      ocrVerifiedAt: result?.ocrVerifiedAt ?? null,
      rejectionReason: result?.rejectionReason ?? null,
      submittedAt: result?.submittedAt ?? null,
      ec8aPhotoUrls: result?.ec8aPhotoUrls ?? [],
      submittedBy: result?.submittedBy ?? null,
      approvedBy: result?.approvedBy ?? null,
      approvedAt: result?.approvedAt ?? null,
      level: result?.level ?? CollationLevel.POLLING_UNIT,
      scopeId: pollingUnitId,
    };
  }

  async listPendingApprovals(user: JwtPayload) {
    this.assertCollationUser(user);
    const level = getCollationLevelForRole(user.role as CampaignRole)!;
    const subordinateLevel = getParentLevel(level);
    if (!subordinateLevel) {
      return [];
    }

    const childScopeIds = await this.getChildScopeIds(
      user.scopeType as ScopeType,
      user.scopeId!,
      subordinateLevel,
    );

    const results = await this.prisma.collationResult.findMany({
      where: {
        campaignId: user.campaignId,
        level: subordinateLevel,
        status: CollationResultStatus.SUBMITTED,
        scopeId: { in: childScopeIds },
      },
      orderBy: { submittedAt: 'asc' },
      include: {
        submittedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        contest: { select: { id: true, type: true, slug: true, label: true, isDefault: true } },
      },
    });

    if (subordinateLevel === CollationLevel.POLLING_UNIT) {
      return this.enrichPuResults(results);
    }
    if (subordinateLevel === CollationLevel.WARD) {
      return this.enrichWardResults(results);
    }
    return this.enrichLgaResults(results);
  }

  async listWardPuSubmissions(
    user: JwtPayload,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      status?: CollationResultStatus | 'NOT_STARTED';
      allContests?: boolean;
    } = {},
  ) {
    this.assertCollationUser(user);
    if (user.scopeType !== ScopeType.WARD || !user.scopeId) {
      throw new ForbiddenException('This endpoint is for ward-scoped officers');
    }

    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(50, Math.max(1, options.limit ?? 10));
    const search = options.search?.trim();
    const statusFilter = options.status;
    const allContests = options.allContests ?? !this.contests.explicit();

    const listedContests = user.campaignId ? await this.contests.list(user.campaignId) : [];
    const activeContest = this.contests.current();
    const contests = allContests
      ? listedContests.length > 0
        ? listedContests
        : activeContest
          ? [activeContest]
          : []
      : activeContest
        ? [activeContest]
        : listedContests.slice(0, 1);
    const contestIds = contests.map((contest) => contest.id);
    const contestById = new Map(contests.map((contest) => [contest.id, toContestBrief(contest)]));
    const grouped = allContests && contests.length > 1;

    const allPus = await this.prisma.pollingUnit.findMany({
      where: {
        wardId: user.scopeId,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: Prisma.QueryMode.insensitive } },
                { code: { contains: search, mode: Prisma.QueryMode.insensitive } },
              ],
            }
          : {}),
      },
      select: { id: true, code: true, name: true, wardId: true },
      orderBy: { code: 'asc' },
    });
    const allPuIds = allPus.map((pu) => pu.id);

    const wardAllPus = search
      ? await this.prisma.pollingUnit.findMany({
          where: { wardId: user.scopeId },
          select: { id: true },
        })
      : allPus;
    const wardPuIds = wardAllPus.map((pu) => pu.id);
    const totalPus = wardPuIds.length;

    const emptyCounts = emptyStatusCounts(totalPus);
    const emptyWardMeta = {
      returnedByLga: false,
      canReturnApprovedPus: false,
      canResubmitToLga: false,
      rejectionReason: null as string | null,
      flaggedPollingUnitIds: [] as string[],
      flaggedPollingUnits: [] as { id: string; code: string; name: string }[],
      byContest: {} as Record<
        string,
        {
          contest: ContestBrief;
          returnedByLga: boolean;
          canReturnApprovedPus: boolean;
          rejectionReason: string | null;
          flaggedPollingUnitIds: string[];
        }
      >,
    };

    if (wardPuIds.length === 0 && allPuIds.length === 0) {
      return {
        grouped,
        contests: contests.map(toContestBrief),
        data: [],
        meta: { page, limit, total: 0, totalPages: 0 },
        statusCounts: emptyCounts,
        contestStatusCounts: Object.fromEntries(
          contests.map((contest) => [contest.slug, emptyCounts]),
        ),
        wardMeta: emptyWardMeta,
      };
    }

    const resultWhere = {
      campaignId: user.campaignId,
      level: CollationLevel.POLLING_UNIT,
      ...(contestIds.length ? { contestId: { in: contestIds } } : {}),
    };

    const [wardResults, listResults, wardRollups] = await Promise.all([
      this.prisma.collationResult.findMany({
        where: { ...resultWhere, scopeId: { in: wardPuIds } },
        select: { scopeId: true, contestId: true, status: true },
      }),
      allPuIds.length === 0
        ? Promise.resolve([])
        : this.prisma.collationResult.findMany({
            where: { ...resultWhere, scopeId: { in: allPuIds } },
            include: {
              submittedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
              approvedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
              contest: { select: { id: true, type: true, slug: true, label: true, isDefault: true } },
            },
          }),
      contestIds.length === 0
        ? Promise.resolve(
            [] as Array<{
              contestId: string;
              status: CollationResultStatus;
              rejectionReason: string | null;
              flaggedPollingUnitIds: string[];
            }>,
          )
        : this.prisma.collationResult.findMany({
            where: {
              campaignId: user.campaignId,
              contestId: { in: contestIds },
              level: CollationLevel.WARD,
              scopeType: ScopeType.WARD,
              scopeId: user.scopeId,
            },
            select: {
              contestId: true,
              status: true,
              rejectionReason: true,
              flaggedPollingUnitIds: true,
            },
          }),
    ]);

    const countByStatus = (rows: { status: string }[], denominator: number) => {
      let submitted = 0;
      let approved = 0;
      let rejected = 0;
      let draft = 0;
      for (const row of rows) {
        if (row.status === 'SUBMITTED') submitted += 1;
        else if (row.status === 'APPROVED') approved += 1;
        else if (row.status === 'REJECTED') rejected += 1;
        else if (row.status === 'DRAFT') draft += 1;
      }
      const notStarted = Math.max(0, denominator - submitted - approved - rejected - draft);
      return { submitted, approved, rejected, draft, notStarted, totalPus: denominator };
    };

    const contestStatusCounts: Record<string, ReturnType<typeof emptyStatusCounts>> = {};
    for (const contest of contests) {
      const rows = wardResults.filter((row) => row.contestId === contest.id);
      contestStatusCounts[contest.slug] = countByStatus(rows, totalPus);
    }

    const resultsByPuContest = new Map<string, (typeof listResults)[number]>();
    for (const row of listResults) {
      resultsByPuContest.set(`${row.scopeId}:${row.contestId}`, row);
    }

    const countRowsForPu = new Map<string, string[]>();
    for (const row of wardResults) {
      const statuses = countRowsForPu.get(row.scopeId) ?? [];
      statuses.push(row.status);
      countRowsForPu.set(row.scopeId, statuses);
    }
    const combinedCountStatuses = wardPuIds.map((puId) => {
      const statuses = countRowsForPu.get(puId) ?? [];
      const padded = [...statuses];
      while (padded.length < contests.length) padded.push('NOT_STARTED');
      return { status: pickMostActionableStatus(padded) };
    });
    const statusCounts = grouped
      ? countByStatus(combinedCountStatuses, totalPus)
      : countByStatus(
          wardResults.filter((row) => !contestIds.length || contestIds.includes(row.contestId)),
          totalPus,
        );

    type RowStatus = CollationResultStatus | 'NOT_STARTED';
    const rows: Array<{
      status: RowStatus;
      pollingUnit: (typeof allPus)[number];
      contestRows: Array<{
        contest: ContestBrief;
        result: (typeof listResults)[number] | null;
        status: RowStatus;
      }>;
    }> = [];

    for (const pu of allPus) {
      const contestRows = contests.map((contest) => {
        const brief = contestById.get(contest.id) ?? toContestBrief(contest);
        const result = resultsByPuContest.get(`${pu.id}:${contest.id}`) ?? null;
        const status: RowStatus = result
          ? (result.status as CollationResultStatus)
          : 'NOT_STARTED';
        return { contest: brief, result, status };
      });
      const status = pickMostActionableStatus(contestRows.map((row) => row.status)) as RowStatus;
      if (statusFilter && !contestRows.some((row) => row.status === statusFilter)) continue;
      rows.push({ status, pollingUnit: pu, contestRows });
    }

    const flaggedIds = [...new Set(wardRollups.flatMap((row) => row.flaggedPollingUnitIds ?? []))];
    const flaggedSet = new Set(flaggedIds);
    const flaggedByContest = new Map(
      wardRollups.map((row) => [row.contestId, new Set(row.flaggedPollingUnitIds ?? [])]),
    );

    rows.sort((a, b) => {
      const aFlagged = flaggedSet.has(a.pollingUnit.id) ? 0 : 1;
      const bFlagged = flaggedSet.has(b.pollingUnit.id) ? 0 : 1;
      if (aFlagged !== bFlagged) return aFlagged - bFlagged;
      const aResult = a.contestRows.find((row) => row.result)?.result ?? null;
      const bResult = b.contestRows.find((row) => row.result)?.result ?? null;
      const verifyDiff =
        verificationSortRank(resolveOcrVerification(aResult ?? {})) -
        verificationSortRank(resolveOcrVerification(bResult ?? {}));
      if (verifyDiff !== 0) return verifyDiff;
      const orderDiff = (PU_STATUS_RANK[a.status] ?? 9) - (PU_STATUS_RANK[b.status] ?? 9);
      if (orderDiff !== 0) return orderDiff;
      return a.pollingUnit.code.localeCompare(b.pollingUnit.code);
    });

    const total = rows.length;
    const pageRows = rows.slice((page - 1) * limit, page * limit);

    const packSheet = (
      pollingUnit: (typeof allPus)[number],
      contest: ContestBrief,
      result: (typeof listResults)[number] | null,
      contestFlagged: boolean,
    ) => {
      if (result) {
        return {
          ...result,
          contestId: contest.id,
          contest,
          ocrVerification: resolveOcrVerification(result),
          irevVerification: resolveIrevVerification(result),
          pollingUnit,
          flaggedByLga: contestFlagged,
        };
      }
      return {
        id: `not-started:${contest.id}:${pollingUnit.id}`,
        campaignId: user.campaignId!,
        contestId: contest.id,
        contest,
        level: CollationLevel.POLLING_UNIT,
        scopeType: ScopeType.POLLING_UNIT,
        scopeId: pollingUnit.id,
        registeredVoters: null,
        accreditedVoters: null,
        ballotPapersIssued: null,
        unusedBallotPapers: null,
        spoiledBallotPapers: null,
        votesCast: null,
        invalidVotes: null,
        usedBallotPapers: null,
        partyResults: null,
        ocrVerification: null,
        irevVerification: null,
        irevVerifiedAt: null,
        ocrVerifiedAt: null,
        ec8aPhotoUrls: [] as string[],
        approvalComment: null,
        status: 'NOT_STARTED' as const,
        submittedById: null,
        submittedAt: null,
        approvedById: null,
        approvedAt: null,
        rejectionReason: null,
        parentResultId: null,
        createdAt: null,
        updatedAt: null,
        submittedBy: null,
        approvedBy: null,
        pollingUnit,
        flaggedByLga: contestFlagged,
      };
    };

    const data = grouped
      ? pageRows.map(({ pollingUnit, contestRows, status }) => ({
          id: `pu:${pollingUnit.id}`,
          pollingUnit,
          status,
          flaggedByLga: flaggedSet.has(pollingUnit.id),
          contests: contestRows.map((row) =>
            packSheet(
              pollingUnit,
              row.contest,
              row.result,
              flaggedByContest.get(row.contest.id)?.has(pollingUnit.id) ?? false,
            ),
          ),
        }))
      : pageRows.map(({ pollingUnit, contestRows }) => {
          const row = contestRows[0];
          return packSheet(
            pollingUnit,
            row?.contest ?? toContestBrief(contests[0]!),
            row?.result ?? null,
            flaggedSet.has(pollingUnit.id),
          );
        });

    const byContest: typeof emptyWardMeta.byContest = {};
    for (const contest of contests) {
      const rollup = wardRollups.find((row) => row.contestId === contest.id);
      const returnedByLga = rollup?.status === CollationResultStatus.REJECTED;
      byContest[contest.slug] = {
        contest: toContestBrief(contest),
        returnedByLga,
        canReturnApprovedPus: returnedByLga,
        rejectionReason: rollup?.rejectionReason ?? null,
        flaggedPollingUnitIds: rollup?.flaggedPollingUnitIds ?? [],
      };
    }

    const returnedByLga = wardRollups.some((row) => row.status === CollationResultStatus.REJECTED);
    const primaryRollup =
      wardRollups.find((row) => row.contestId === activeContest?.id) ?? wardRollups[0];

    const flaggedPollingUnits =
      flaggedIds.length > 0
        ? await this.prisma.pollingUnit.findMany({
            where: { id: { in: flaggedIds }, wardId: user.scopeId },
            select: { id: true, code: true, name: true },
            orderBy: { code: 'asc' },
          })
        : [];

    return {
      grouped,
      contests: contests.map(toContestBrief),
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      },
      statusCounts,
      contestStatusCounts,
      wardMeta: {
        returnedByLga,
        canReturnApprovedPus: returnedByLga,
        canResubmitToLga: false,
        rejectionReason: primaryRollup?.rejectionReason ?? null,
        flaggedPollingUnitIds: flaggedIds,
        flaggedPollingUnits,
        byContest,
      },
    };
  }


  async listLgaWardSubmissions(user: JwtPayload) {
    this.assertCollationUser(user);
    if (user.scopeType !== ScopeType.LGA || !user.scopeId) {
      throw new ForbiddenException('This endpoint is for LGA-scoped collation officers');
    }

    const wards = await this.prisma.ward.findMany({
      where: { lgaId: user.scopeId },
      select: { id: true, name: true, registrationAreaCode: true, lgaId: true },
      orderBy: { name: 'asc' },
    });
    const wardIds = wards.map((w) => w.id);

    if (wardIds.length === 0) {
      return { totalWards: 0, data: [] };
    }

    const results = await this.prisma.collationResult.findMany({
      where: {
        campaignId: user.campaignId,
        level: CollationLevel.WARD,
        scopeId: { in: wardIds },
      },
      orderBy: { submittedAt: 'desc' },
      include: {
        submittedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        approvedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });

    const resultByWard = new Map(results.map((r) => [r.scopeId, r]));
    const readinessByWard = await this.readinessService.getWardPuReadinessMap(user.campaignId!, wardIds);

    const emptyReadiness = {
      totalPus: 0,
      approvedPus: 0,
      submittedPus: 0,
      rejectedPus: 0,
      missingPus: 0,
      readyForLgaApproval: false,
      ...emptyPuVerificationCounts(),
    };

    const data = wards.map((ward) => {
      const result = resultByWard.get(ward.id);
      const puReadiness = readinessByWard.get(ward.id) ?? { ...emptyReadiness };
      if (!result) {
        return {
          id: `not-started:${ward.id}`,
          campaignId: user.campaignId!,
          contestId: this.contests.id(),
          level: CollationLevel.WARD,
          scopeType: ScopeType.WARD,
          scopeId: ward.id,
          registeredVoters: null,
          accreditedVoters: null,
          ballotPapersIssued: null,
          unusedBallotPapers: null,
          spoiledBallotPapers: null,
          votesCast: null,
          invalidVotes: null,
          usedBallotPapers: null,
          partyResults: null,
          ec8aPhotoUrls: [] as string[],
          approvalComment: null,
          status: 'NOT_STARTED' as const,
          submittedById: null,
          submittedAt: null,
          approvedById: null,
          approvedAt: null,
          rejectionReason: null,
          parentResultId: null,
          createdAt: null,
          updatedAt: null,
          submittedBy: null,
          approvedBy: null,
          ward,
          puReadiness,
        };
      }

      return {
        ...result,
        ward,
        puReadiness,
      };
    });

    const statusOrder: Record<string, number> = {
      SUBMITTED: 0,
      REJECTED: 1,
      DRAFT: 2,
      NOT_STARTED: 3,
      APPROVED: 4,
    };
    data.sort((a, b) => {
      const orderDiff = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
      if (orderDiff !== 0) return orderDiff;
      const flaggedDiff = (b.puReadiness?.verifyFlagged ?? 0) - (a.puReadiness?.verifyFlagged ?? 0);
      if (flaggedDiff !== 0) return flaggedDiff;
      return (a.ward?.name ?? '').localeCompare(b.ward?.name ?? '');
    });

    return {
      totalWards: wardIds.length,
      data,
    };
  }

  async listLgaWardPuResults(user: JwtPayload, wardId: string) {
    this.assertCollationUser(user);
    if (user.scopeType !== ScopeType.LGA || !user.scopeId) {
      throw new ForbiddenException('This endpoint is for LGA-scoped collation officers');
    }

    const ward = await this.prisma.ward.findFirst({
      where: { id: wardId, lgaId: user.scopeId },
      select: { id: true },
    });
    if (!ward) {
      throw new ForbiddenException('This ward is outside your LGA');
    }

    const puIds = await this.getChildScopeIds(
      ScopeType.WARD,
      wardId,
      CollationLevel.POLLING_UNIT,
    );

    return this.enrichPuResults(
      await this.prisma.collationResult.findMany({
        where: {
          campaignId: user.campaignId,
          level: CollationLevel.POLLING_UNIT,
          scopeId: { in: puIds },
          status: {
            in: [
              CollationResultStatus.SUBMITTED,
              CollationResultStatus.APPROVED,
              CollationResultStatus.REJECTED,
            ],
          },
        },
        orderBy: { submittedAt: 'desc' },
        include: {
          submittedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
          approvedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      }),
    );
  }

  async getLgaPuResult(user: JwtPayload, puId: string) {
    this.assertCollationUser(user);
    if (user.scopeType !== ScopeType.LGA || !user.scopeId) {
      throw new ForbiddenException('This endpoint is for LGA-scoped collation officers');
    }

    const unit = await this.prisma.pollingUnit.findFirst({
      where: { id: puId, ward: { lgaId: user.scopeId } },
      select: { id: true, code: true, name: true, wardId: true },
    });
    if (!unit) {
      throw new ForbiddenException('This polling unit is outside your LGA');
    }

    const result = await this.prisma.collationResult.findFirst({
      where: {
        campaignId: user.campaignId,
        level: CollationLevel.POLLING_UNIT,
        scopeId: puId,
      },
      include: {
        submittedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        approvedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });

    if (result) {
      const enriched = await this.enrichPuResults([result]);
      return enriched[0] ?? null;
    }

    const fallback = await this.browseService.resolvePuDisplayParties(user.campaignId!, puId);

    return {
      id: undefined,
      status: fallback.status,
      partyResults: fallback.parties,
      scopeId: puId,
      level: CollationLevel.POLLING_UNIT,
      registeredVoters: null,
      accreditedVoters: null,
      ballotPapersIssued: null,
      unusedBallotPapers: null,
      spoiledBallotPapers: null,
      votesCast: null,
      invalidVotes: null,
      usedBallotPapers: null,
      ec8aPhotoUrls: [],
      submittedBy: null,
      approvedBy: null,
      submittedAt: null,
      approvedAt: null,
      rejectionReason: null,
      ocrVerification: null,
      pollingUnit: unit,
    };
  }

  async approveAllLgaWardResults(_user: JwtPayload, _dto: ApproveCollationResultDto = {}) {
    throw new ForbiddenException(
      'LGA officers no longer approve ward results. Ward approval publishes figures to the Situation Room immediately. Use a comment or request correction instead.',
    );
  }

  async listStateLgaSubmissions(user: JwtPayload) {
    this.assertCollationUser(user);
    if (user.scopeType !== ScopeType.STATE || !user.scopeId) {
      throw new ForbiddenException('This endpoint is for state-scoped collation officers');
    }

    const lgas = await this.prisma.lGA.findMany({
      where: { stateId: user.scopeId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    const lgaIds = lgas.map((l) => l.id);

    if (lgaIds.length === 0) {
      return { totalLgas: 0, data: [] };
    }

    const results = await this.prisma.collationResult.findMany({
      where: {
        campaignId: user.campaignId,
        level: CollationLevel.LGA,
        scopeId: { in: lgaIds },
      },
      orderBy: { submittedAt: 'desc' },
      include: {
        submittedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        approvedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });

    const resultByLga = new Map(results.map((r) => [r.scopeId, r]));
    const readinessByLga = await this.readinessService.getLgaWardReadinessMap(user.campaignId!, lgaIds);

    const emptyReadiness = {
      totalWards: 0,
      approvedWards: 0,
      submittedWards: 0,
      rejectedWards: 0,
      missingWards: 0,
      readyForStateApproval: false,
    };

    const data = lgas.map((lga) => {
      const result = resultByLga.get(lga.id);
      const wardReadiness = readinessByLga.get(lga.id) ?? { ...emptyReadiness };
      if (!result) {
        return {
          id: `not-started:${lga.id}`,
          campaignId: user.campaignId!,
          contestId: this.contests.id(),
          level: CollationLevel.LGA,
          scopeType: ScopeType.LGA,
          scopeId: lga.id,
          registeredVoters: null,
          accreditedVoters: null,
          ballotPapersIssued: null,
          unusedBallotPapers: null,
          spoiledBallotPapers: null,
          votesCast: null,
          invalidVotes: null,
          usedBallotPapers: null,
          partyResults: null,
          ec8aPhotoUrls: [] as string[],
          approvalComment: null,
          status: 'NOT_STARTED' as const,
          submittedById: null,
          submittedAt: null,
          approvedById: null,
          approvedAt: null,
          rejectionReason: null,
          flaggedWardIds: [] as string[],
          parentResultId: null,
          createdAt: null,
          updatedAt: null,
          submittedBy: null,
          approvedBy: null,
          lga,
          wardReadiness,
        };
      }
      return { ...result, lga, wardReadiness };
    });

    const statusOrder: Record<string, number> = {
      SUBMITTED: 0,
      REJECTED: 1,
      DRAFT: 2,
      NOT_STARTED: 3,
      APPROVED: 4,
    };
    data.sort((a, b) => {
      const orderDiff = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
      if (orderDiff !== 0) return orderDiff;
      return (a.lga?.name ?? '').localeCompare(b.lga?.name ?? '');
    });

    return { totalLgas: lgaIds.length, data };
  }

  async listStateLgaWardResults(user: JwtPayload, lgaId: string) {
    this.assertCollationUser(user);
    if (user.scopeType !== ScopeType.STATE || !user.scopeId) {
      throw new ForbiddenException('This endpoint is for state-scoped collation officers');
    }

    const lga = await this.prisma.lGA.findFirst({
      where: { id: lgaId, stateId: user.scopeId },
      select: { id: true },
    });
    if (!lga) {
      throw new ForbiddenException('This LGA is outside your state');
    }

    const wardIds = await this.getChildScopeIds(ScopeType.LGA, lgaId, CollationLevel.WARD);
    return this.enrichWardResults(
      await this.prisma.collationResult.findMany({
        where: {
          campaignId: user.campaignId,
          level: CollationLevel.WARD,
          scopeId: { in: wardIds },
          status: {
            in: [
              CollationResultStatus.SUBMITTED,
              CollationResultStatus.APPROVED,
              CollationResultStatus.REJECTED,
            ],
          },
        },
        orderBy: { submittedAt: 'desc' },
        include: {
          submittedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
          approvedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      }),
    );
  }

  async approveAllStateLgaResults(_user: JwtPayload, _dto: ApproveCollationResultDto = {}) {
    throw new ForbiddenException(
      'State officers no longer final-approve LGA results. Ward approval publishes figures to the Situation Room immediately. Use a comment or request correction instead.',
    );
  }

  async resubmitLgaToState(user: JwtPayload) {
    this.assertCollationUser(user);
    if (user.scopeType !== ScopeType.LGA || !user.scopeId) {
      throw new ForbiddenException('Only LGA officers can resubmit an LGA rollup to state');
    }

    const lgaResult = await this.prisma.collationResult.findUnique({
      where: {
        campaignId_contestId_level_scopeType_scopeId: {
          campaignId: user.campaignId!,
          contestId: this.contests.id(),
          level: CollationLevel.LGA,
          scopeType: ScopeType.LGA,
          scopeId: user.scopeId,
        },
      },
    });

    if (!lgaResult) {
      throw new BadRequestException('No LGA rollup exists yet. Approve ward results first.');
    }
    if (lgaResult.status !== CollationResultStatus.REJECTED) {
      throw new BadRequestException('LGA rollup can only be re-submitted after state has returned it');
    }

    await this.publishAncestryRollups(
      user.campaignId!,
      {
        level: CollationLevel.LGA,
        scopeType: ScopeType.LGA,
        scopeId: user.scopeId,
      },
      user.sub,
      { clearRejection: true, contestId: lgaResult.contestId },
    );

    const updated = await this.prisma.collationResult.findUnique({
      where: {
        campaignId_contestId_level_scopeType_scopeId: {
          campaignId: user.campaignId!,
          contestId: this.contests.id(),
          level: CollationLevel.LGA,
          scopeType: ScopeType.LGA,
          scopeId: user.scopeId,
        },
      },
    });

    if (updated) {
      const log = await this.writeActionLog({
        campaignId: updated.campaignId,
        collationResultId: updated.id,
        action: 'APPROVED',
        actorId: user.sub,
        fromStatus: CollationResultStatus.REJECTED,
        toStatus: updated.status as CollationResultStatus,
        comment: 'Republished LGA totals after correction',
        metadata: { level: updated.level, scopeType: updated.scopeType, scopeId: updated.scopeId },
      });
      this.emitNotification({
        type: NotificationType.RESULT_SUBMITTED,
        campaignId: updated.campaignId,
        actorUserId: user.sub,
        entityType: 'COLLATION_RESULT',
        entityId: updated.id,
        sourceEventId: log.id,
        sendPush: false,
        collationResult: {
          level: updated.level,
          scopeType: updated.scopeType,
          scopeId: updated.scopeId,
          submittedById: updated.submittedById,
        },
      });
    }

    return updated;
  }

  async reopenCollationResult(user: JwtPayload, id: string, reason: string) {
    if (isCampaignAdminRole(user.role)) {
      if (!user.campaignId) throw new ForbiddenException('No active campaign membership');
      return this.rejectResult(user, id, { reason });
    }
    return this.rejectResult(user, id, { reason });
  }

  private async enrichWardResults<
    T extends { scopeId: string; level: string },
  >(results: T[]) {
    if (results.length === 0) return [];

    const wardIds = results
      .filter((r) => r.level === CollationLevel.WARD)
      .map((r) => r.scopeId);

    const wards = wardIds.length
      ? await this.prisma.ward.findMany({
          where: { id: { in: wardIds } },
          select: { id: true, name: true, registrationAreaCode: true, lgaId: true },
        })
      : [];

    const wardMap = new Map(wards.map((w) => [w.id, w]));

    return results.map((result) => ({
      ...result,
      ward: wardMap.get(result.scopeId) ?? null,
    }));
  }

  private async enrichLgaResults<
    T extends { scopeId: string; level: string },
  >(results: T[]) {
    if (results.length === 0) return [];

    const lgaIds = results
      .filter((r) => r.level === CollationLevel.LGA)
      .map((r) => r.scopeId);

    const lgas = lgaIds.length
      ? await this.prisma.lGA.findMany({
          where: { id: { in: lgaIds } },
          select: { id: true, name: true, state: { select: { name: true, code: true } } },
        })
      : [];

    const lgaMap = new Map(lgas.map((l) => [l.id, l]));

    return results.map((result) => {
      const lga = lgaMap.get(result.scopeId);
      return {
        ...result,
        lga: lga ? { id: lga.id, name: lga.name } : null,
        stateName: lga?.state.name ?? null,
        stateCode: lga?.state.code ?? null,
      };
    });
  }

  private async enrichPuResults<
    T extends { scopeId: string; level: string },
  >(results: T[]) {
    if (results.length === 0) return [];

    const puIds = results
      .filter((r) => r.level === CollationLevel.POLLING_UNIT)
      .map((r) => r.scopeId);

    const units = puIds.length
      ? await this.prisma.pollingUnit.findMany({
          where: { id: { in: puIds } },
          select: { id: true, code: true, name: true, wardId: true },
        })
      : [];

    const unitMap = new Map(units.map((u) => [u.id, u]));

    return results.map((result) => ({
      ...result,
      ocrVerification: resolveOcrVerification(result as CollationFigures),
      irevVerification: resolveIrevVerification(result as { irevVerification?: unknown }),
      pollingUnit: unitMap.get(result.scopeId) ?? null,
    }));
  }

  async upsertResult(user: JwtPayload, dto: CreateCollationResultDto) {
    this.assertCollationUser(user);
    const level = getCollationLevelForRole(user.role as CampaignRole)!;

    if (level === CollationLevel.WARD) {
      throw new ForbiddenException(
        'Ward officers review and approve PU results. Ward totals are rolled up automatically.',
      );
    }

    const existing = await this.prisma.collationResult.findUnique({
      where: {
        campaignId_contestId_level_scopeType_scopeId: {
          campaignId: user.campaignId!,
          contestId: this.contests.id(),
          level,
          scopeType: user.scopeType as ScopeType,
          scopeId: user.scopeId!,
        },
      },
    });

    if (existing && !EDITABLE_STATUSES.has(existing.status as CollationResultStatus)) {
      throw new BadRequestException(
        'This result has already been submitted. Wait for approval or a return for correction.',
      );
    }

    const ec8aPhotoUrls =
      dto.ec8aPhotoUrls !== undefined
        ? dto.ec8aPhotoUrls
        : existing?.ec8aPhotoUrls ?? [];

    const figures = {
      registeredVoters: dto.registeredVoters,
      accreditedVoters: dto.accreditedVoters,
      ballotPapersIssued: dto.ballotPapersIssued,
      unusedBallotPapers: dto.unusedBallotPapers,
      spoiledBallotPapers: dto.spoiledBallotPapers,
      votesCast: dto.votesCast,
      invalidVotes: dto.invalidVotes,
      usedBallotPapers: dto.usedBallotPapers,
      partyResults: dto.partyResults,
      ec8aPhotoUrls,
    };
    const verification =
      level === CollationLevel.POLLING_UNIT ? ocrVerificationWrite(figures) : {};

    const result = await this.prisma.collationResult.upsert({
      where: {
        campaignId_contestId_level_scopeType_scopeId: {
          campaignId: user.campaignId!,
          contestId: this.contests.id(),
          level,
          scopeType: user.scopeType as ScopeType,
          scopeId: user.scopeId!,
        },
      },
      create: {
        campaignId: user.campaignId!,
        contestId: this.contests.id(),
        level,
        scopeType: user.scopeType as ScopeType,
        scopeId: user.scopeId!,
        ...figures,
        ...verification,
        status: CollationResultStatus.DRAFT,
      },
      update: {
        ...figures,
        ...verification,
        status: CollationResultStatus.DRAFT,
        rejectionReason: null,
      },
    });

    return result;
  }

  async attachEc8aPhoto(user: JwtPayload, id: string, photoUrl: string) {
    this.assertCollationUser(user);
    const result = await this.getOwnedResult(user, id);

    if (!EDITABLE_STATUSES.has(result.status as CollationResultStatus)) {
      throw new BadRequestException(
        'EC8A can only be uploaded while the result is a draft or returned for correction',
      );
    }

    const ec8aPhotoUrls = [...(result.ec8aPhotoUrls ?? []), photoUrl];
    const verification =
      result.level === CollationLevel.POLLING_UNIT
        ? ocrVerificationWrite({ ...result, ec8aPhotoUrls })
        : {};

    return this.prisma.collationResult.update({
      where: { id },
      data: { ec8aPhotoUrls, ...verification },
    });
  }

  async scanEc8aPhoto(user: JwtPayload, photoUrl: string): Promise<VisionExtract> {
    this.assertCollationUser(user);

    const campaign = await this.prisma.campaign.findUnique({
      where: { id: user.campaignId },
      select: { trackedParties: true },
    });
    const partyCodes = getPartyCodes(normalizeTrackedParties(campaign?.trackedParties));
    return this.photoReader.extractEc8a([photoUrl], partyCodes);
  }

  async submitResult(user: JwtPayload, id: string) {
    this.assertCollationUser(user);
    const level = getCollationLevelForRole(user.role as CampaignRole)!;

    if (level === CollationLevel.WARD) {
      throw new ForbiddenException(
        'Ward results are forwarded to the LGA automatically when PU results are approved.',
      );
    }

    const result = await this.getOwnedResult(user, id);

    if (result.status === CollationResultStatus.APPROVED) {
      throw new BadRequestException('Result is already approved');
    }

    if (result.status === CollationResultStatus.SUBMITTED) {
      throw new BadRequestException('Result is already submitted and awaiting approval');
    }

    if (!EDITABLE_STATUSES.has(result.status as CollationResultStatus)) {
      throw new BadRequestException('Only draft or returned results can be submitted');
    }

    if (
      result.level === CollationLevel.POLLING_UNIT &&
      (!result.ec8aPhotoUrls || result.ec8aPhotoUrls.length === 0)
    ) {
      throw new BadRequestException(
        'EC8A form must be uploaded before submission. Save figures as draft until the form is attached.',
      );
    }

    const fromStatus = result.status as CollationResultStatus;
    const verification =
      result.level === CollationLevel.POLLING_UNIT
        ? ocrVerificationWrite(result, { awaitingOcr: true })
        : {};

    const submitted = await this.prisma.collationResult.update({
      where: { id },
      data: {
        status: CollationResultStatus.SUBMITTED,
        submittedById: user.sub,
        submittedAt: new Date(),
        rejectionReason: null,
        ...verification,
      },
    });

    const log = await this.writeActionLog({
      campaignId: submitted.campaignId,
      collationResultId: submitted.id,
      action: 'SUBMITTED',
      actorId: user.sub,
      fromStatus,
      toStatus: CollationResultStatus.SUBMITTED,
      metadata: {
        level: submitted.level,
        scopeType: submitted.scopeType,
        scopeId: submitted.scopeId,
      },
    });

    if (submitted.level === CollationLevel.POLLING_UNIT) {
      void this.ocrQueue.publish({ collationResultId: submitted.id });
      this.eventEmitter.emit(IREV_FETCH_EVENT, {
        collationResultId: submitted.id,
        pollingUnitId: submitted.scopeId,
        campaignId: submitted.campaignId,
      });
      this.emitNotification({
        type: NotificationType.RESULT_SUBMITTED,
        campaignId: submitted.campaignId,
        actorUserId: user.sub,
        entityType: 'COLLATION_RESULT',
        entityId: submitted.id,
        sourceEventId: log.id,
        sendPush: true,
        collationResult: {
          level: submitted.level,
          scopeType: submitted.scopeType,
          scopeId: submitted.scopeId,
          submittedById: submitted.submittedById,
        },
      });
      await this.ingestResultPulse(user, submitted);
    }

    await this.browseService.invalidateNationalSituationCaches(submitted.campaignId);
    return submitted;
  }

  async approveResult(user: JwtPayload, id: string, dto: ApproveCollationResultDto = {}) {
    this.assertCollationUser(user);
    const level = getCollationLevelForRole(user.role as CampaignRole)!;
    if (level !== CollationLevel.WARD) {
      throw new ForbiddenException(
        'Only ward officers can approve results. LGA and State officers may comment or request correction.',
      );
    }

    const result = await this.prisma.collationResult.findUniqueOrThrow({ where: { id } });
    if (result.status !== CollationResultStatus.SUBMITTED) {
      throw new BadRequestException('Only submitted results can be approved');
    }
    if (result.level !== CollationLevel.POLLING_UNIT) {
      throw new ForbiddenException('Ward officers can only approve polling unit results');
    }

    await this.verifyApproverScope(user, result);

    const approved = await this.prisma.collationResult.update({
      where: { id },
      data: {
        status: CollationResultStatus.APPROVED,
        approvedById: user.sub,
        approvedAt: new Date(),
        approvalComment: dto.comment ?? null,
        rejectionReason: null,
        flaggedPollingUnitIds: [],
      },
    });

    const log = await this.writeActionLog({
      campaignId: approved.campaignId,
      collationResultId: approved.id,
      action: 'APPROVED',
      actorId: user.sub,
      fromStatus: CollationResultStatus.SUBMITTED,
      toStatus: CollationResultStatus.APPROVED,
      comment: dto.comment ?? null,
      metadata: {
        level: approved.level,
        scopeType: approved.scopeType,
        scopeId: approved.scopeId,
      },
    });

    this.emitNotification({
      type: NotificationType.RESULT_APPROVED,
      campaignId: approved.campaignId,
      actorUserId: user.sub,
      entityType: 'COLLATION_RESULT',
      entityId: approved.id,
      sourceEventId: log.id,
      sendPush: true,
      collationResult: {
        level: approved.level,
        scopeType: approved.scopeType,
        scopeId: approved.scopeId,
        submittedById: approved.submittedById,
      },
    });

    await this.publishAncestryRollups(
      approved.campaignId,
      {
        level: CollationLevel.POLLING_UNIT,
        scopeType: approved.scopeType as ScopeType,
        scopeId: approved.scopeId,
      },
      user.sub,
      { clearRejection: true, contestId: approved.contestId },
    );

    await this.browseService.invalidateNationalSituationCaches(approved.campaignId);
    return approved;
  }

  async rejectResult(user: JwtPayload, id: string, dto: RejectCollationResultDto) {
    const result = await this.prisma.collationResult.findUniqueOrThrow({ where: { id } });
    if (result.campaignId !== user.campaignId) {
      throw new ForbiddenException('Result is outside your campaign');
    }

    const fromStatus = result.status as CollationResultStatus;
    const userLevel = getCollationLevelForRole(user.role as CampaignRole);
    const isAdmin = isCampaignAdminRole(user.role);
    if (!isAdmin) {
      this.assertCollationUser(user);
    }

    const returnable = new Set<CollationResultStatus>([
      CollationResultStatus.SUBMITTED,
      CollationResultStatus.APPROVED,
    ]);
    if (!returnable.has(fromStatus)) {
      throw new BadRequestException('Only submitted or published results can be returned for correction');
    }

    const isWardReturningPu =
      userLevel === CollationLevel.WARD && result.level === CollationLevel.POLLING_UNIT;
    const isLgaReturningWard =
      userLevel === CollationLevel.LGA && result.level === CollationLevel.WARD;
    const isLgaReturningPu =
      userLevel === CollationLevel.LGA && result.level === CollationLevel.POLLING_UNIT;
    const isStateReturningLga =
      userLevel === CollationLevel.STATE && result.level === CollationLevel.LGA;
    const isNationalReturningState =
      userLevel === CollationLevel.NATIONAL && result.level === CollationLevel.STATE;

    if (isWardReturningPu && fromStatus === CollationResultStatus.APPROVED) {
      const wardReturned = await this.isWardReturnedByLga(
        result.campaignId,
        result.scopeId,
        result.contestId,
      );
      if (!wardReturned) {
        throw new BadRequestException(
          'Approved PUs can only be returned after LGA has requested correction on this ward',
        );
      }
    }

    if (
      !isWardReturningPu &&
      !isLgaReturningWard &&
      !isLgaReturningPu &&
      !isStateReturningLga &&
      !isNationalReturningState &&
      !isAdmin
    ) {
      throw new ForbiddenException('You cannot request correction on this result');
    }

    if (isAdmin) {
      if (result.campaignId !== user.campaignId) {
        throw new ForbiddenException('Result is outside your campaign');
      }
    } else {
      await this.verifyReviewerScope(user, result);
    }

    let flaggedPollingUnitIds: string[] = [];
    let flaggedWardIds: string[] = [];
    if ((isLgaReturningWard || (isAdmin && result.level === CollationLevel.WARD)) && dto.affectedPollingUnitIds?.length) {
      flaggedPollingUnitIds = await this.validatePuIdsInWard(result.scopeId, dto.affectedPollingUnitIds);
    }
    if ((isStateReturningLga || (isAdmin && result.level === CollationLevel.LGA)) && dto.affectedWardIds?.length) {
      flaggedWardIds = await this.validateWardIdsInLga(result.scopeId, dto.affectedWardIds);
    }

    const rejected = await this.prisma.collationResult.update({
      where: { id },
      data: {
        status: CollationResultStatus.REJECTED,
        rejectionReason: dto.reason,
        approvedById: user.sub,
        approvedAt: new Date(),
        approvalComment: null,
        ...(flaggedPollingUnitIds.length ? { flaggedPollingUnitIds } : {}),
        ...(flaggedWardIds.length ? { flaggedWardIds } : {}),
      },
    });

    const log = await this.writeActionLog({
      campaignId: rejected.campaignId,
      collationResultId: rejected.id,
      action: 'REJECTED',
      actorId: user.sub,
      fromStatus,
      toStatus: CollationResultStatus.REJECTED,
      comment: dto.reason,
      metadata: {
        level: rejected.level,
        scopeType: rejected.scopeType,
        scopeId: rejected.scopeId,
        affectedPollingUnitIds: flaggedPollingUnitIds,
        affectedWardIds: flaggedWardIds,
      },
    });

    if (rejected.level === CollationLevel.POLLING_UNIT) {
      this.emitNotification({
        type: NotificationType.RESULT_RETURNED,
        campaignId: rejected.campaignId,
        actorUserId: user.sub,
        entityType: 'COLLATION_RESULT',
        entityId: rejected.id,
        sourceEventId: log.id,
        sendPush: true,
        collationResult: {
          level: rejected.level,
          scopeType: rejected.scopeType,
          scopeId: rejected.scopeId,
          submittedById: rejected.submittedById,
        },
      });
    } else if (rejected.level === CollationLevel.WARD) {
      this.emitNotification({
        type: NotificationType.WARD_RETURNED_BY_LGA,
        campaignId: rejected.campaignId,
        actorUserId: user.sub,
        entityType: 'COLLATION_RESULT',
        entityId: rejected.id,
        sourceEventId: log.id,
        sendPush: true,
        collationResult: {
          level: rejected.level,
          scopeType: rejected.scopeType,
          scopeId: rejected.scopeId,
          submittedById: rejected.submittedById,
        },
      });
    } else {
      this.emitNotification({
        type: NotificationType.RESULT_RETURNED,
        campaignId: rejected.campaignId,
        actorUserId: user.sub,
        entityType: 'COLLATION_RESULT',
        entityId: rejected.id,
        sourceEventId: log.id,
        sendPush: true,
        collationResult: {
          level: rejected.level,
          scopeType: rejected.scopeType,
          scopeId: rejected.scopeId,
          submittedById: rejected.submittedById,
        },
      });
    }

    if (flaggedPollingUnitIds.length) {
      await this.autoReturnChildResults(
        rejected.campaignId,
        CollationLevel.POLLING_UNIT,
        flaggedPollingUnitIds,
        user.sub,
        dto.reason,
        rejected.contestId,
      );
    }
    if (flaggedWardIds.length) {
      await this.autoReturnChildResults(
        rejected.campaignId,
        CollationLevel.WARD,
        flaggedWardIds,
        user.sub,
        dto.reason,
        rejected.contestId,
      );
    }

    await this.publishAncestryRollups(
      rejected.campaignId,
      {
        level: rejected.level as CollationLevel,
        scopeType: rejected.scopeType as ScopeType,
        scopeId: rejected.scopeId,
      },
      user.sub,
      { keepRejected: rejected.level !== CollationLevel.POLLING_UNIT, contestId: rejected.contestId },
    );

    await this.browseService.invalidateNationalSituationCaches(rejected.campaignId);
    return rejected;
  }

  async commentResult(user: JwtPayload, id: string, comment: string) {
    const trimmed = comment.trim();
    if (trimmed.length < 3) {
      throw new BadRequestException('Comment must be at least 3 characters');
    }

    const result = await this.prisma.collationResult.findUniqueOrThrow({ where: { id } });
    if (result.campaignId !== user.campaignId) {
      throw new ForbiddenException('Result is outside your campaign');
    }

    if (!isCampaignAdminRole(user.role)) {
      this.assertCollationUser(user);
      const level = getCollationLevelForRole(user.role as CampaignRole);
      if (
        level !== CollationLevel.LGA &&
        level !== CollationLevel.STATE &&
        level !== CollationLevel.NATIONAL
      ) {
        throw new ForbiddenException('Only LGA, State, or National reviewers can comment');
      }
      await this.verifyReviewerScope(user, result);
    }

    const log = await this.writeActionLog({
      campaignId: result.campaignId,
      collationResultId: result.id,
      action: 'COMMENTED',
      actorId: user.sub,
      fromStatus: result.status as CollationResultStatus,
      toStatus: result.status as CollationResultStatus,
      comment: trimmed,
      metadata: {
        level: result.level,
        scopeType: result.scopeType,
        scopeId: result.scopeId,
      },
    });

    this.emitNotification({
      type: NotificationType.RESULT_COMMENTED,
      campaignId: result.campaignId,
      actorUserId: user.sub,
      entityType: 'COLLATION_RESULT',
      entityId: result.id,
      sourceEventId: log.id,
      sendPush: true,
      collationResult: {
        level: result.level,
        scopeType: result.scopeType,
        scopeId: result.scopeId,
        submittedById: result.submittedById,
      },
    });

    return {
      id: log.id,
      action: log.action,
      comment: log.comment,
      createdAt: log.createdAt,
      resultId: result.id,
    };
  }

  /**
   * After LGA returns a ward: re-forward ward totals once every PU is APPROVED again
   * (or still approved), without requiring a manual PU re-approve cycle.
   */
  async resubmitWardToLga(user: JwtPayload) {
    this.assertCollationUser(user);
    if (user.scopeType !== ScopeType.WARD || !user.scopeId) {
      throw new ForbiddenException('Only ward officers can resubmit a ward rollup to LGA');
    }

    const level = getCollationLevelForRole(user.role as CampaignRole);
    if (level !== CollationLevel.WARD) {
      throw new ForbiddenException('Only ward officers can resubmit a ward rollup to LGA');
    }

    const wardResult = await this.prisma.collationResult.findUnique({
      where: {
        campaignId_contestId_level_scopeType_scopeId: {
          campaignId: user.campaignId!,
          contestId: this.contests.id(),
          level: CollationLevel.WARD,
          scopeType: ScopeType.WARD,
          scopeId: user.scopeId,
        },
      },
    });

    if (!wardResult) {
      throw new BadRequestException('No ward rollup exists yet. Approve PU results first.');
    }
    if (wardResult.status !== CollationResultStatus.REJECTED) {
      throw new BadRequestException('Ward rollup can only be re-submitted after LGA has returned it');
    }

    await this.publishAncestryRollups(
      user.campaignId!,
      {
        level: CollationLevel.WARD,
        scopeType: ScopeType.WARD,
        scopeId: user.scopeId,
      },
      user.sub,
      { clearRejection: true, contestId: wardResult.contestId },
    );

    const updated = await this.prisma.collationResult.findUnique({
      where: {
        campaignId_contestId_level_scopeType_scopeId: {
          campaignId: user.campaignId!,
          contestId: this.contests.id(),
          level: CollationLevel.WARD,
          scopeType: ScopeType.WARD,
          scopeId: user.scopeId,
        },
      },
    });

    if (updated) {
      const log = await this.writeActionLog({
        campaignId: updated.campaignId,
        collationResultId: updated.id,
        action: 'APPROVED',
        actorId: user.sub,
        fromStatus: CollationResultStatus.REJECTED,
        toStatus: updated.status as CollationResultStatus,
        comment: 'Republished ward totals after correction',
        metadata: { level: updated.level, scopeType: updated.scopeType, scopeId: updated.scopeId },
      });
      this.emitNotification({
        type: NotificationType.WARD_FORWARDED_TO_LGA,
        campaignId: updated.campaignId,
        actorUserId: user.sub,
        entityType: 'COLLATION_RESULT',
        entityId: updated.id,
        sourceEventId: log.id,
        sendPush: false,
        collationResult: {
          level: updated.level,
          scopeType: updated.scopeType,
          scopeId: updated.scopeId,
          submittedById: updated.submittedById,
        },
      });
    }

    return updated;

    return updated;
  }

  /**
   * Return every LGA-flagged PU to the agent (after LGA returned the ward).
   * Only PUs still APPROVED (or SUBMITTED) are returned.
   */
  async returnLgaFlaggedPus(user: JwtPayload, dto: RejectCollationResultDto) {
    this.assertCollationUser(user);
    if (user.scopeType !== ScopeType.WARD || !user.scopeId) {
      throw new ForbiddenException('Only ward officers can return LGA-flagged PUs');
    }

    const listed = user.campaignId ? await this.contests.list(user.campaignId) : [];
    const contests =
      this.contests.explicit() && this.contests.current()
        ? [this.contests.current()!]
        : listed.length > 0
          ? listed
          : this.contests.current()
            ? [this.contests.current()!]
            : [];

    const wardResults = contests.length
      ? await this.prisma.collationResult.findMany({
          where: {
            campaignId: user.campaignId,
            contestId: { in: contests.map((contest) => contest.id) },
            level: CollationLevel.WARD,
            scopeType: ScopeType.WARD,
            scopeId: user.scopeId,
            status: CollationResultStatus.REJECTED,
          },
        })
      : [];

    const returnedWard = wardResults.filter((row) => (row.flaggedPollingUnitIds ?? []).length > 0);
    if (wardResults.length === 0) {
      throw new BadRequestException('LGA must return this ward before bulk-returning flagged PUs');
    }
    if (returnedWard.length === 0) {
      throw new BadRequestException('LGA did not flag any polling units on this return');
    }

    let returnedCount = 0;
    let flaggedCount = 0;
    let reason = dto.reason?.trim() || 'Returned by ward after LGA flagged this unit for correction';

    for (const wardResult of returnedWard) {
      const flaggedIds = wardResult.flaggedPollingUnitIds ?? [];
      flaggedCount += flaggedIds.length;
      reason =
        dto.reason?.trim() ||
        wardResult.rejectionReason ||
        'Returned by ward after LGA flagged this unit for correction';

      const results = await this.prisma.collationResult.findMany({
        where: {
          campaignId: user.campaignId,
          contestId: wardResult.contestId,
          level: CollationLevel.POLLING_UNIT,
          scopeId: { in: flaggedIds },
          status: {
            in: [CollationResultStatus.APPROVED, CollationResultStatus.SUBMITTED],
          },
        },
      });

      for (const puResult of results) {
        await this.rejectResult(user, puResult.id, { reason });
        returnedCount += 1;
      }
    }

    return {
      returnedCount,
      flaggedCount,
      reason,
    };
  }

  private async validatePuIdsInWard(wardId: string, puIds: string[]): Promise<string[]> {
    const unique = [...new Set(puIds.map((id) => id.trim()).filter(Boolean))];
    if (unique.length === 0) return [];

    const valid = await this.prisma.pollingUnit.findMany({
      where: { id: { in: unique }, wardId },
      select: { id: true },
    });
    const validIds = new Set(valid.map((p) => p.id));
    const invalid = unique.filter((id) => !validIds.has(id));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Some polling units are not in this ward: ${invalid.slice(0, 3).join(', ')}${invalid.length > 3 ? '…' : ''}`,
      );
    }
    return unique;
  }

  private async isWardReturnedByLga(
    campaignId: string,
    pollingUnitId: string,
    contestId?: string,
  ): Promise<boolean> {
    const pu = await this.prisma.pollingUnit.findUnique({
      where: { id: pollingUnitId },
      select: { wardId: true },
    });
    if (!pu?.wardId) return false;

    const wardResult = await this.prisma.collationResult.findUnique({
      where: {
        campaignId_contestId_level_scopeType_scopeId: {
          campaignId,
          contestId: contestId ?? this.contests.id(),
          level: CollationLevel.WARD,
          scopeType: ScopeType.WARD,
          scopeId: pu.wardId,
        },
      },
      select: { status: true },
    });

    return wardResult?.status === CollationResultStatus.REJECTED;
  }

  async listActionLogs(user: JwtPayload, resultId: string) {
    if (!user.campaignId || !user.role) {
      throw new ForbiddenException('No active campaign membership');
    }

    const result = await this.prisma.collationResult.findUnique({ where: { id: resultId } });
    if (!result) throw new NotFoundException('Collation result not found');
    if (result.campaignId !== user.campaignId) {
      throw new ForbiddenException('Result is outside your campaign');
    }

    if (!isCampaignAdminRole(user.role)) {
      this.assertCollationUser(user);

      // Approvers may view logs for results they can act on (or already acted on).
      // Submitters may view logs for their own scope results.
      const ownLevel = getCollationLevelForRole(user.role as CampaignRole)!;
      const canViewOwn =
        result.level === ownLevel &&
        result.scopeType === user.scopeType &&
        result.scopeId === user.scopeId;

      if (!canViewOwn) {
        await this.verifyReviewerScope(user, result);
      }
    }

    return this.prisma.collationActionLog.findMany({
      where: { collationResultId: resultId },
      orderBy: { createdAt: 'desc' },
      include: {
        actor: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
  }

  private async validateWardIdsInLga(lgaId: string, wardIds: string[]): Promise<string[]> {
    const unique = [...new Set(wardIds.map((id) => id.trim()).filter(Boolean))];
    if (unique.length === 0) return [];

    const valid = await this.prisma.ward.findMany({
      where: { id: { in: unique }, lgaId },
      select: { id: true },
    });
    const validIds = new Set(valid.map((w) => w.id));
    const invalid = unique.filter((id) => !validIds.has(id));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Some wards are not in this LGA: ${invalid.slice(0, 3).join(', ')}${invalid.length > 3 ? '…' : ''}`,
      );
    }
    return unique;
  }

  private async writeActionLog(input: {
    campaignId: string;
    collationResultId: string;
    action: 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'COMMENTED';
    actorId: string;
    fromStatus?: CollationResultStatus | null;
    toStatus: CollationResultStatus;
    comment?: string | null;
    metadata?: Prisma.InputJsonValue;
  }) {
    return this.prisma.collationActionLog.create({
      data: {
        campaignId: input.campaignId,
        collationResultId: input.collationResultId,
        action: input.action,
        actorId: input.actorId,
        fromStatus: input.fromStatus ?? null,
        toStatus: input.toStatus,
        comment: input.comment ?? null,
        metadata: input.metadata ?? undefined,
      },
    });
  }

  private assertCollationUser(user: JwtPayload) {
    if (!user.campaignId || !user.role || !user.scopeType || !user.scopeId) {
      throw new ForbiddenException('Collation access requires scoped campaign membership');
    }
    if (!getCollationLevelForRole(user.role as CampaignRole)) {
      throw new ForbiddenException('Your role is not assigned to a collation level');
    }
  }

  private async getOwnedResult(user: JwtPayload, id: string) {
    const result = await this.prisma.collationResult.findUnique({ where: { id } });
    if (!result) throw new NotFoundException('Collation result not found');

    const level = getCollationLevelForRole(user.role as CampaignRole);
    if (
      result.campaignId !== user.campaignId ||
      result.level !== level ||
      result.scopeType !== user.scopeType ||
      result.scopeId !== user.scopeId
    ) {
      throw new ForbiddenException('You can only manage results for your assigned scope');
    }

    return result;
  }

  private async verifyApproverScope(
    user: JwtPayload,
    result: { level: string; scopeType: ScopeType | string; scopeId: string },
  ) {
    const userLevel = getCollationLevelForRole(user.role as CampaignRole)!;
    const subordinateLevel = getParentLevel(userLevel);
    if (!subordinateLevel || result.level !== subordinateLevel) {
      throw new ForbiddenException('You cannot approve results at this level');
    }

    const childScopeIds = await this.getChildScopeIds(
      user.scopeType as ScopeType,
      user.scopeId!,
      subordinateLevel,
    );

    if (!childScopeIds.includes(result.scopeId)) {
      throw new ForbiddenException('Result is outside your approval scope');
    }
  }

  private async verifyReviewerScope(
    user: JwtPayload,
    result: { level: string; scopeType: ScopeType | string; scopeId: string },
  ) {
    const userLevel = getCollationLevelForRole(user.role as CampaignRole);
    if (!userLevel) {
      throw new ForbiddenException('Your role cannot review collation results');
    }
    if (userLevel === CollationLevel.NATIONAL) return;

    if (result.scopeType === user.scopeType && result.scopeId === user.scopeId) return;

    if (userLevel === CollationLevel.WARD) {
      if (result.level !== CollationLevel.POLLING_UNIT) {
        throw new ForbiddenException('Ward officers can only review polling unit results in their ward');
      }
      const childScopeIds = await this.getChildScopeIds(
        ScopeType.WARD,
        user.scopeId!,
        CollationLevel.POLLING_UNIT,
      );
      if (!childScopeIds.includes(result.scopeId)) {
        throw new ForbiddenException('Result is outside your review scope');
      }
      return;
    }

    if (userLevel === CollationLevel.LGA) {
      if (result.level === CollationLevel.WARD) {
        const wardIds = await this.getChildScopeIds(ScopeType.LGA, user.scopeId!, CollationLevel.WARD);
        if (!wardIds.includes(result.scopeId)) {
          throw new ForbiddenException('Result is outside your review scope');
        }
        return;
      }
      if (result.level === CollationLevel.POLLING_UNIT) {
        const pu = await this.prisma.pollingUnit.findUnique({
          where: { id: result.scopeId },
          select: { ward: { select: { lgaId: true } } },
        });
        if (pu?.ward.lgaId !== user.scopeId) {
          throw new ForbiddenException('Result is outside your review scope');
        }
        return;
      }
      throw new ForbiddenException('LGA officers can only review ward or PU results in their LGA');
    }

    if (userLevel === CollationLevel.STATE) {
      if (result.level === CollationLevel.LGA) {
        const lgaIds = await this.getChildScopeIds(ScopeType.STATE, user.scopeId!, CollationLevel.LGA);
        if (!lgaIds.includes(result.scopeId)) {
          throw new ForbiddenException('Result is outside your review scope');
        }
        return;
      }
      if (result.level === CollationLevel.WARD) {
        const ward = await this.prisma.ward.findUnique({
          where: { id: result.scopeId },
          select: { lga: { select: { stateId: true } } },
        });
        if (ward?.lga.stateId !== user.scopeId) {
          throw new ForbiddenException('Result is outside your review scope');
        }
        return;
      }
      if (result.level === CollationLevel.POLLING_UNIT) {
        const pu = await this.prisma.pollingUnit.findUnique({
          where: { id: result.scopeId },
          select: { ward: { select: { lga: { select: { stateId: true } } } } },
        });
        if (pu?.ward.lga.stateId !== user.scopeId) {
          throw new ForbiddenException('Result is outside your review scope');
        }
        return;
      }
      throw new ForbiddenException('State officers can only review results in their state');
    }

    throw new ForbiddenException('You cannot review this result');
  }

  private async autoReturnChildResults(
    campaignId: string,
    level: CollationLevel,
    scopeIds: string[],
    actorId: string,
    reason: string,
    contestId?: string,
  ) {
    if (scopeIds.length === 0) return;
    const children = await this.prisma.collationResult.findMany({
      where: {
        campaignId,
        ...(contestId ? { contestId } : {}),
        level,
        scopeId: { in: scopeIds },
        status: {
          in: [CollationResultStatus.APPROVED, CollationResultStatus.SUBMITTED],
        },
      },
    });

    for (const child of children) {
      await this.prisma.collationResult.update({
        where: { id: child.id },
        data: {
          status: CollationResultStatus.REJECTED,
          rejectionReason: reason,
          approvedById: actorId,
          approvedAt: new Date(),
          approvalComment: null,
        },
      });
      await this.writeActionLog({
        campaignId,
        collationResultId: child.id,
        action: 'REJECTED',
        actorId,
        fromStatus: child.status as CollationResultStatus,
        toStatus: CollationResultStatus.REJECTED,
        comment: reason,
        metadata: { level: child.level, scopeType: child.scopeType, scopeId: child.scopeId, flaggedChild: true },
      });
      if (child.level === CollationLevel.POLLING_UNIT) {
        this.emitNotification({
          type: NotificationType.RESULT_RETURNED,
          campaignId,
          actorUserId: actorId,
          entityType: 'COLLATION_RESULT',
          entityId: child.id,
          sourceEventId: `${child.id}:FLAGGED`,
          sendPush: true,
          collationResult: {
            level: child.level,
            scopeType: child.scopeType,
            scopeId: child.scopeId,
            submittedById: child.submittedById,
          },
        });
      } else if (child.level === CollationLevel.WARD) {
        this.emitNotification({
          type: NotificationType.WARD_RETURNED_BY_LGA,
          campaignId,
          actorUserId: actorId,
          entityType: 'COLLATION_RESULT',
          entityId: child.id,
          sourceEventId: `${child.id}:FLAGGED`,
          sendPush: true,
          collationResult: {
            level: child.level,
            scopeType: child.scopeType,
            scopeId: child.scopeId,
            submittedById: child.submittedById,
          },
        });
      }
    }
  }

  private async countPendingApprovals(
    campaignId: string,
    level: CollationLevel,
    scopeType: ScopeType,
    scopeId?: string,
  ) {
    const subordinateLevel = getParentLevel(level);
    if (!subordinateLevel || !scopeId) return 0;

    const childScopeIds = await this.getChildScopeIds(scopeType, scopeId, subordinateLevel);
    return this.prisma.collationResult.count({
      where: {
        campaignId,
        level: subordinateLevel,
        status: CollationResultStatus.SUBMITTED,
        scopeId: { in: childScopeIds },
      },
    });
  }

  private async getChildScopeIds(
    scopeType: ScopeType,
    scopeId: string,
    childLevel: CollationLevel,
  ): Promise<string[]> {
    switch (childLevel) {
      case CollationLevel.POLLING_UNIT: {
        if (scopeType !== ScopeType.WARD) return [];
        const pus = await this.prisma.pollingUnit.findMany({ where: { wardId: scopeId }, select: { id: true } });
        return pus.map((p) => p.id);
      }
      case CollationLevel.WARD: {
        if (scopeType !== ScopeType.LGA) return [];
        const wards = await this.prisma.ward.findMany({ where: { lgaId: scopeId }, select: { id: true } });
        return wards.map((w) => w.id);
      }
      case CollationLevel.LGA: {
        if (scopeType !== ScopeType.STATE) return [];
        const lgas = await this.prisma.lGA.findMany({ where: { stateId: scopeId }, select: { id: true } });
        return lgas.map((l) => l.id);
      }
      case CollationLevel.STATE: {
        if (scopeType !== ScopeType.NATIONAL) return [];
        const states = await this.prisma.state.findMany({ select: { id: true } });
        return states.map((s) => s.id);
      }
      default:
        return [];
    }
  }

  private aggregatePartyResults(
    children: Array<{ partyResults: unknown }>,
  ): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const child of children) {
      const partyResults = child.partyResults as Record<string, number> | null;
      if (!partyResults) continue;
      for (const [party, votes] of Object.entries(partyResults)) {
        totals[party] = (totals[party] ?? 0) + (votes ?? 0);
      }
    }
    return totals;
  }

  private async rollupToParent(
    campaignId: string,
    level: CollationLevel,
    scopeType: ScopeType,
    scopeId: string,
    submittedById?: string,
    options: {
      clearRejection?: boolean;
      keepRejected?: boolean;
      notify?: boolean;
      contestId?: string;
    } = {},
  ) {
    const subordinateLevel = getParentLevel(level);
    if (!subordinateLevel) return;
    const contestId = options.contestId ?? this.contests.id();

    const childScopeIds = await this.getChildScopeIds(scopeType, scopeId, subordinateLevel);
    const childStatuses =
      subordinateLevel === CollationLevel.POLLING_UNIT
        ? [CollationResultStatus.APPROVED]
        : [
            CollationResultStatus.APPROVED,
            CollationResultStatus.REJECTED,
            CollationResultStatus.SUBMITTED,
          ];
    const children = childScopeIds.length
      ? await this.prisma.collationResult.findMany({
          where: {
            campaignId,
            contestId,
            level: subordinateLevel,
            scopeId: { in: childScopeIds },
            status: { in: childStatuses },
          },
        })
      : [];

    const existing = await this.prisma.collationResult.findUnique({
      where: {
        campaignId_contestId_level_scopeType_scopeId: {
          campaignId,
          contestId,
          level,
          scopeType,
          scopeId,
        },
      },
    });

    if (children.length === 0 && !existing) return;

    const totals = children.reduce(
      (acc, r) => ({
        registeredVoters: (acc.registeredVoters ?? 0) + (r.registeredVoters ?? 0),
        accreditedVoters: (acc.accreditedVoters ?? 0) + (r.accreditedVoters ?? 0),
        ballotPapersIssued: (acc.ballotPapersIssued ?? 0) + (r.ballotPapersIssued ?? 0),
        unusedBallotPapers: (acc.unusedBallotPapers ?? 0) + (r.unusedBallotPapers ?? 0),
        spoiledBallotPapers: (acc.spoiledBallotPapers ?? 0) + (r.spoiledBallotPapers ?? 0),
        votesCast: (acc.votesCast ?? 0) + (r.votesCast ?? 0),
        invalidVotes: (acc.invalidVotes ?? 0) + (r.invalidVotes ?? 0),
        usedBallotPapers: (acc.usedBallotPapers ?? 0) + (r.usedBallotPapers ?? 0),
      }),
      {
        registeredVoters: 0,
        accreditedVoters: 0,
        ballotPapersIssued: 0,
        unusedBallotPapers: 0,
        spoiledBallotPapers: 0,
        votesCast: 0,
        invalidVotes: 0,
        usedBallotPapers: 0,
      },
    );

    const partyResults = this.aggregatePartyResults(children);
    const status = options.keepRejected
      ? CollationResultStatus.REJECTED
      : options.clearRejection
        ? CollationResultStatus.APPROVED
        : existing?.status === CollationResultStatus.REJECTED
          ? CollationResultStatus.REJECTED
          : CollationResultStatus.APPROVED;
    const now = new Date();
    const isWardRollup = level === CollationLevel.WARD;
    const isLgaRollup = level === CollationLevel.LGA;

    const parent = await this.prisma.collationResult.upsert({
      where: {
        campaignId_contestId_level_scopeType_scopeId: {
          campaignId,
          contestId,
          level,
          scopeType,
          scopeId,
        },
      },
      create: {
        campaignId,
        contestId,
        level,
        scopeType,
        scopeId,
        ...totals,
        partyResults,
        status,
        submittedById,
        submittedAt: now,
        approvedById: status === CollationResultStatus.APPROVED ? submittedById : undefined,
        approvedAt: status === CollationResultStatus.APPROVED ? now : undefined,
        rejectionReason: status === CollationResultStatus.REJECTED ? existing?.rejectionReason : null,
        flaggedPollingUnitIds:
          status === CollationResultStatus.REJECTED ? (existing?.flaggedPollingUnitIds ?? []) : [],
        flaggedWardIds: status === CollationResultStatus.REJECTED ? (existing?.flaggedWardIds ?? []) : [],
      },
      update: {
        ...totals,
        partyResults,
        status,
        submittedById: submittedById ?? existing?.submittedById,
        submittedAt: now,
        approvedById: status === CollationResultStatus.APPROVED ? (submittedById ?? existing?.approvedById) : existing?.approvedById,
        approvedAt: status === CollationResultStatus.APPROVED ? now : existing?.approvedAt,
        rejectionReason: options.clearRejection
          ? null
          : status === CollationResultStatus.REJECTED
            ? (existing?.rejectionReason ?? null)
            : null,
        flaggedPollingUnitIds:
          status === CollationResultStatus.REJECTED ? (existing?.flaggedPollingUnitIds ?? []) : [],
        flaggedWardIds: status === CollationResultStatus.REJECTED ? (existing?.flaggedWardIds ?? []) : [],
        approvalComment: options.clearRejection ? null : existing?.approvalComment,
      },
    });

    if (options.notify !== false && isWardRollup && submittedById && status === CollationResultStatus.APPROVED) {
      this.emitNotification({
        type: NotificationType.WARD_FORWARDED_TO_LGA,
        campaignId,
        actorUserId: submittedById,
        entityType: 'COLLATION_RESULT',
        entityId: parent.id,
        sourceEventId: `${parent.id}:FORWARDED`,
        sendPush: false,
        collationResult: {
          level: parent.level,
          scopeType: parent.scopeType,
          scopeId: parent.scopeId,
          submittedById: parent.submittedById,
        },
      });
    } else if (options.notify !== false && isLgaRollup && submittedById && status === CollationResultStatus.APPROVED) {
      this.emitNotification({
        type: NotificationType.RESULT_SUBMITTED,
        campaignId,
        actorUserId: submittedById,
        entityType: 'COLLATION_RESULT',
        entityId: parent.id,
        sourceEventId: `${parent.id}:FORWARDED`,
        sendPush: false,
        collationResult: {
          level: parent.level,
          scopeType: parent.scopeType,
          scopeId: parent.scopeId,
          submittedById: parent.submittedById,
        },
      });
    }

    return parent;
  }

  private async publishAncestryRollups(
    campaignId: string,
    from: { level: CollationLevel; scopeType: ScopeType; scopeId: string },
    actorId?: string,
    options: { clearRejection?: boolean; keepRejected?: boolean; contestId?: string } = {},
  ) {
    const contestOpt = { contestId: options.contestId };
    if (from.level === CollationLevel.POLLING_UNIT) {
      const pu = await this.prisma.pollingUnit.findUnique({
        where: { id: from.scopeId },
        select: {
          wardId: true,
          ward: { select: { lgaId: true, lga: { select: { stateId: true } } } },
        },
      });
      if (!pu) return;
      await this.rollupToParent(campaignId, CollationLevel.WARD, ScopeType.WARD, pu.wardId, actorId, {
        clearRejection: options.clearRejection,
        keepRejected: options.keepRejected && !options.clearRejection,
        ...contestOpt,
      });
      await this.rollupToParent(campaignId, CollationLevel.LGA, ScopeType.LGA, pu.ward.lgaId, actorId, contestOpt);
      if (pu.ward.lga.stateId) {
        await this.rollupToParent(
          campaignId,
          CollationLevel.STATE,
          ScopeType.STATE,
          pu.ward.lga.stateId,
          actorId,
          contestOpt,
        );
      }
      return;
    }

    if (from.level === CollationLevel.WARD) {
      const ward = await this.prisma.ward.findUnique({
        where: { id: from.scopeId },
        select: { lgaId: true, lga: { select: { stateId: true } } },
      });
      if (!ward) return;
      await this.rollupToParent(campaignId, CollationLevel.WARD, ScopeType.WARD, from.scopeId, actorId, {
        clearRejection: options.clearRejection,
        keepRejected: options.keepRejected && !options.clearRejection,
        ...contestOpt,
      });
      await this.rollupToParent(campaignId, CollationLevel.LGA, ScopeType.LGA, ward.lgaId, actorId, contestOpt);
      if (ward.lga.stateId) {
        await this.rollupToParent(
          campaignId,
          CollationLevel.STATE,
          ScopeType.STATE,
          ward.lga.stateId,
          actorId,
          contestOpt,
        );
      }
      return;
    }

    if (from.level === CollationLevel.LGA) {
      const lga = await this.prisma.lGA.findUnique({
        where: { id: from.scopeId },
        select: { stateId: true },
      });
      await this.rollupToParent(campaignId, CollationLevel.LGA, ScopeType.LGA, from.scopeId, actorId, {
        clearRejection: options.clearRejection,
        keepRejected: options.keepRejected && !options.clearRejection,
        ...contestOpt,
      });
      if (lga?.stateId) {
        await this.rollupToParent(
          campaignId,
          CollationLevel.STATE,
          ScopeType.STATE,
          lga.stateId,
          actorId,
          contestOpt,
        );
      }
    }
  }

  private async ingestResultPulse(
    user: JwtPayload,
    submitted: { campaignId: string; scopeId: string; partyResults: Prisma.JsonValue | null },
  ) {
    try {
      const campaign = await this.prisma.campaign.findUnique({
        where: { id: submitted.campaignId },
        select: { clientPartyCode: true, trackedParties: true },
      });
      const partyCodes = getPartyCodes(normalizeTrackedParties(campaign?.trackedParties));
      const observed = parsePartyTotals(submitted.partyResults, partyCodes);
      await this.situationRoom.ingestInferredPulse({
        campaignId: submitted.campaignId,
        pollingUnitId: submitted.scopeId,
        reportedById: user.sub,
        source: PulseSource.RESULT,
        phase: ElectionDayPhase.COUNTING,
        observedPartyResults: Object.keys(observed).length ? observed : null,
        whoLooksAhead: observedLead(observed, campaign?.clientPartyCode),
      });
    } catch {
      // Result submit must not fail because pulse ingest blipped.
    }
  }

  private emitNotification(payload: NotificationDispatchPayload) {
    this.eventEmitter.emit(NOTIFICATION_DISPATCH_EVENT, payload);

    // A submitted, approved or returned result changes reporting coverage and
    // the margin, both of which the risk engine scores. Mark the chain dirty so
    // the board reflects it within a drain rather than at the next full sweep.
    if (payload.collationResult && payload.campaignId) {
      void this.emitTriageDirtyForResult(payload.campaignId, payload.collationResult);
    }
  }

  /**
   * Resolve a collation result's scope chain and mark it dirty for rescoring.
   *
   * Emitted rather than called so CollationModule never imports TriageModule.
   */
  private async emitTriageDirtyForResult(
    campaignId: string,
    result: { scopeType: string; scopeId: string },
  ) {
    try {
      const chain: TriageDirtyPayload = { campaignId };

      if (result.scopeType === 'POLLING_UNIT') {
        const pu = await this.prisma.pollingUnit.findUnique({
          where: { id: result.scopeId },
          select: {
            wardId: true,
            ward: { select: { lgaId: true, lga: { select: { stateId: true } } } },
          },
        });
        if (pu) {
          chain.wardId = pu.wardId;
          chain.lgaId = pu.ward.lgaId;
          chain.stateId = pu.ward.lga.stateId;
        }
      } else if (result.scopeType === 'WARD') {
        const ward = await this.prisma.ward.findUnique({
          where: { id: result.scopeId },
          select: { id: true, lgaId: true, lga: { select: { stateId: true } } },
        });
        if (ward) {
          chain.wardId = ward.id;
          chain.lgaId = ward.lgaId;
          chain.stateId = ward.lga.stateId;
        }
      } else if (result.scopeType === 'LGA') {
        const lga = await this.prisma.lGA.findUnique({
          where: { id: result.scopeId },
          select: { id: true, stateId: true },
        });
        if (lga) {
          chain.lgaId = lga.id;
          chain.stateId = lga.stateId;
        }
      } else if (result.scopeType === 'STATE') {
        chain.stateId = result.scopeId;
      }

      this.eventEmitter.emit(TRIAGE_DIRTY_EVENT, chain);
    } catch {
      // Collation must never fail because scoring wanted a refresh.
    }
  }
}
