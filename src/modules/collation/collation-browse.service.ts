import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CampaignRole,
  CollationLevel,
  CollationResultStatus,
  FieldReportType,
  JwtPayload,
  ScopeType,
  TrackedParty,
  emptyPartyTotals,
  getCollationLevelForRole,
  getPartyCodes,
  isCampaignAdminRole,
  normalizeTrackedParties,
  parsePartyTotals,
} from '@electromon/shared';
import { Prisma } from '@electromon/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContestService } from '../../common/contest/contest.service';
import { DeploymentScopeService } from '../../common/deployment-scope/deployment-scope.service';
import { RedisService } from '../../common/redis/redis.service';
import { CollationReadinessService } from './collation-readiness.service';
import { PulseGeoService } from '../situation-room/pulse-geo.service';
import { isIrevQaMismatch } from '../irev/irev-verification';
import {
  ApprovalPipeline,
  computeDelayedPollingUnits,
  computeOperationalStatus,
  computeScopeVelocity,
  reportingStatsExtended,
  selectMapParties,
  type OperationalStatus,
  type ScopeReporting,
  type ScopeVelocity,
} from './collation-map-intelligence';
import {
  getLgaScopeId,
  getStateScopeId,
  getWardScopeId,
  isLgaScopedUser,
  isStateScopedUser,
  isWardScopedUser,
} from '../../common/scoping/campaign-scope';
import { resolveIrevVerification } from '../irev/irev-verification';
import {
  ATTENTION_FEED_WINDOW_MINUTES,
  attachAttention,
  clusterAttentionRows,
  summarizeVotesAtRisk,
  type IrevAttentionCluster,
  type IrevAttentionFeed,
  type IrevSeverity,
  type IrevVotesAtRisk,
} from '../irev/irev-attention';

type MapOutcome = 'WIN' | 'LOSS' | 'TIE' | 'PENDING';

type IncidentBucket = {
  count: number;
  urgent: number;
  weight: number;
  maxSeverity: string | null;
};

function emptyIncidentBucket(): IncidentBucket {
  return { count: 0, urgent: 0, weight: 0, maxSeverity: null };
}

/** Short TTL for national Situation Room polls (web hits these every ~20s). */
const NATIONAL_SITUATION_CACHE_TTL_SEC = Math.max(
  3,
  Number(process.env.SITUATION_ROOM_CACHE_TTL_SEC ?? 10) || 10,
);

function nationalMapCacheKey(
  campaignId: string,
  region: string | undefined,
  includeIncidents: boolean | undefined,
  includeIrevMismatches: boolean | undefined,
) {
  const zone = region?.trim() ? region.trim().toUpperCase() : 'all';
  return `sr:v7:map:${campaignId}:r:${zone}:i:${includeIncidents ? 1 : 0}:v:${includeIrevMismatches ? 1 : 0}`;
}

function nationalRaceCacheKey(campaignId: string) {
  return `sr:v2:race:${campaignId}`;
}

function partiesTotal(parties: Record<string, number>) {
  return Object.values(parties).reduce((sum, n) => sum + n, 0);
}

function addPartyTotals(into: Record<string, number>, add: Record<string, number>) {
  for (const [code, votes] of Object.entries(add)) {
    into[code] = (into[code] ?? 0) + votes;
  }
  return into;
}

function sumPuPartiesByStatus(
  rows: Array<{ scopeId: string; status: string; partyResults?: unknown }>,
  puIds: Set<string> | undefined,
  statuses: CollationResultStatus | CollationResultStatus[],
  partyColumns: string[],
): Record<string, number> {
  const allowed = new Set(Array.isArray(statuses) ? statuses : [statuses]);
  const totals: Record<string, number> = {};
  for (const row of rows) {
    if (!allowed.has(row.status as CollationResultStatus)) continue;
    if (puIds && !puIds.has(row.scopeId)) continue;
    addPartyTotals(totals, parsePartyTotals(row.partyResults, partyColumns));
  }
  return totals;
}

function unapprovedMapSelection(
  approved: Record<string, number>,
  submitted: Record<string, number>,
  returned: Record<string, number>,
) {
  const unapproved = addPartyTotals({ ...submitted }, returned);
  const status: 'SUBMITTED' | 'REJECTED' =
    partiesTotal(submitted) > 0 ? 'SUBMITTED' : 'REJECTED';
  return selectMapParties(approved, unapproved, status);
}

function averageCoords(
  rows: Array<{ latitude?: number | null; longitude?: number | null }>,
): { latitude: number; longitude: number } | null {
  let lat = 0;
  let lng = 0;
  let n = 0;
  for (const row of rows) {
    if (row.latitude == null || row.longitude == null) continue;
    lat += row.latitude;
    lng += row.longitude;
    n += 1;
  }
  if (!n) return null;
  return { latitude: lat / n, longitude: lng / n };
}

function severityWeight(severity: string | null | undefined) {
  switch (severity) {
    case 'CRITICAL':
      return 4;
    case 'HIGH':
      return 3;
    case 'MEDIUM':
      return 2;
    case 'LOW':
    default:
      return 1;
  }
}

function severityRank(severity: string | null | undefined) {
  return severityWeight(severity);
}

function bumpIncident(
  map: Map<string, IncidentBucket>,
  id: string,
  weight: number,
  urgent: number,
  severity: string,
) {
  const current = map.get(id) ?? emptyIncidentBucket();
  const nextSeverity =
    !current.maxSeverity || severityRank(severity) > severityRank(current.maxSeverity)
      ? severity
      : current.maxSeverity;
  map.set(id, {
    count: current.count + 1,
    urgent: current.urgent + urgent,
    weight: current.weight + weight,
    maxSeverity: nextSeverity,
  });
}

function computeOutcome(
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
  const margin = max - clientVotes;

  if (!clientPartyCode) return { outcome: 'PENDING', leadingParty, margin };
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
  return { outcome: 'LOSS', leadingParty, margin };
}

function titleCaseName(value: string): string {
  return value
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export interface BrowseRow {
  id: string;
  name: string;
  code?: string;
  subtitle?: string;
  locationLabel?: string;
  parties: Record<string, number>;
  totalVotes: number;
  href?: string;
  /** Collation status when browsing polling units */
  resultStatus?: 'NOT_STARTED' | 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | string;
  reporting?: ScopeReporting;
  irevVerification?: ReturnType<typeof resolveIrevVerification>;
  latitude?: number | null;
  longitude?: number | null;
}

export interface PaginatedBrowseResult {
  stateName: string;
  stateId: string;
  title: string;
  subtitle: string;
  level: 'STATE' | 'LGA' | 'WARD' | 'POLLING_UNIT';
  parent?: { id: string; name: string; href?: string };
  trackedParties: TrackedParty[];
  clientPartyCode?: string | null;
  partyColumns: string[];
  data: BrowseRow[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

@Injectable()
export class CollationBrowseService {
  constructor(
    private prisma: PrismaService,
    private contests: ContestService,
    private readinessService: CollationReadinessService,
    private redis: RedisService,
    private pulseGeo: PulseGeoService,
    private deploymentScope: DeploymentScopeService,
  ) {}

  /** Drop national map/race caches after collation writes so the next poll is fresh. */
  async invalidateNationalSituationCaches(campaignId: string) {
    if (!campaignId) return;
    await Promise.all([
      this.redis.del(nationalRaceCacheKey(campaignId)),
      this.redis.delByPattern(`sr:v1:map:${campaignId}:*`),
    ]);
  }

  async getContext(user: JwtPayload) {
    if (!user.campaignId) {
      throw new ForbiddenException('Campaign membership required');
    }

    const campaign = await this.prisma.campaign.findUniqueOrThrow({
      where: { id: user.campaignId },
      include: { state: true },
    });

    const trackedParties = normalizeTrackedParties(campaign.trackedParties);
    const partyColumns = getPartyCodes(trackedParties);
    const isNational = campaign.isNational === true;

    let stateId = campaign.state.id;
    let stateName = isNational ? 'NIGERIA' : campaign.state.name.toUpperCase();
    let stateCode = isNational ? 'NG' : campaign.state.code;
    let lgaId: string | null = null;
    let lgaName: string | null = null;
    let wardId: string | null = null;
    let wardName: string | null = null;

    const stateScopeId = getStateScopeId(user);
    if (isStateScopedUser(user)) {
      if (!stateScopeId) {
        throw new ForbiddenException('Your account is not assigned to a state');
      }
      const scopedState =
        campaign.state.id === stateScopeId
          ? campaign.state
          : await this.prisma.state.findUnique({ where: { id: stateScopeId } });
      if (!scopedState) {
        throw new ForbiddenException('Your account is not assigned to a valid state');
      }
      stateId = scopedState.id;
      stateName = scopedState.name.toUpperCase();
      stateCode = scopedState.code;
    } else if (isLgaScopedUser(user)) {
      const scopedLgaId = getLgaScopeId(user);
      if (!scopedLgaId) {
        throw new ForbiddenException('Your account is not assigned to an LGA');
      }
      const scopedLga = await this.prisma.lGA.findUnique({
        where: { id: scopedLgaId },
        include: { state: true },
      });
      if (!scopedLga) {
        throw new ForbiddenException('Your account is not assigned to a valid LGA');
      }
      stateId = scopedLga.state.id;
      stateName = scopedLga.state.name.toUpperCase();
      stateCode = scopedLga.state.code;
      lgaId = scopedLga.id;
      lgaName = scopedLga.name.toUpperCase();
    } else if (isWardScopedUser(user)) {
      const scopedWardId = getWardScopeId(user);
      if (!scopedWardId) {
        throw new ForbiddenException('Your account is not assigned to a ward');
      }
      const scopedWard = await this.prisma.ward.findUnique({
        where: { id: scopedWardId },
        include: { lga: { include: { state: true } } },
      });
      if (!scopedWard) {
        throw new ForbiddenException('Your account is not assigned to a valid ward');
      }
      stateId = scopedWard.lga.state.id;
      stateName = scopedWard.lga.state.name.toUpperCase();
      stateCode = scopedWard.lga.state.code;
      lgaId = scopedWard.lga.id;
      lgaName = scopedWard.lga.name.toUpperCase();
      wardId = scopedWard.id;
      wardName = scopedWard.name.toUpperCase();
    } else if (
      user.scopeType === ScopeType.POLLING_UNIT ||
      user.role === CampaignRole.POLLING_AGENT
    ) {
      // National campaigns use FCT as campaign.stateId — do NOT leave PU agents
      // stuck on that home state or My Unit 404s for every other state.
      if (!user.scopeId) {
        throw new ForbiddenException('Your account is not assigned to a polling unit');
      }
      const scopedPu = await this.prisma.pollingUnit.findUnique({
        where: { id: user.scopeId },
        include: { ward: { include: { lga: { include: { state: true } } } } },
      });
      if (!scopedPu) {
        throw new ForbiddenException('Your account is not assigned to a valid polling unit');
      }
      stateId = scopedPu.ward.lga.state.id;
      stateName = scopedPu.ward.lga.state.name.toUpperCase();
      stateCode = scopedPu.ward.lga.state.code;
      lgaId = scopedPu.ward.lga.id;
      lgaName = scopedPu.ward.lga.name.toUpperCase();
      wardId = scopedPu.ward.id;
      wardName = scopedPu.ward.name.toUpperCase();
    }

    const contests = await this.contests.list(campaign.id);
    const activeContest = this.contests.current() ?? contests.find((row) => row.isDefault) ?? contests[0] ?? null;
    const constituencies = await this.contests.listSeats(campaign.id);
    const activeSeat = this.contests.seat();

    return this.deploymentScope.applyToBrowseContext({
      campaignId: campaign.id,
      campaignName: campaign.name,
      isNational,
      stateId,
      stateName,
      stateCode,
      lgaId,
      lgaName,
      wardId,
      wardName,
      role: user.role,
      scopeType: user.scopeType,
      scopeId: user.scopeId,
      clientPartyCode: this.deploymentScope.resolveClientPartyCode(campaign.clientPartyCode),
      trackedParties,
      partyColumns,
      contests,
      activeContest,
      constituencies,
      activeSeat,
    });
  }

  async browseConstituencies(user: JwtPayload, page = 1, limit = 20, search?: string) {
    if (!user.campaignId) throw new ForbiddenException('Campaign membership required');
    const contest = this.contests.current();
    const campaign = await this.prisma.campaign.findUniqueOrThrow({
      where: { id: user.campaignId },
      include: { state: true },
    });
    const partyConfig = await this.getCampaignPartyConfig(user.campaignId);
    const q = search?.trim();
    const where: Prisma.StateAssemblyConstituencyWhereInput = {
      stateId: campaign.stateId,
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { code: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.stateAssemblyConstituency.findMany({
        where,
        include: { lga: { select: { name: true } }, wards: { select: { id: true } } },
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.stateAssemblyConstituency.count({ where }),
    ]);
    const scopeIds = rows.map((row) => row.id);
    const wardIds = rows.flatMap((row) => row.wards.map((ward) => ward.id));
    const [results, pollingUnits] = await Promise.all([
      scopeIds.length
        ? this.prisma.collationResult.findMany({
            where: {
              campaignId: user.campaignId,
              contestId: contest?.id,
              level: CollationLevel.CONSTITUENCY,
              scopeId: { in: scopeIds },
            },
          })
        : Promise.resolve([]),
      wardIds.length
        ? this.prisma.pollingUnit.findMany({
            where: { wardId: { in: wardIds } },
            select: { id: true, wardId: true },
          })
        : Promise.resolve([]),
    ]);
    const puResults =
      pollingUnits.length > 0
        ? await this.prisma.collationResult.findMany({
            where: {
              campaignId: user.campaignId,
              contestId: contest?.id,
              level: CollationLevel.POLLING_UNIT,
              status: CollationResultStatus.APPROVED,
              scopeId: { in: pollingUnits.map((pu) => pu.id) },
            },
            select: { scopeId: true, partyResults: true, status: true },
          })
        : [];
    const byScope = new Map(results.map((row) => [row.scopeId, row]));
    const puByWard = new Map<string, string[]>();
    for (const pu of pollingUnits) {
      const list = puByWard.get(pu.wardId) ?? [];
      list.push(pu.id);
      puByWard.set(pu.wardId, list);
    }
    const puResultById = new Map(puResults.map((row) => [row.scopeId, row]));
    return {
      stateName: campaign.state.name.toUpperCase(),
      stateId: campaign.state.id,
      title: 'State House of Assembly',
      subtitle: contest?.label ?? '24 constituencies',
      level: 'CONSTITUENCY' as const,
      trackedParties: partyConfig.trackedParties,
      clientPartyCode: partyConfig.clientPartyCode,
      partyColumns: partyConfig.partyColumns,
      data: rows.map((row) => {
        const result = byScope.get(row.id);
        let parties = parsePartyTotals(result?.partyResults, partyConfig.partyColumns);
        if (partiesTotal(parties) <= 0) {
          parties = emptyPartyTotals(partyConfig.partyColumns);
          for (const ward of row.wards) {
            for (const puId of puByWard.get(ward.id) ?? []) {
              const puResult = puResultById.get(puId);
              if (!puResult) continue;
              addPartyTotals(parties, parsePartyTotals(puResult.partyResults, partyConfig.partyColumns));
            }
          }
        }
        const totalVotes = partyConfig.partyColumns.reduce((sum, code) => sum + (parties[code] ?? 0), 0);
        return {
          id: row.id,
          name: row.name,
          code: row.code,
          subtitle: row.lga?.name ?? campaign.state.name,
          parties,
          totalVotes,
          resultStatus: result?.status ?? (totalVotes > 0 ? 'APPROVED' : 'NOT_STARTED'),
          wardCount: row.wards.length,
        };
      }),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  private async getCampaignPartyConfig(campaignId: string) {
    const campaign = await this.prisma.campaign.findUniqueOrThrow({
      where: { id: campaignId },
    });
    const trackedParties = normalizeTrackedParties(campaign.trackedParties);
    return {
      trackedParties,
      clientPartyCode: this.deploymentScope.resolveClientPartyCode(campaign.clientPartyCode),
      partyColumns: getPartyCodes(trackedParties),
    };
  }

  /** Resolve display party totals for a single PU (actual submission only). */
  async resolvePuDisplayParties(campaignId: string, puId: string) {
    const partyConfig = await this.getCampaignPartyConfig(campaignId);
    const partyColumns = partyConfig.partyColumns;

    const pu = await this.prisma.pollingUnit.findUnique({
      where: { id: puId },
      select: { id: true, wardId: true, ward: { select: { lgaId: true } } },
    });
    if (!pu) {
      return {
        parties: emptyPartyTotals(partyColumns),
        status: 'NOT_STARTED' as const,
        partyColumns,
      };
    }

    const result = await this.prisma.collationResult.findFirst({
      where: {
        campaignId,
        level: CollationLevel.POLLING_UNIT,
        scopeId: puId,
      },
      select: { partyResults: true, status: true },
    });

    const puParties = parsePartyTotals(result?.partyResults, partyColumns);
    return {
      parties: puParties,
      status: (result?.status ?? 'NOT_STARTED') as string,
      partyColumns,
    };
  }

  private withPartyMeta<T extends object>(
    payload: T,
    partyConfig: Awaited<ReturnType<CollationBrowseService['getCampaignPartyConfig']>>,
  ) {
    return {
      ...payload,
      trackedParties: partyConfig.trackedParties,
      clientPartyCode: partyConfig.clientPartyCode,
      partyColumns: partyConfig.partyColumns,
    };
  }

  private campaignStateFilter(
    isNational: boolean,
    campaignStateId: string,
    stateId?: string,
  ): { stateId?: string } {
    const locked = this.deploymentScope.clampStateId(stateId);
    if (locked) return { stateId: locked };
    if (isNational) return stateId ? { stateId } : {};
    return { stateId: stateId ?? campaignStateId };
  }

  /** Directors may browse nationwide; state coordinators are locked to their assigned state. */
  private browseGeoFilter(
    user: JwtPayload,
    context: { isNational: boolean; stateId: string },
    requestedStateId?: string,
  ): { stateId?: string } {
    if (this.deploymentScope.isStateLocked()) {
      return { stateId: this.deploymentScope.clampStateId(requestedStateId) };
    }
    if (isStateScopedUser(user)) {
      const assigned = getStateScopeId(user);
      if (!assigned) {
        throw new ForbiddenException('Your account is not assigned to a state');
      }
      if (requestedStateId && requestedStateId !== assigned) {
        throw new ForbiddenException('You can only access local governments in your assigned state');
      }
      return { stateId: assigned };
    }
    return this.campaignStateFilter(context.isNational, context.stateId, requestedStateId);
  }

  private applySeatWardFilter(where: Prisma.WardWhereInput) {
    const seat = this.contests.seat();
    if (!seat) return;
    where.id = seat.wardIds.length ? { in: seat.wardIds } : { in: [] };
  }

  private assertSeatAllowsLga(lgaId: string) {
    const seat = this.contests.seat();
    if (seat?.lgaId && seat.lgaId !== lgaId) {
      throw new ForbiddenException('That local government is outside the selected assembly seat');
    }
  }

  private assertSeatAllowsWard(wardId: string) {
    const seat = this.contests.seat();
    if (seat && !seat.wardIds.includes(wardId)) {
      throw new ForbiddenException('That ward is outside the selected assembly seat');
    }
  }

  async browseStates(
    user: JwtPayload,
    page = 1,
    limit = 20,
    search?: string,
    zone?: string,
  ) {
    const context = await this.getContext(user);
    const partyConfig = await this.getCampaignPartyConfig(user.campaignId!);
    if (!context.isNational && !this.deploymentScope.isStateLocked()) {
      throw new ForbiddenException('State browse is only available for national campaigns');
    }
    if (this.isScopedToWard(user) || this.isScopedToLga(user)) {
      throw new ForbiddenException('Insufficient scope for nationwide state browse');
    }
    this.assertCanBrowseLevel(user, CollationLevel.STATE);

    const where: Prisma.StateWhereInput = {
      ...this.deploymentScope.stateWhere(),
      ...(search
        ? { name: { contains: search, mode: Prisma.QueryMode.insensitive } }
        : {}),
      ...(zone ? { zone } : {}),
    };

    const [total, states] = await Promise.all([
      this.prisma.state.count({ where }),
      this.prisma.state.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        select: { id: true, name: true, code: true, zone: true },
      }),
    ]);

    const stateIds = states.map((s) => s.id);
    const [results, reportingByState, lgaCounts] = await Promise.all([
      this.prisma.collationResult.findMany({
        where: {
          campaignId: user.campaignId!,
          contestId: this.contests.id(),
          level: CollationLevel.STATE,
          scopeId: { in: stateIds },
        },
      }),
      this.loadPuReportingByState(user.campaignId!, stateIds),
      stateIds.length
        ? this.prisma.lGA.groupBy({
            by: ['stateId'],
            where: { stateId: { in: stateIds } },
            _count: { id: true },
          })
        : Promise.resolve([]),
    ]);

    const resultMap = new Map(results.map((r) => [r.scopeId, r]));
    const lgaCountMap = new Map(lgaCounts.map((row) => [row.stateId, row._count.id]));

    return this.withPartyMeta(
      {
        stateName: context.stateName,
        stateId: context.stateId,
        title: context.stateName,
        subtitle: 'States & FCT',
        level: 'STATE' as const,
        data: states.map((state) => {
          const parties = parsePartyTotals(
            resultMap.get(state.id)?.partyResults,
            partyConfig.partyColumns,
          );
          const totalVotes = Object.values(parties).reduce((sum, n) => sum + n, 0);
          const result = resultMap.get(state.id);
          const cov = reportingByState.get(state.id);
          const lgaCount = lgaCountMap.get(state.id) ?? 0;
          const zoneLabel = state.zone ? titleCaseName(state.zone.replace(/_/g, ' ')) : null;
          const subtitleParts = [
            zoneLabel,
            `${lgaCount} LGA${lgaCount === 1 ? '' : 's'}`,
          ].filter(Boolean);

          return {
            id: state.id,
            name: titleCaseName(state.name),
            code: state.code,
            parties,
            totalVotes,
            subtitle: subtitleParts.join(' · '),
            resultStatus:
              result?.status ?? (totalVotes > 0 ? 'APPROVED' : 'NOT_STARTED'),
            reporting: this.buildReportingFromCov(cov),
          };
        }),
        meta: this.buildMeta(page, limit, total),
      },
      partyConfig,
    ) satisfies PaginatedBrowseResult;
  }

  async browseLgas(
    user: JwtPayload,
    page = 1,
    limit = 20,
    search?: string,
    stateId?: string,
  ) {
    const context = await this.getContext(user);
    const partyConfig = await this.getCampaignPartyConfig(user.campaignId!);
    if (this.isScopedToWard(user)) {
      throw new ForbiddenException('Ward officers can only access their assigned ward');
    }
    this.assertCanBrowseLevel(user, CollationLevel.LGA);

    const geo = this.browseGeoFilter(user, context, stateId);
    const where: Prisma.LGAWhereInput = {
      ...geo,
      ...(search
        ? { name: { contains: search, mode: Prisma.QueryMode.insensitive } }
        : {}),
    };

    if (this.isScopedToLga(user)) {
      where.id = user.scopeId!;
    }
    const seatLgaId = this.contests.seat()?.lgaId;
    if (seatLgaId) {
      where.id = seatLgaId;
    }

    const [total, lgas] = await Promise.all([
      this.prisma.lGA.count({ where }),
      this.prisma.lGA.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        include: context.isNational
          ? { state: { select: { id: true, name: true } } }
          : undefined,
      }),
    ]);

    const lgaIds = lgas.map((l) => l.id);
    const [results, reportingMaps, wardCounts] = await Promise.all([
      this.prisma.collationResult.findMany({
        where: {
          campaignId: user.campaignId!,
          contestId: this.contests.id(),
          level: CollationLevel.LGA,
          scopeId: { in: lgaIds },
        },
      }),
      lgaIds.length
        ? this.loadPuReportingMaps(user.campaignId!, lgaIds)
        : Promise.resolve(null),
      lgaIds.length
        ? this.prisma.ward.groupBy({
            by: ['lgaId'],
            where: { lgaId: { in: lgaIds } },
            _count: { id: true },
          })
        : Promise.resolve([]),
    ]);

    const resultMap = new Map(results.map((r) => [r.scopeId, r]));
    const wardCountMap = new Map(wardCounts.map((row) => [row.lgaId, row._count.id]));

    const scopedStateName =
      !context.isNational && lgas.length > 0
        ? titleCaseName(context.stateName)
        : null;

    return this.withPartyMeta(
      {
        stateName: context.stateName,
        stateId: context.stateId,
        title: context.stateName,
        subtitle: 'List of Local Governments',
        level: 'LGA' as const,
        data: lgas.map((lga) => {
          const result = resultMap.get(lga.id);
          const parties = parsePartyTotals(result?.partyResults, partyConfig.partyColumns);
          const totalVotes = Object.values(parties).reduce((sum, n) => sum + n, 0);
          const lgaWithState = lga as typeof lga & {
            state?: { id: string; name: string };
          };
          const stateRef = context.isNational ? lgaWithState.state : undefined;
          const wardCount = wardCountMap.get(lga.id) ?? 0;
          const subtitle = context.isNational && stateRef
            ? titleCaseName(stateRef.name)
            : `${wardCount} ward${wardCount === 1 ? '' : 's'}`;

          return {
            id: lga.id,
            name: titleCaseName(lga.name),
            parties,
            totalVotes,
            href: `/dashboard/lgas/${lga.id}`,
            subtitle,
            locationLabel: stateRef ? titleCaseName(stateRef.name) : scopedStateName ?? undefined,
            resultStatus:
              result?.status ?? (totalVotes > 0 ? 'APPROVED' : 'NOT_STARTED'),
            reporting: reportingMaps
              ? this.buildReportingFromCov(reportingMaps.byLga.get(lga.id))
              : undefined,
          };
        }),
        meta: this.buildMeta(page, limit, total),
      },
      partyConfig,
    ) satisfies PaginatedBrowseResult;
  }

  async browseWards(user: JwtPayload, lgaId: string, page = 1, limit = 20, search?: string) {
    const context = await this.getContext(user);
    const partyConfig = await this.getCampaignPartyConfig(user.campaignId!);
    this.assertCanBrowseLevel(user, CollationLevel.WARD);

    const lga = await this.prisma.lGA.findFirst({
      where: {
        id: lgaId,
        ...this.browseGeoFilter(user, context),
      },
    });
    if (!lga) throw new NotFoundException('LGA not found');

    if (this.isScopedToLga(user) && user.scopeId !== lgaId) {
      throw new ForbiddenException('You can only browse wards in your assigned LGA');
    }
    this.assertSeatAllowsLga(lgaId);

    const where: Prisma.WardWhereInput = {
      lgaId,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { registrationAreaCode: { contains: search, mode: Prisma.QueryMode.insensitive } },
            ],
          }
        : {}),
    };

    if (this.isScopedToWard(user)) {
      where.id = user.scopeId!;
    }
    this.applySeatWardFilter(where);

    const [total, wards] = await Promise.all([
      this.prisma.ward.count({ where }),
      this.prisma.ward.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const results = await this.prisma.collationResult.findMany({
      where: {
        campaignId: user.campaignId!,
        contestId: this.contests.id(),
        level: CollationLevel.WARD,
        scopeId: { in: wards.map((w) => w.id) },
      },
    });
    const resultMap = new Map(results.map((r) => [r.scopeId, r]));

    const wardIds = wards.map((w) => w.id);
    const [pollingUnits, reportingMaps, lgaResult] = await Promise.all([
      this.prisma.pollingUnit.findMany({
        where: { wardId: { in: wardIds } },
        select: { id: true, wardId: true },
      }),
      this.loadPuReportingMaps(user.campaignId!, [lgaId]),
      this.prisma.collationResult.findFirst({
        where: {
          campaignId: user.campaignId!,
          contestId: this.contests.id(),
          level: CollationLevel.LGA,
          scopeId: lgaId,
        },
        select: { partyResults: true, status: true },
      }),
    ]);
    const puResults =
      pollingUnits.length > 0
        ? await this.prisma.collationResult.findMany({
            where: {
              campaignId: user.campaignId!,
              contestId: this.contests.id(),
              level: CollationLevel.POLLING_UNIT,
              scopeId: { in: pollingUnits.map((pu) => pu.id) },
            },
            select: { scopeId: true, status: true, partyResults: true },
          })
        : [];

    const puResultMap = new Map(puResults.map((r) => [r.scopeId, r]));
    const puPartiesByWard = new Map<string, Record<string, number>>();
    for (const pu of pollingUnits) {
      const puResult = puResultMap.get(pu.id);
      if (!puResult || puResult.status !== CollationResultStatus.APPROVED) continue;
      const parties = parsePartyTotals(puResult.partyResults, partyConfig.partyColumns);
      puPartiesByWard.set(
        pu.wardId,
        addPartyTotals(puPartiesByWard.get(pu.wardId) ?? {}, parties),
      );
    }


    return this.withPartyMeta(
      {
        stateName: context.stateName,
        stateId: context.stateId,
        title: titleCaseName(lga.name),
        subtitle: this.isScopedToLga(user)
          ? 'Ward results in your LGA'
          : `Ward results in ${titleCaseName(lga.name)} LGA`,
        level: 'WARD' as const,
        // Parent is the LGA list (state level), never the same LGA you are already viewing.
        parent: this.isScopedToLga(user)
          ? undefined
          : {
              id: context.stateId,
              name: 'Local Governments',
              href: '/dashboard/lgas',
            },
        data: wards.map((ward) => {
          const result = resultMap.get(ward.id);
          const wardParties = parsePartyTotals(result?.partyResults, partyConfig.partyColumns);
          let parties = wardParties;
          const puAggregate = puPartiesByWard.get(ward.id) ?? {};
          if (partiesTotal(parties) <= 0) {
            parties = puAggregate;
          }
          const totalVotes = partiesTotal(parties);
          const fromPu = partiesTotal(wardParties) <= 0 && partiesTotal(puAggregate) > 0;
          const puCount = reportingMaps.puByWard.get(ward.id)?.size ?? 0;
          return {
            id: ward.id,
            name: titleCaseName(ward.name),
            code: ward.registrationAreaCode ?? undefined,
            parties,
            totalVotes,
            href: `/dashboard/wards/${ward.id}`,
            subtitle: ward.registrationAreaCode ?? (puCount > 0 ? `${puCount} polling units` : undefined),
            locationLabel: titleCaseName(lga.name),
            resultStatus:
              result?.status ??
              (fromPu ? 'APPROVED' : totalVotes > 0 ? 'APPROVED' : 'NOT_STARTED'),
            reporting: this.buildReportingFromCov(reportingMaps.byWard.get(ward.id)),
            latitude: ward.latitude,
            longitude: ward.longitude,
          };
        }),
        meta: this.buildMeta(page, limit, total),
      },
      partyConfig,
    ) satisfies PaginatedBrowseResult;
  }

  async browseWardsForUser(user: JwtPayload, page = 1, limit = 20, search?: string) {
    if (!this.isScopedToLga(user)) {
      throw new ForbiddenException('This endpoint is for LGA-scoped users');
    }
    return this.browseWards(user, user.scopeId!, page, limit, search);
  }

  async browsePollingUnits(
    user: JwtPayload,
    wardId: string,
    page = 1,
    limit = 20,
    search?: string,
  ) {
    const context = await this.getContext(user);
    const partyConfig = await this.getCampaignPartyConfig(user.campaignId!);
    this.assertCanBrowseLevel(user, CollationLevel.POLLING_UNIT);

    const ward = await this.prisma.ward.findFirst({
      where: {
        id: wardId,
        lga: this.browseGeoFilter(user, context),
      },
      include: { lga: true },
    });
    if (!ward) throw new NotFoundException('Ward not found');
    this.assertSeatAllowsWard(wardId);

    if (this.isScopedToLga(user) && ward.lgaId !== user.scopeId) {
      throw new ForbiddenException('Ward is outside your LGA scope');
    }
    if (this.isScopedToWard(user) && user.scopeId !== wardId) {
      throw new ForbiddenException('You can only browse polling units in your assigned ward');
    }

    const where: Prisma.PollingUnitWhereInput = {
      wardId,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { code: { contains: search, mode: Prisma.QueryMode.insensitive } },
            ],
          }
        : {}),
    };

    if (this.isScopedToPu(user)) {
      where.id = user.scopeId!;
    }

    const [total, pollingUnits] = await Promise.all([
      this.prisma.pollingUnit.count({ where }),
      this.prisma.pollingUnit.findMany({
        where,
        orderBy: { code: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const results = await this.prisma.collationResult.findMany({
      where: {
        campaignId: user.campaignId!,
        contestId: this.contests.id(),
        level: CollationLevel.POLLING_UNIT,
        scopeId: { in: pollingUnits.map((pu) => pu.id) },
      },
    });
    const resultMap = new Map(results.map((r) => [r.scopeId, r]));

    const parent = this.isScopedToWard(user)
      ? undefined
      : this.isScopedToLga(user)
        ? {
            id: ward.lga.id,
            name: 'Ward Results',
            href: '/dashboard/my-lga',
          }
        : {
            id: ward.lga.id,
            name: `${ward.lga.name} LGA`,
            href: `/dashboard/lgas/${ward.lga.id}`,
          };

    return this.withPartyMeta(
      {
        stateName: context.stateName,
        stateId: context.stateId,
        title: ward.name.toUpperCase(),
        subtitle: this.isScopedToWard(user)
          ? `Polling stations · ${ward.lga.name} LGA`
          : `Polling stations · ${ward.lga.name} LGA`,
        level: 'POLLING_UNIT' as const,
        parent,
        data: pollingUnits.map((pu, index) => {
          const result = resultMap.get(pu.id);
          const parties = parsePartyTotals(result?.partyResults, partyConfig.partyColumns);
          const totalVotes = partiesTotal(parties);
          return {
            id: pu.id,
            name: pu.name.toUpperCase(),
            code: pu.code,
            parties,
            totalVotes,
            href: `/dashboard/my-unit?id=${pu.id}`,
            subtitle: pu.code ?? `#${(page - 1) * limit + index + 1}`,
            resultStatus: result?.status ?? (totalVotes > 0 ? 'APPROVED' : 'NOT_STARTED'),
            irevVerification: result ? resolveIrevVerification(result) : null,
            latitude: pu.latitude,
            longitude: pu.longitude,
          };
        }),
        meta: this.buildMeta(page, limit, total),
      },
      partyConfig,
    ) satisfies PaginatedBrowseResult;
  }

  async browsePollingUnitsForUser(
    user: JwtPayload,
    page = 1,
    limit = 20,
    search?: string,
    filters?: { lgaId?: string; wardId?: string; hasResults?: boolean },
  ) {
    const safeLimit = Math.min(100, Math.max(1, limit));
    const safePage = Math.max(1, page);
    const q = search?.trim();
    const searchWhere: Prisma.PollingUnitWhereInput | undefined = q
      ? {
          OR: [
            { name: { contains: q, mode: Prisma.QueryMode.insensitive } },
            { code: { contains: q, mode: Prisma.QueryMode.insensitive } },
            { ward: { name: { contains: q, mode: Prisma.QueryMode.insensitive } } },
            { ward: { lga: { name: { contains: q, mode: Prisma.QueryMode.insensitive } } } },
          ],
        }
      : undefined;

    if (this.isScopedToPu(user)) {
      if (!user.scopeId) {
        throw new ForbiddenException('No polling unit assigned to your account');
      }

      const partyConfig = await this.getCampaignPartyConfig(user.campaignId!);
      const context = await this.getContext(user);

      const pollingUnit = await this.prisma.pollingUnit.findFirst({
        where: {
          id: user.scopeId,
          // Membership already scopes the agent; only pin to campaign.state for
          // single-state campaigns. National campaigns span all 37 states.
          ...(context.isNational
            ? {}
            : { ward: { lga: { stateId: context.stateId } } }),
          ...(searchWhere ?? {}),
        },
        include: { ward: { include: { lga: true } } },
      });

      if (!pollingUnit) {
        throw new NotFoundException('Assigned polling unit not found');
      }

      const result = await this.prisma.collationResult.findFirst({
        where: {
          campaignId: user.campaignId!,
          contestId: this.contests.id(),
          level: CollationLevel.POLLING_UNIT,
          scopeId: pollingUnit.id,
        },
      });

      const parties = parsePartyTotals(result?.partyResults, partyConfig.partyColumns);

      return this.withPartyMeta(
        {
          stateName: context.stateName,
          stateId: context.stateId,
          title: pollingUnit.name.toUpperCase(),
          subtitle: `My polling unit · ${pollingUnit.ward.name} · ${pollingUnit.ward.lga.name} LGA`,
          level: 'POLLING_UNIT' as const,
          parent: undefined,
          data: [
            {
              id: pollingUnit.id,
              name: pollingUnit.name.toUpperCase(),
              code: pollingUnit.code,
              parties,
              totalVotes: Object.values(parties).reduce((sum, n) => sum + n, 0),
              href: `/dashboard/my-unit?id=${pollingUnit.id}`,
              subtitle: `${pollingUnit.ward.name} · ${pollingUnit.ward.lga.name}`,
              resultStatus: result?.status ?? (Object.values(parties).reduce((sum, n) => sum + n, 0) > 0 ? 'APPROVED' : 'NOT_STARTED'),
              irevVerification: result ? resolveIrevVerification(result) : null,
            },
          ],
          meta: this.buildMeta(safePage, safeLimit, 1),
        },
        partyConfig,
      ) satisfies PaginatedBrowseResult;
    }

    if (this.isScopedToWard(user)) {
      return this.browsePollingUnits(user, user.scopeId!, safePage, safeLimit, search);
    }
    if (this.isScopedToLga(user)) {
      const partyConfig = await this.getCampaignPartyConfig(user.campaignId!);
      let where: Prisma.PollingUnitWhereInput = {
        ward: {
          lgaId: user.scopeId!,
          ...(filters?.wardId ? { id: filters.wardId } : {}),
        },
        ...(searchWhere ?? {}),
      };
      where = await this.applyHasResultsFilter(where, user.campaignId!, filters?.hasResults);

      const [total, pollingUnits] = await Promise.all([
        this.prisma.pollingUnit.count({ where }),
        this.prisma.pollingUnit.findMany({
          where,
          orderBy: { code: 'asc' },
          skip: (safePage - 1) * safeLimit,
          take: safeLimit,
          include: { ward: { include: { lga: true } } },
        }),
      ]);

      const results = await this.prisma.collationResult.findMany({
        where: {
          campaignId: user.campaignId!,
          contestId: this.contests.id(),
          level: CollationLevel.POLLING_UNIT,
          scopeId: { in: pollingUnits.map((pu) => pu.id) },
        },
      });
      const resultMap = new Map(results.map((r) => [r.scopeId, r]));
      const context = await this.getContext(user);

      return this.withPartyMeta(
        {
          stateName: context.stateName,
          stateId: context.stateId,
          title: pollingUnits[0]?.ward.lga.name.toUpperCase() ?? 'LGA',
          subtitle: 'Polling stations in your LGA',
          level: 'POLLING_UNIT' as const,
          parent: undefined,
          data: pollingUnits.map((pu) => {
            const result = resultMap.get(pu.id);
            const parties = parsePartyTotals(result?.partyResults, partyConfig.partyColumns);
            const totalVotes = partiesTotal(parties);
            return {
              id: pu.id,
              name: pu.name.toUpperCase(),
              code: pu.code,
              parties,
              totalVotes,
              href: `/dashboard/my-unit?id=${pu.id}`,
              subtitle: pu.ward.name,
              resultStatus: result?.status ?? (totalVotes > 0 ? 'APPROVED' : 'NOT_STARTED'),
              irevVerification: result ? resolveIrevVerification(result) : null,
            };
          }),
          meta: this.buildMeta(safePage, safeLimit, total),
        },
        partyConfig,
      ) satisfies PaginatedBrowseResult;
    }

    if (isCampaignAdminRole(user.role) || user.role === CampaignRole.STATE_COLLATION_OFFICER) {
      const context = await this.getContext(user);
      const partyConfig = await this.getCampaignPartyConfig(user.campaignId!);
      const geo = this.browseGeoFilter(user, context);
      let where: Prisma.PollingUnitWhereInput = {
        ward: {
          lga: geo.stateId ? { stateId: geo.stateId } : {},
          ...(filters?.lgaId ? { lgaId: filters.lgaId } : {}),
          ...(filters?.wardId ? { id: filters.wardId } : {}),
        },
        ...(searchWhere ?? {}),
      };
      where = await this.applyHasResultsFilter(where, user.campaignId!, filters?.hasResults);

      const [total, pollingUnits] = await Promise.all([
        this.prisma.pollingUnit.count({ where }),
        this.prisma.pollingUnit.findMany({
          where,
          orderBy: [{ ward: { lga: { name: 'asc' } } }, { code: 'asc' }],
          skip: (safePage - 1) * safeLimit,
          take: safeLimit,
          include: { ward: { include: { lga: true } } },
        }),
      ]);

      const results = await this.prisma.collationResult.findMany({
        where: {
          campaignId: user.campaignId!,
          contestId: this.contests.id(),
          level: CollationLevel.POLLING_UNIT,
          scopeId: { in: pollingUnits.map((pu) => pu.id) },
        },
      });
      const resultMap = new Map(results.map((r) => [r.scopeId, r]));

      const filterLabel = [
        filters?.lgaId && pollingUnits[0]?.ward.lga.name,
        filters?.wardId && pollingUnits[0]?.ward.name,
      ]
        .filter(Boolean)
        .join(' · ');

      return this.withPartyMeta(
        {
          stateName: context.stateName,
          stateId: context.stateId,
          title: context.stateName,
          subtitle: filterLabel
            ? `Polling stations · ${filterLabel}`
            : filters?.hasResults === true
              ? 'Polling stations with submitted results'
              : filters?.hasResults === false
                ? 'Polling stations not yet started'
                : context.isNational
                  ? 'All polling stations in Nigeria'
                  : 'All polling stations in the campaign state',
          level: 'POLLING_UNIT' as const,
          parent: undefined,
          data: pollingUnits.map((pu) => {
            const result = resultMap.get(pu.id);
            const parties = parsePartyTotals(result?.partyResults, partyConfig.partyColumns);
            return {
              id: pu.id,
              name: pu.name.toUpperCase(),
              code: pu.code,
              parties,
              totalVotes: Object.values(parties).reduce((sum, n) => sum + n, 0),
              href: `/dashboard/my-unit?id=${pu.id}`,
              subtitle: `${pu.ward.name} · ${pu.ward.lga.name}`,
              resultStatus: result?.status ?? 'NOT_STARTED',
              irevVerification: result ? resolveIrevVerification(result) : null,
            };
          }),
          meta: this.buildMeta(safePage, safeLimit, total),
        },
        partyConfig,
      ) satisfies PaginatedBrowseResult;
    }

    throw new ForbiddenException('This endpoint is for ward or LGA scoped users');
  }

  private async applyHasResultsFilter(
    where: Prisma.PollingUnitWhereInput,
    campaignId: string,
    hasResults?: boolean,
  ): Promise<Prisma.PollingUnitWhereInput> {
    if (hasResults === undefined) return where;

    const rows = await this.prisma.collationResult.findMany({
      where: { campaignId, contestId: this.contests.id(), level: CollationLevel.POLLING_UNIT },
      select: { scopeId: true },
    });
    const ids = rows.map((r) => r.scopeId);

    if (hasResults) {
      return {
        AND: [where, { id: { in: ids.length ? ids : ['__none__'] } }],
      };
    }

    return {
      AND: [where, ...(ids.length ? [{ id: { notIn: ids } }] : [])],
    };
  }

  /**
   * Compact map payload for Situation Room markers (no pagination).
   * National: omit filters → states; pass region → states in zone; pass stateId → LGAs;
   * pass lgaId/wardId → wards + PUs.
   */
  async situationMapPoints(
    user: JwtPayload,
    filters: {
      region?: string;
      stateId?: string;
      lgaId?: string;
      wardId?: string;
      includeIncidents?: boolean;
      includeIrevMismatches?: boolean;
    },
  ) {
    const selectedSeat = this.contests.seat();
    if (selectedSeat?.lgaId && !filters.lgaId && !filters.wardId) {
      filters = { ...filters, lgaId: selectedSeat.lgaId };
    }

    if (!filters.lgaId && !filters.wardId) {
      return this.situationMapOverview(user, {
        region: filters.region,
        stateId: filters.stateId,
        includeIncidents: filters.includeIncidents,
        includeIrevMismatches: filters.includeIrevMismatches,
      });
    }

    const context = await this.getContext(user);
    const partyConfig = await this.getCampaignPartyConfig(user.campaignId!);
    this.assertCanBrowseLevel(user, CollationLevel.POLLING_UNIT);

    if (this.isScopedToWard(user)) {
      const assigned = await this.prisma.ward.findUnique({
        where: { id: user.scopeId! },
        select: { id: true, lgaId: true },
      });
      if (!assigned) {
        throw new ForbiddenException('Your account is not assigned to a valid ward');
      }
      if (filters.wardId && filters.wardId !== assigned.id) {
        throw new ForbiddenException('You can only map your assigned ward');
      }
      if (filters.lgaId && filters.lgaId !== assigned.lgaId) {
        throw new ForbiddenException('You can only map your assigned LGA');
      }
      filters = filters.wardId
        ? { wardId: assigned.id, lgaId: assigned.lgaId }
        : { lgaId: assigned.lgaId };
    } else if (this.isScopedToLga(user)) {
      if (filters.lgaId && filters.lgaId !== user.scopeId) {
        throw new ForbiddenException('You can only map your assigned LGA');
      }
      if (filters.wardId) {
        const ward = await this.prisma.ward.findUnique({
          where: { id: filters.wardId },
          select: { lgaId: true },
        });
        if (!ward || ward.lgaId !== user.scopeId) {
          throw new ForbiddenException('That ward is outside your assigned LGA');
        }
      }
      filters = { ...filters, lgaId: user.scopeId! };
    } else if (this.isScopedToPu(user)) {
      throw new ForbiddenException('Polling agents cannot browse the situation map tree');
    } else if (isStateScopedUser(user)) {
      filters = { ...filters, stateId: this.browseGeoFilter(user, context, filters.stateId).stateId };
    }

    let lgaId = filters.lgaId ?? null;
    if (!lgaId && filters.wardId) {
      const parent = await this.prisma.ward.findUnique({
        where: { id: filters.wardId },
        select: { lgaId: true },
      });
      lgaId = parent?.lgaId ?? null;
    }

    const geo = this.browseGeoFilter(user, context, filters.stateId);
    if (geo.stateId && lgaId) {
      const inState = await this.prisma.lGA.findFirst({
        where: { id: lgaId, stateId: geo.stateId },
        select: { id: true },
      });
      if (!inState) {
        throw new ForbiddenException('That local government is outside your assigned state');
      }
    }

    const seat = this.contests.seat();
    if (seat && filters.wardId) {
      this.assertSeatAllowsWard(filters.wardId);
    }
    if (seat?.lgaId) {
      this.assertSeatAllowsLga(seat.lgaId);
      lgaId = seat.lgaId;
    }

    const wardWhere: Prisma.WardWhereInput = filters.wardId
      ? { id: filters.wardId }
      : lgaId
        ? { lgaId }
        : { id: '__none__' };
    if (seat) {
      wardWhere.id = filters.wardId ?? (seat.wardIds.length ? { in: seat.wardIds } : { in: [] });
    }

    const wards = await this.prisma.ward.findMany({
      where: wardWhere,
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        registrationAreaCode: true,
        latitude: true,
        longitude: true,
        lgaId: true,
      },
    });

    const pollingUnits = await this.prisma.pollingUnit.findMany({
      where: { wardId: { in: wards.map((ward) => ward.id) } },
      orderBy: { code: 'asc' },
      take: filters.wardId ? 2500 : 2500,
      select: {
        id: true,
        name: true,
        code: true,
        latitude: true,
        longitude: true,
        wardId: true,
        ward: {
          select: {
            id: true,
            name: true,
            registrationAreaCode: true,
            lgaId: true,
          },
        },
      },
    });

    const lga = lgaId
      ? await this.prisma.lGA.findUnique({
          where: { id: lgaId },
          select: { id: true, name: true },
        })
      : null;

    const contestId = this.contests.current()?.id;
    const [puResults, wardResults, lgaResults] = await Promise.all([
      this.prisma.collationResult.findMany({
        where: {
          campaignId: user.campaignId!,
          ...(contestId ? { contestId } : {}),
          level: CollationLevel.POLLING_UNIT,
          scopeId: { in: pollingUnits.map((pu) => pu.id) },
        },
        select: { scopeId: true, status: true, partyResults: true, irevVerification: true },
      }),
      this.prisma.collationResult.findMany({
        where: {
          campaignId: user.campaignId!,
          ...(contestId ? { contestId } : {}),
          level: CollationLevel.WARD,
          scopeId: { in: wards.map((ward) => ward.id) },
        },
        select: { scopeId: true, status: true, partyResults: true },
      }),
      lgaId
        ? this.prisma.collationResult.findMany({
            where: {
              campaignId: user.campaignId!,
              ...(contestId ? { contestId } : {}),
              level: CollationLevel.LGA,
              scopeId: lgaId,
            },
            select: { scopeId: true, status: true, partyResults: true },
          })
        : Promise.resolve([]),
    ]);
    const resultMap = new Map(puResults.map((r) => [r.scopeId, r]));
    const wardResultMap = new Map(wardResults.map((r) => [r.scopeId, r]));
    const lgaResult = lgaResults[0];
    const officialLgaParties = parsePartyTotals(lgaResult?.partyResults, partyConfig.partyColumns);

    const puApprovedByWard = new Map<string, Record<string, number>>();
    const puSubmittedByWard = new Map<string, Record<string, number>>();
    const puReturnedByWard = new Map<string, Record<string, number>>();
    const pusByWard = new Map<string, typeof pollingUnits>();
    for (const pu of pollingUnits) {
      const list = pusByWard.get(pu.wardId) ?? [];
      list.push(pu);
      pusByWard.set(pu.wardId, list);
      const result = resultMap.get(pu.id);
      if (!result) continue;
      const parties = parsePartyTotals(result.partyResults, partyConfig.partyColumns);
      if (result.status === CollationResultStatus.APPROVED) {
        puApprovedByWard.set(
          pu.wardId,
          addPartyTotals(puApprovedByWard.get(pu.wardId) ?? {}, parties),
        );
      } else if (result.status === CollationResultStatus.SUBMITTED) {
        puSubmittedByWard.set(
          pu.wardId,
          addPartyTotals(puSubmittedByWard.get(pu.wardId) ?? {}, parties),
        );
      } else if (result.status === CollationResultStatus.REJECTED) {
        puReturnedByWard.set(
          pu.wardId,
          addPartyTotals(puReturnedByWard.get(pu.wardId) ?? {}, parties),
        );
      }
    }

    const approvedLgaFromPus: Record<string, number> = {};
    const submittedLgaFromPus: Record<string, number> = {};
    const returnedLgaFromPus: Record<string, number> = {};
    for (const parties of puApprovedByWard.values()) {
      addPartyTotals(approvedLgaFromPus, parties);
    }
    for (const parties of puSubmittedByWard.values()) {
      addPartyTotals(submittedLgaFromPus, parties);
    }
    for (const parties of puReturnedByWard.values()) {
      addPartyTotals(returnedLgaFromPus, parties);
    }
    const lgaSelection = unapprovedMapSelection(
      partiesTotal(officialLgaParties) > 0 ? officialLgaParties : approvedLgaFromPus,
      submittedLgaFromPus,
      returnedLgaFromPus,
    );

    const [incidentStats, reportingMaps, approvalByLga, puPulse, wardPulse, lgaPulse, irevMismatchMaps] =
      await Promise.all([
        this.aggregateIncidentsByScope(user.campaignId!, {
          wardIds: wards.map((ward) => ward.id),
          pollingUnitIds: pollingUnits.map((pu) => pu.id),
          lgaIds: lgaId ? [lgaId] : [],
        }),
        this.loadPuReportingMaps(
          user.campaignId!,
          [...new Set(wards.map((ward) => ward.lgaId))],
        ),
        lgaId
          ? this.readinessService.loadApprovalPipelineByLga(user.campaignId!, [lgaId])
          : Promise.resolve(new Map()),
        this.pulseGeo.fieldsByPollingUnit(
          user.campaignId!,
          pollingUnits.map((pu) => pu.id),
        ),
        this.pulseGeo.fieldsByWard(
          user.campaignId!,
          wards.map((ward) => ward.id),
        ),
        lgaId
          ? this.pulseGeo.fieldsByLga(user.campaignId!, [lgaId])
          : Promise.resolve(new Map()),
        this.loadIrevMismatchMaps(
          user.campaignId!,
          [...new Set(wards.map((ward) => ward.lgaId))],
        ),
      ]);

    const mapIncidents =
      filters.includeIncidents && lgaId
        ? await this.listMapIncidents(user.campaignId!, {
            lgaIds: [lgaId],
            wardIds: wards.map((w) => w.id),
          })
        : undefined;
    const mapIrevMismatches = filters.includeIrevMismatches
      ? await this.listMapIrevMismatches(
          user.campaignId!,
          {
            lgaIds: lgaId ? [lgaId] : [],
            wardIds: filters.wardId ? [filters.wardId] : wards.map((w) => w.id),
          },
          filters.wardId ? 200 : 80,
        )
      : undefined;

    return this.withPartyMeta(
      {
        mode: 'detail' as const,
        geographyLevel: filters.wardId ? ('WARD' as const) : ('LGA' as const),
        lgaId,
        wardId: filters.wardId ?? null,
        lgas: lga
          ? [
              this.mapOutcomeRow({
                id: lga.id,
                name: lga.name.toUpperCase(),
                parties: lgaSelection.parties,
                partyColumns: partyConfig.partyColumns,
                clientPartyCode: partyConfig.clientPartyCode,
                resultStatus: lgaResult?.status ?? lgaSelection.resultStatus,
                pendingValidation: lgaSelection.pendingValidation,
                href: `/dashboard/lgas/${lga.id}`,
                incidentCount: incidentStats.byLga.get(lga.id)?.count ?? 0,
                incidentUrgentCount: incidentStats.byLga.get(lga.id)?.urgent ?? 0,
                incidentWeight: incidentStats.byLga.get(lga.id)?.weight ?? 0,
                maxSeverity: incidentStats.byLga.get(lga.id)?.maxSeverity ?? null,
                reporting: this.buildReportingFromCov(reportingMaps.byLga.get(lga.id)),
                lastResultAt: reportingMaps.byLga.get(lga.id)?.lastAt?.toISOString() ?? null,
                approval: approvalByLga.get(lga.id),
                velocity: computeScopeVelocity(
                  reportingMaps.puResults,
                  reportingMaps.puByLga.get(lga.id) ?? new Set(),
                ),
                delayed: computeDelayedPollingUnits(
                  reportingMaps.puResults,
                  [...(reportingMaps.puByLga.get(lga.id) ?? [])],
                ),
                irevMismatchCount: irevMismatchMaps.byLga.get(lga.id) ?? 0,
                ...this.pulseFields(lgaPulse.get(lga.id)),
              }),
            ]
          : [],
        wards: wards.map((ward) => {
          const result = wardResultMap.get(ward.id);
          const officialParties = parsePartyTotals(result?.partyResults, partyConfig.partyColumns);
          const approvedFromPus = puApprovedByWard.get(ward.id) ?? {};
          const submittedFromPus = puSubmittedByWard.get(ward.id) ?? {};
          const returnedFromPus = puReturnedByWard.get(ward.id) ?? {};
          const selection = unapprovedMapSelection(
            partiesTotal(officialParties) > 0 ? officialParties : approvedFromPus,
            submittedFromPus,
            returnedFromPus,
          );
          const incidents = incidentStats.byWard.get(ward.id) ?? emptyIncidentBucket();
          const cov = reportingMaps.byWard.get(ward.id);
          const wardPuIds = reportingMaps.puByWard.get(ward.id) ?? new Set<string>();
          const coords =
            ward.latitude != null && ward.longitude != null
              ? { latitude: ward.latitude, longitude: ward.longitude }
              : averageCoords(pusByWard.get(ward.id) ?? []);
          return this.mapOutcomeRow({
            id: ward.id,
            name: ward.name.toUpperCase(),
            code: ward.registrationAreaCode ?? undefined,
            parties: selection.parties,
            partyColumns: partyConfig.partyColumns,
            clientPartyCode: partyConfig.clientPartyCode,
            resultStatus: result?.status ?? selection.resultStatus,
            pendingValidation: selection.pendingValidation,
            latitude: coords?.latitude ?? null,
            longitude: coords?.longitude ?? null,
            href: `/dashboard/wards/${ward.id}`,
            incidentCount: incidents.count,
            incidentUrgentCount: incidents.urgent,
            incidentWeight: incidents.weight,
            maxSeverity: incidents.maxSeverity,
            reporting: this.buildReportingFromCov(cov),
            lastResultAt: cov?.lastAt?.toISOString() ?? null,
            velocity: computeScopeVelocity(reportingMaps.puResults, wardPuIds),
            delayed: computeDelayedPollingUnits(reportingMaps.puResults, [...wardPuIds]),
            irevMismatchCount: irevMismatchMaps.byWard.get(ward.id) ?? 0,
            ...this.pulseFields(wardPulse.get(ward.id)),
          });
        }),
        pollingUnits: pollingUnits.map((pu) => {
          const result = resultMap.get(pu.id);
          const parties = parsePartyTotals(result?.partyResults, partyConfig.partyColumns);
          const incidents = incidentStats.byPu.get(pu.id) ?? emptyIncidentBucket();
          const hasResult =
            result?.status === CollationResultStatus.SUBMITTED ||
            result?.status === CollationResultStatus.APPROVED ||
            result?.status === CollationResultStatus.REJECTED;
          return {
            ...this.mapOutcomeRow({
              id: pu.id,
              name: pu.name.toUpperCase(),
              code: pu.code,
              parties,
              partyColumns: partyConfig.partyColumns,
              clientPartyCode: partyConfig.clientPartyCode,
              resultStatus: result?.status ?? (partiesTotal(parties) > 0 ? 'APPROVED' : 'NOT_STARTED'),
              pendingValidation:
                result?.status === CollationResultStatus.SUBMITTED ||
                result?.status === CollationResultStatus.REJECTED,
              latitude: pu.latitude,
              longitude: pu.longitude,
              href: `/dashboard/my-unit?id=${pu.id}`,
              incidentCount: incidents.count,
              incidentUrgentCount: incidents.urgent,
              incidentWeight: incidents.weight,
              maxSeverity: incidents.maxSeverity,
              reporting: this.reportingStats(1, hasResult ? 1 : 0, result?.status === CollationResultStatus.APPROVED ? 1 : 0),
              irevMismatchCount: isIrevQaMismatch(result?.irevVerification) ? 1 : 0,
              ...this.pulseFields(puPulse.get(pu.id)),
            }),
            wardId: pu.wardId,
            wardName: pu.ward.name.toUpperCase(),
            registrationAreaCode: pu.ward.registrationAreaCode ?? undefined,
          };
        }),
        incidents: mapIncidents,
        irevMismatches: mapIrevMismatches,
      },
      partyConfig,
    );
  }

  /** Statewide LGA choropleth payload for Situation Room. */
  async situationMapOverview(
    user: JwtPayload,
    filters: {
      region?: string;
      stateId?: string;
      includeIncidents?: boolean;
      includeIrevMismatches?: boolean;
    } = {},
  ) {
    const context = await this.getContext(user);
    const partyConfig = await this.getCampaignPartyConfig(user.campaignId!);
    this.assertCanBrowseLevel(user, CollationLevel.LGA);

    if (this.isScopedToWard(user) || this.isScopedToPu(user)) {
      throw new ForbiddenException('Insufficient scope for statewide situation map');
    }

    const lgaScopeId = getLgaScopeId(user);
    if (lgaScopeId) {
      const assigned = await this.prisma.lGA.findUnique({
        where: { id: lgaScopeId },
        select: { stateId: true },
      });
      if (!assigned) {
        throw new ForbiddenException('Your account is not assigned to a valid LGA');
      }
      if (filters.stateId && filters.stateId !== assigned.stateId) {
        throw new ForbiddenException('You can only map your assigned state');
      }
      filters = { ...filters, stateId: assigned.stateId };
    }

    if (context.isNational && !filters.stateId) {
      const cacheKey = nationalMapCacheKey(
        user.campaignId!,
        filters.region,
        filters.includeIncidents,
        filters.includeIrevMismatches,
      );
      const cached = await this.redis.getJson(cacheKey);
      if (cached) return cached as never;

      const states = await this.prisma.state.findMany({
        where: filters.region ? { zone: filters.region } : {},
        orderBy: { name: 'asc' },
        select: { id: true, name: true, code: true, zone: true },
      });
      const stateIds = states.map((s) => s.id);

      // SQL rollups only — never materialize ~176k PU rows on the national map.
      const [results, reportingByState, approvalByState, incidentByState, velocityByState, pulseByState, irevByState, irevMismatches] =
        await Promise.all([
          this.prisma.collationResult.findMany({
            where: {
              campaignId: user.campaignId!,
              contestId: this.contests.id(),
              level: CollationLevel.STATE,
              scopeId: { in: stateIds },
            },
            select: { scopeId: true, status: true, partyResults: true },
          }),
          this.loadPuReportingByState(user.campaignId!, stateIds),
          this.readinessService.loadApprovalPipelineByState(user.campaignId!, stateIds),
          this.aggregateIncidentsByState(user.campaignId!, stateIds),
          this.loadPuVelocityByState(user.campaignId!, stateIds),
          this.pulseGeo.fieldsByState(user.campaignId!, stateIds),
          this.loadIrevMismatchRollups(user.campaignId!, { stateIds }),
          filters.includeIrevMismatches
            ? this.listMapIrevMismatches(user.campaignId!, { stateIds })
            : Promise.resolve(undefined),
        ]);
      const resultMap = new Map(results.map((r) => [r.scopeId, r]));
      const pendingStateIds = stateIds.filter((id) => {
        const cov = reportingByState.get(id);
        return (cov?.approved ?? 0) === 0 && (cov?.reported ?? 0) > 0;
      });
      const unapprovedByState = await this.loadUnapprovedPuPartiesByState(
        user.campaignId!,
        pendingStateIds,
        partyConfig.partyColumns,
      );

      const payload = this.withPartyMeta(
        {
          mode: 'overview' as const,
          geographyLevel: 'STATE' as const,
          region: filters.region ?? null,
          stateId: null,
          lgaId: null,
          wardId: null,
          lgas: states.map((state) => {
            const result = resultMap.get(state.id);
            const official = parsePartyTotals(result?.partyResults, partyConfig.partyColumns);
            const selection = unapprovedMapSelection(
              official,
              unapprovedByState.get(state.id)?.submitted ?? {},
              unapprovedByState.get(state.id)?.returned ?? {},
            );
            const cov = reportingByState.get(state.id) ?? {
              total: 0,
              reported: 0,
              approved: 0,
              lastAt: null as Date | null,
            };
            const incidents = incidentByState.get(state.id) ?? emptyIncidentBucket();
            const approval = approvalByState.get(state.id);
            const velocity = velocityByState.get(state.id);
            return {
              ...this.mapOutcomeRow({
                id: state.id,
                name: state.name.toUpperCase(),
                code: state.code,
                parties: selection.parties,
                partyColumns: partyConfig.partyColumns,
                clientPartyCode: partyConfig.clientPartyCode,
                resultStatus: result?.status ?? selection.resultStatus,
                pendingValidation: selection.pendingValidation,
                href: `/dashboard/lgas?stateId=${state.id}`,
                incidentCount: incidents.count,
                incidentUrgentCount: incidents.urgent,
                incidentWeight: incidents.weight,
                maxSeverity: incidents.maxSeverity,
                reporting: this.reportingStats(cov.total, cov.reported, cov.approved),
                lastResultAt: cov.lastAt?.toISOString() ?? null,
                approval,
                velocity,
                irevMismatchCount: irevByState.byState.get(state.id) ?? 0,
                ...this.pulseFields(pulseByState.get(state.id)),
              }),
              zone: state.zone,
            };
          }),
          wards: [],
          pollingUnits: [],
          incidents: filters.includeIncidents
            ? await this.listMapIncidents(user.campaignId!, { stateIds })
            : undefined,
          irevMismatches,
        },
        partyConfig,
      );
      await this.redis.setJson(cacheKey, payload, NATIONAL_SITUATION_CACHE_TTL_SEC);
      return payload;
    }

    const drillStateId = this.browseGeoFilter(user, context, filters.stateId).stateId;
    const where: Prisma.LGAWhereInput = {
      stateId: drillStateId || context.stateId,
    };

    const lgas = await this.prisma.lGA.findMany({
      where,
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });

    const results = await this.prisma.collationResult.findMany({
      where: {
        campaignId: user.campaignId!,
        contestId: this.contests.id(),
        level: CollationLevel.LGA,
        scopeId: { in: lgas.map((l) => l.id) },
      },
      select: { scopeId: true, status: true, partyResults: true },
    });
    const resultMap = new Map(results.map((r) => [r.scopeId, r]));

    const lgaIdsList = lgas.map((l) => l.id);

    const [incidentStats, reportingMaps, approvalByLga, pulseByLga, irevMismatchMaps, irevMismatches] =
      await Promise.all([
      this.aggregateIncidentsByScope(user.campaignId!, {
        lgaIds: lgaIdsList,
      }),
      this.loadPuReportingMaps(user.campaignId!, lgaIdsList),
      this.readinessService.loadApprovalPipelineByLga(user.campaignId!, lgaIdsList),
      this.pulseGeo.fieldsByLga(user.campaignId!, lgaIdsList),
      this.loadIrevMismatchMaps(user.campaignId!, lgaIdsList),
      filters.includeIrevMismatches
        ? this.listMapIrevMismatches(user.campaignId!, { lgaIds: lgaIdsList })
        : Promise.resolve(undefined),
    ]);

    return this.withPartyMeta(
      {
        mode: 'overview' as const,
        geographyLevel: 'LGA' as const,
        stateId: drillStateId || context.stateId,
        lgaId: null,
        wardId: null,
        lgas: lgas.map((lga) => {
          const result = resultMap.get(lga.id);
          const official = parsePartyTotals(result?.partyResults, partyConfig.partyColumns);
          const incidents = incidentStats.byLga.get(lga.id) ?? emptyIncidentBucket();
          const cov = reportingMaps.byLga.get(lga.id);
          const approval = approvalByLga.get(lga.id);
          const puIds = reportingMaps.puByLga.get(lga.id) ?? new Set<string>();
          const approvedFromPus =
            partiesTotal(official) > 0
              ? official
              : sumPuPartiesByStatus(
                  reportingMaps.puResults,
                  puIds,
                  CollationResultStatus.APPROVED,
                  partyConfig.partyColumns,
                );
          const submittedFromPus = sumPuPartiesByStatus(
            reportingMaps.puResults,
            puIds,
            CollationResultStatus.SUBMITTED,
            partyConfig.partyColumns,
          );
          const returnedFromPus = sumPuPartiesByStatus(
            reportingMaps.puResults,
            puIds,
            CollationResultStatus.REJECTED,
            partyConfig.partyColumns,
          );
          const selection = unapprovedMapSelection(approvedFromPus, submittedFromPus, returnedFromPus);
          return this.mapOutcomeRow({
            id: lga.id,
            name: lga.name.toUpperCase(),
            parties: selection.parties,
            partyColumns: partyConfig.partyColumns,
            clientPartyCode: partyConfig.clientPartyCode,
            resultStatus: result?.status ?? selection.resultStatus,
            pendingValidation: selection.pendingValidation,
            href: `/dashboard/lgas/${lga.id}`,
            incidentCount: incidents.count,
            incidentUrgentCount: incidents.urgent,
            incidentWeight: incidents.weight,
            maxSeverity: incidents.maxSeverity,
            reporting: this.buildReportingFromCov(cov),
            lastResultAt: cov?.lastAt?.toISOString() ?? null,
            approval,
            velocity: computeScopeVelocity(reportingMaps.puResults, puIds),
            delayed: computeDelayedPollingUnits(
              reportingMaps.puResults,
              [...puIds],
            ),
            irevMismatchCount: irevMismatchMaps.byLga.get(lga.id) ?? 0,
            ...this.pulseFields(pulseByLga.get(lga.id)),
          });
        }),
        wards: [],
        pollingUnits: [],
        incidents: filters.includeIncidents
          ? await this.listMapIncidents(user.campaignId!, { lgaIds: lgaIdsList })
          : undefined,
        irevMismatches,
      },
      partyConfig,
    );
  }

  /** Situation Room race board: statewide party race, LGA outcomes, reporting coverage. */
  async getRaceAnalytics(user: JwtPayload) {
    const context = await this.getContext(user);
    const partyConfig = await this.getCampaignPartyConfig(user.campaignId!);
    this.assertCanBrowseLevel(user, CollationLevel.LGA);

    if (this.isScopedToWard(user) || this.isScopedToPu(user)) {
      throw new ForbiddenException('Race analytics requires LGA or higher scope');
    }

    const geo = this.browseGeoFilter(user, context);
    const stateLocked = Boolean(geo.stateId) || isStateScopedUser(user);
    const lgaLocked = this.isScopedToLga(user);
    const nationalScope = context.isNational && !stateLocked && !lgaLocked;
    const raceCacheKey = nationalScope ? nationalRaceCacheKey(user.campaignId!) : null;
    if (raceCacheKey) {
      const cached = await this.redis.getJson(raceCacheKey);
      if (cached) return cached as never;
    }
    const lgaWhere: Prisma.LGAWhereInput = geo.stateId
      ? { stateId: geo.stateId }
      : context.isNational && !lgaLocked
        ? {}
        : { stateId: context.stateId };
    if (lgaLocked) lgaWhere.id = user.scopeId!;

    const nationalStates = nationalScope
      ? await this.prisma.state.findMany({
          orderBy: { name: 'asc' },
          select: { id: true, name: true, code: true, zone: true },
        })
      : [];

    const lgas = nationalScope
      ? nationalStates.map((state) => ({
          id: state.id,
          name: state.name,
          // Geopolitical zone, so regional roll-ups come from the database
          // rather than from whoever is reading the numbers.
          zone: state.zone ?? null,
          senatorialDistrictId: null as string | null,
          senatorialDistrict: { id: state.id, name: state.code },
        }))
      : (
          await this.prisma.lGA.findMany({
            where: lgaWhere,
            orderBy: { name: 'asc' },
            select: {
              id: true,
              name: true,
              senatorialDistrictId: true,
              senatorialDistrict: { select: { id: true, name: true } },
            },
          })
        ).map((lga) => ({ ...lga, zone: null as string | null }));
    const lgaIds = lgas.map((l) => l.id);

    const [lgaResults, reportingMaps, openIncidents, urgentIncidents, approvalByLga, incidentByLga, irevMismatchMaps, irevMismatchTotal, irevAttention] =
      await Promise.all([
      this.prisma.collationResult.findMany({
        where: {
          campaignId: user.campaignId!,
          contestId: this.contests.id(),
          level: nationalScope ? CollationLevel.STATE : CollationLevel.LGA,
          scopeId: { in: lgaIds },
        },
        select: { scopeId: true, status: true, partyResults: true, votesCast: true },
      }),
      nationalScope
        ? this.loadPuReportingByState(user.campaignId!, lgaIds).then((byState) => ({
            byLga: byState,
            byWard: new Map(),
            puByLga: new Map<string, Set<string>>(),
            puByWard: new Map<string, Set<string>>(),
            puResults: [] as Array<{
              scopeId: string;
              status: string;
              submittedAt: Date | null;
              approvedAt: Date | null;
              createdAt: Date;
              partyResults?: unknown;
            }>,
          }))
        : this.loadPuReportingMaps(user.campaignId!, lgaIds),
      this.prisma.fieldReport.count({
        where: {
          campaignId: user.campaignId!,
          type: { in: [FieldReportType.INCIDENT, FieldReportType.SECURITY_CONCERN] },
          status: { not: 'RESOLVED' },
          OR: [
            { ward: { lgaId: { in: lgaIds } } },
            { pollingUnit: { ward: { lgaId: { in: lgaIds } } } },
          ],
        },
      }),
      this.prisma.fieldReport.count({
        where: {
          campaignId: user.campaignId!,
          type: { in: [FieldReportType.INCIDENT, FieldReportType.SECURITY_CONCERN] },
          status: { not: 'RESOLVED' },
          OR: [{ isUrgent: true }, { incidentSeverity: { in: ['HIGH', 'CRITICAL'] } }],
          AND: [
            {
              OR: [
                { ward: { lgaId: { in: lgaIds } } },
                { pollingUnit: { ward: { lgaId: { in: lgaIds } } } },
              ],
            },
          ],
        },
      }),
      nationalScope
        ? Promise.resolve(new Map())
        : this.readinessService.loadApprovalPipelineByLga(user.campaignId!, lgaIds),
      nationalScope
        ? Promise.resolve(new Map<string, IncidentBucket>())
        : this.aggregateIncidentsByScope(user.campaignId!, { lgaIds }).then((s) => s.byLga),
      nationalScope
        ? this.loadIrevMismatchRollups(user.campaignId!, { stateIds: lgaIds }).then((maps) => ({
            byLga: maps.byState,
            byWard: maps.byWard,
          }))
        : this.loadIrevMismatchMaps(user.campaignId!, lgaIds),
      this.countIrevQaMismatches(user.campaignId!),
      this.loadIrevAttentionSummary(
        user.campaignId!,
        partyConfig.clientPartyCode,
        partyConfig.partyColumns,
      ),
    ]);

    const puTotal = [...reportingMaps.byLga.values()].reduce((sum, r) => sum + r.total, 0);
    const puWithResult = [...reportingMaps.byLga.values()].reduce(
      (sum, r) => sum + r.reported,
      0,
    );

    const windowMinutes = 15;
    const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);
    let newlyReported = 0;
    let newlyApproved = 0;
    for (const row of reportingMaps.puResults) {
      const reportedAt = row.submittedAt ?? row.createdAt;
      if (reportedAt >= windowStart) newlyReported += 1;
      if (row.approvedAt && row.approvedAt >= windowStart) newlyApproved += 1;
    }

    const resultByLga = new Map(lgaResults.map((r) => [r.scopeId, r]));
    const puResultById = new Map(reportingMaps.puResults.map((r) => [r.scopeId, r]));
    const puPartiesByLga = new Map<string, Record<string, number>>();
    for (const [lgaId, puIds] of reportingMaps.puByLga.entries()) {
      const parties = emptyPartyTotals(partyConfig.partyColumns);
      for (const puId of puIds) {
        const puResult = puResultById.get(puId);
        if (!puResult || puResult.status !== CollationResultStatus.APPROVED) continue;
        addPartyTotals(
          parties,
          parsePartyTotals(
            'partyResults' in puResult ? puResult.partyResults : null,
            partyConfig.partyColumns,
          ),
        );
      }
      puPartiesByLga.set(lgaId, parties);
    }
    const partyTotals = emptyPartyTotals(partyConfig.partyColumns);
    const lgaRows: Array<{
      id: string;
      name: string;
      parties: Record<string, number>;
      totalVotes: number;
      clientVotes: number;
      margin: number;
      outcome: 'WIN' | 'LOSS' | 'TIE' | 'PENDING';
      operationalStatus: OperationalStatus;
      leadingParty: string | null;
      resultStatus: string;
      share: number;
      reporting: ScopeReporting;
      approval?: ApprovalPipeline;
      velocity?: ScopeVelocity;
      incidentCount: number;
      incidentUrgentCount: number;
      lastResultAt: string | null;
      senatorialDistrictId: string | null;
      senatorialDistrictName: string | null;
      zone: string | null;
      irevMismatchCount?: number;
    }> = [];

    let wins = 0;
    let losses = 0;
    let ties = 0;
    let pending = 0;

    for (const lga of lgas) {
      const result = resultByLga.get(lga.id);
      let parties = parsePartyTotals(result?.partyResults, partyConfig.partyColumns);
      if (partiesTotal(parties) <= 0) {
        parties = puPartiesByLga.get(lga.id) ?? parties;
      }
      const totalVotes = Object.values(parties).reduce((sum, n) => sum + n, 0);
      for (const code of partyConfig.partyColumns) {
        partyTotals[code] = (partyTotals[code] ?? 0) + (parties[code] ?? 0);
      }
      const { outcome, leadingParty, margin } = computeOutcome(
        parties,
        partyConfig.partyColumns,
        partyConfig.clientPartyCode,
      );
      const clientVotes = partyConfig.clientPartyCode
        ? (parties[partyConfig.clientPartyCode] ?? 0)
        : 0;
      if (outcome === 'WIN') wins += 1;
      else if (outcome === 'LOSS') losses += 1;
      else if (outcome === 'TIE') ties += 1;
      else pending += 1;

      const cov = reportingMaps.byLga.get(lga.id) ?? { total: 0, reported: 0, approved: 0, lastAt: null };
      const incidents = incidentByLga.get(lga.id) ?? emptyIncidentBucket();
      const approval = approvalByLga.get(lga.id);
      const reporting = this.reportingStats(
        cov.total,
        cov.reported,
        'approved' in cov ? cov.approved : 0,
      );
      const operationalStatus = computeOperationalStatus({
        outcome,
        margin,
        totalVotes,
        percentSubmitted: reporting.percentSubmitted,
        incidentUrgentCount: incidents.urgent,
        incidentCount: incidents.count,
        maxSeverity: incidents.maxSeverity,
        approval,
      });
      const puIds = reportingMaps.puByLga?.get(lga.id) ?? new Set<string>();

      lgaRows.push({
        id: lga.id,
        name: lga.name.toUpperCase(),
        parties,
        totalVotes,
        clientVotes,
        margin,
        outcome,
        operationalStatus,
        leadingParty,
        resultStatus: result?.status ?? 'NOT_STARTED',
        share:
          totalVotes > 0 && partyConfig.clientPartyCode
            ? Math.round((clientVotes / totalVotes) * 1000) / 10
            : 0,
        reporting,
        approval,
        velocity: reportingMaps.puResults.length
          ? computeScopeVelocity(reportingMaps.puResults, puIds)
          : undefined,
        incidentCount: incidents.count,
        incidentUrgentCount: incidents.urgent,
        irevMismatchCount: irevMismatchMaps.byLga.get(lga.id) ?? 0,
        lastResultAt: cov.lastAt?.toISOString() ?? null,
        senatorialDistrictId: lga.senatorialDistrictId ?? lga.senatorialDistrict?.id ?? null,
        senatorialDistrictName: lga.senatorialDistrict?.name ?? null,
        zone: lga.zone ?? null,
      });
    }

    const statewideTotal = Object.values(partyTotals).reduce((sum, n) => sum + n, 0);
    const clientCode =
      partyConfig.clientPartyCode ?? this.deploymentScope.clientPartyCode() ?? 'APC';
    const clientVotes = partyTotals[clientCode] ?? 0;
    const rankedParties = partyConfig.partyColumns
      .map((code) => ({
        code,
        name: partyConfig.trackedParties.find((p) => p.code === code)?.name ?? code,
        votes: partyTotals[code] ?? 0,
        share:
          statewideTotal > 0
            ? Math.round(((partyTotals[code] ?? 0) / statewideTotal) * 1000) / 10
            : 0,
      }))
      .sort((a, b) => b.votes - a.votes);

    const rival = rankedParties.find((p) => p.code !== clientCode);
    const raceLead = clientVotes - (rival?.votes ?? 0);

    const biggestLeads = [...lgaRows]
      .filter((r) => r.outcome === 'WIN')
      .sort((a, b) => b.margin - a.margin)
      .slice(0, 8);
    const biggestDeficits = [...lgaRows]
      .filter((r) => r.outcome === 'LOSS')
      .sort((a, b) => b.margin - a.margin)
      .slice(0, 8);
    const closestRaces = [...lgaRows]
      .filter((r) => r.outcome !== 'PENDING' && r.totalVotes > 0)
      .sort((a, b) => Math.abs(a.margin) - Math.abs(b.margin))
      .slice(0, 8);

    const reportingPct = puTotal > 0 ? Math.round((puWithResult / puTotal) * 1000) / 10 : 0;

    const racePayload = this.withPartyMeta(
      {
        stateName: lgaLocked && context.lgaName ? context.lgaName : context.stateName,
        stateId: context.stateId,
        geographyLevel: nationalScope ? 'STATE' : 'LGA',
        unitLabel: nationalScope ? 'States' : 'LGAs',
        clientPartyCode: clientCode,
        summary: {
          lgaCount: lgas.length,
          wins,
          losses,
          ties,
          pending,
          statewideTotalVotes: statewideTotal,
          clientVotes,
          raceLead,
          rivalCode: rival?.code ?? null,
          rivalVotes: rival?.votes ?? 0,
          reporting: {
            pollingUnitsTotal: puTotal,
            pollingUnitsReported: puWithResult,
            percent: reportingPct,
          },
          velocity: {
            windowMinutes,
            newlyReported,
            newlyApproved,
          },
          incidents: {
            open: openIncidents,
            urgent: urgentIncidents,
          },
          irevMismatches: irevMismatchTotal,
          irevAttention,
        },
        partyStandings: rankedParties,
        lgas: lgaRows.sort((a, b) => a.name.localeCompare(b.name)),
        biggestLeads,
        biggestDeficits,
        closestRaces,
      },
      partyConfig,
    );
    if (raceCacheKey) {
      await this.redis.setJson(raceCacheKey, racePayload, NATIONAL_SITUATION_CACHE_TTL_SEC);
    }
    return racePayload;
  }

  private mapOutcomeRow(input: {
    id: string;
    name: string;
    code?: string;
    parties: Record<string, number>;
    partyColumns: string[];
    clientPartyCode?: string | null;
    resultStatus?: string;
    latitude?: number | null;
    longitude?: number | null;
    href?: string;
    incidentCount: number;
    incidentUrgentCount: number;
    incidentWeight: number;
    maxSeverity: string | null;
    reporting?: ScopeReporting;
    lastResultAt?: string | null;
    approval?: ApprovalPipeline;
    velocity?: ScopeVelocity;
    delayed?: { count: number; thresholdMinutes: number };
    pendingValidation?: boolean;
    phase?: string | null;
    silent?: boolean;
    silentCount?: number;
    pulseTotal?: number;
    rivalHeavyCount?: number;
    rivalMobilization?: string | null;
    whoLooksAhead?: string | null;
    hasObserved?: boolean;
    irevMismatchCount?: number;
  }) {
    const totalVotes = Object.values(input.parties).reduce((sum, n) => sum + n, 0);
    const { outcome, leadingParty, margin } = computeOutcome(
      input.parties,
      input.partyColumns,
      input.clientPartyCode,
    );
    const operationalStatus = computeOperationalStatus({
      outcome,
      margin,
      totalVotes,
      percentSubmitted: input.reporting?.percentSubmitted ?? input.reporting?.percent ?? 0,
      incidentUrgentCount: input.incidentUrgentCount,
      incidentCount: input.incidentCount,
      maxSeverity: input.maxSeverity,
      approval: input.approval,
    });
    return {
      id: input.id,
      name: input.name,
      code: input.code,
      parties: input.parties,
      totalVotes,
      resultStatus: input.resultStatus,
      pendingValidation: Boolean(input.pendingValidation),
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      href: input.href,
      outcome,
      leadingParty,
      margin,
      operationalStatus,
      incidentCount: input.incidentCount,
      incidentUrgentCount: input.incidentUrgentCount,
      incidentWeight: input.incidentWeight,
      maxSeverity: input.maxSeverity,
      reporting: input.reporting,
      approval: input.approval,
      velocity: input.velocity,
      delayed: input.delayed,
      lastResultAt: input.lastResultAt ?? null,
      phase: input.phase ?? null,
      silent: input.silent ?? false,
      silentCount: input.silentCount ?? 0,
      pulseTotal: input.pulseTotal ?? 0,
      rivalHeavyCount: input.rivalHeavyCount ?? 0,
      rivalMobilization: input.rivalMobilization ?? null,
      whoLooksAhead: input.whoLooksAhead ?? null,
      hasObserved: input.hasObserved ?? false,
      irevMismatchCount: input.irevMismatchCount ?? 0,
    };
  }

  private async loadIrevMismatchMaps(campaignId: string, lgaIds: string[]) {
    const maps = await this.loadIrevMismatchRollups(campaignId, { lgaIds });
    return { byLga: maps.byLga, byWard: maps.byWard };
  }

  private async countIrevQaMismatches(campaignId: string) {
    const rows = await this.prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM collation_results cr
      WHERE cr."campaignId" = ${campaignId}
        AND cr.level = 'POLLING_UNIT'::"CollationLevel"
        AND cr."irevVerification" IS NOT NULL
        AND (
          cr."irevVerification"#>>'{status}' IN ('MISMATCH', 'REPLACED')
          OR cr."irevVerification"#>>'{recommendation}' = 'INVESTIGATE'
        )
    `;
    return rows[0]?.count ?? 0;
  }

  /** SQL rollup of IReV QA mismatches — never materializes every PU row. */
  private async loadIrevMismatchRollups(
    campaignId: string,
    scope: { stateIds?: string[]; lgaIds?: string[] },
  ) {
    const byState = new Map<string, number>();
    const byLga = new Map<string, number>();
    const byWard = new Map<string, number>();
    const stateIds = scope.stateIds ?? [];
    const lgaIds = scope.lgaIds ?? [];
    if (!stateIds.length && !lgaIds.length) return { byState, byLga, byWard };

    const geoFilter = stateIds.length
      ? Prisma.sql`AND l."stateId" IN (${Prisma.join(stateIds)})`
      : Prisma.sql`AND w."lgaId" IN (${Prisma.join(lgaIds)})`;

    const rows = await this.prisma.$queryRaw<
      Array<{ stateId: string; lgaId: string; wardId: string; count: number }>
    >`
      SELECT l."stateId" AS "stateId",
             w."lgaId" AS "lgaId",
             p."wardId" AS "wardId",
             COUNT(*)::int AS count
      FROM collation_results cr
      INNER JOIN polling_units p ON p.id = cr."scopeId"
      INNER JOIN wards w ON w.id = p."wardId"
      INNER JOIN lgas l ON l.id = w."lgaId"
      WHERE cr."campaignId" = ${campaignId}
        AND cr.level = 'POLLING_UNIT'::"CollationLevel"
        AND cr."irevVerification" IS NOT NULL
        AND (
          cr."irevVerification"#>>'{status}' IN ('MISMATCH', 'REPLACED')
          OR cr."irevVerification"#>>'{recommendation}' = 'INVESTIGATE'
        )
        ${geoFilter}
      GROUP BY l."stateId", w."lgaId", p."wardId"
    `;

    for (const row of rows) {
      byState.set(row.stateId, (byState.get(row.stateId) ?? 0) + row.count);
      byLga.set(row.lgaId, (byLga.get(row.lgaId) ?? 0) + row.count);
      byWard.set(row.wardId, (byWard.get(row.wardId) ?? 0) + row.count);
    }
    return { byState, byLga, byWard };
  }

  private async listMapIrevMismatches(
    campaignId: string,
    scope: { stateIds?: string[]; lgaIds?: string[]; wardIds?: string[] },
    take = 80,
  ) {
    const wardIds = scope.wardIds?.filter(Boolean) ?? [];
    const lgaIds = scope.lgaIds?.filter(Boolean) ?? [];
    const stateIds = scope.stateIds?.filter(Boolean) ?? [];
    if (!wardIds.length && !lgaIds.length && !stateIds.length) return [];

    const geoFilter = wardIds.length
      ? Prisma.sql`AND p."wardId" IN (${Prisma.join(wardIds)})`
      : lgaIds.length
        ? Prisma.sql`AND w."lgaId" IN (${Prisma.join(lgaIds)})`
        : Prisma.sql`AND l."stateId" IN (${Prisma.join(stateIds)})`;

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        puId: string;
        name: string;
        code: string | null;
        latitude: number | null;
        longitude: number | null;
        wardId: string | null;
        wardName: string | null;
        lgaId: string | null;
        lgaName: string | null;
        stateId: string | null;
        stateName: string | null;
        status: string | null;
        recommendation: string | null;
        severity: string | null;
        delta: string | null;
      }>
    >`
      SELECT cr.id,
             p.id AS "puId",
             p.name,
             p.code,
             p.latitude,
             p.longitude,
             p."wardId" AS "wardId",
             w.name AS "wardName",
             w."lgaId" AS "lgaId",
             l.name AS "lgaName",
             l."stateId" AS "stateId",
             s.name AS "stateName",
             cr."irevVerification"->>'status' AS status,
             cr."irevVerification"->>'recommendation' AS recommendation,
             cr."irevVerification"->>'severity' AS severity,
             cr."irevVerification"->>'clientPartyDelta' AS delta
      FROM collation_results cr
      INNER JOIN polling_units p ON p.id = cr."scopeId"
      INNER JOIN wards w ON w.id = p."wardId"
      INNER JOIN lgas l ON l.id = w."lgaId"
      INNER JOIN states s ON s.id = l."stateId"
      WHERE cr."campaignId" = ${campaignId}
        AND cr.level = 'POLLING_UNIT'::"CollationLevel"
        AND cr."irevVerification" IS NOT NULL
        AND (
          cr."irevVerification"#>>'{status}' IN ('MISMATCH', 'REPLACED')
          OR cr."irevVerification"#>>'{recommendation}' = 'INVESTIGATE'
        )
        ${geoFilter}
      ORDER BY CASE cr."irevVerification"->>'severity'
        WHEN 'MISMATCH_HIGH_CONF' THEN 0
        WHEN 'REPLACED_MATERIAL' THEN 1
        WHEN 'MISMATCH_LOW_CONF' THEN 2
        WHEN 'REPLACED' THEN 3
        ELSE 4
      END,
      cr."irevVerifiedAt" DESC NULLS LAST
      LIMIT ${take}
    `;

    return rows.map((row) => {
      const delta = row.delta != null && row.delta !== '' ? Number(row.delta) : null;
      return {
        id: row.id,
        name: row.name.toUpperCase(),
        code: row.code,
        status: row.status,
        recommendation: row.recommendation,
        severity: row.severity,
        delta: delta != null && Number.isFinite(delta) ? delta : null,
        stateId: row.stateId,
        stateName: row.stateName ? row.stateName.toUpperCase() : null,
        lgaId: row.lgaId,
        lgaName: row.lgaName ? row.lgaName.toUpperCase() : null,
        wardId: row.wardId,
        wardName: row.wardName ? row.wardName.toUpperCase() : null,
        puId: row.puId,
        latitude: row.latitude,
        longitude: row.longitude,
        href: `/dashboard/irev?view=triage&status=${encodeURIComponent(
          row.status === 'REPLACED'
            ? 'REPLACED'
            : row.status === 'PENDING'
              ? 'AWAITING_IREV'
              : row.status === 'UNREADABLE'
                ? 'UNREADABLE'
                : row.status === 'MISMATCH'
                  ? 'MISMATCH'
                  : 'INVESTIGATE',
        )}&search=${encodeURIComponent(row.code ?? row.name)}&resultId=${encodeURIComponent(row.id)}&puId=${encodeURIComponent(row.puId)}`,
      };
    });
  }

  async getIrevAttentionBrief(user: JwtPayload) {
    const partyConfig = await this.getCampaignPartyConfig(user.campaignId!);
    return this.loadIrevAttentionSummary(
      user.campaignId!,
      partyConfig.clientPartyCode,
      partyConfig.partyColumns,
    );
  }

  private async loadIrevAttentionSummary(
    campaignId: string,
    clientPartyCode: string | null | undefined,
    partyColumns: string[],
  ): Promise<{
    votesAtRisk: IrevVotesAtRisk;
    clusters: IrevAttentionCluster[];
    feed: IrevAttentionFeed;
  }> {
    const partyCode = clientPartyCode ?? null;
    const windowStart = new Date(Date.now() - ATTENTION_FEED_WINDOW_MINUTES * 60_000);
    const [investigateRows, newOfficialScans, replacements, newlyAligned] = await Promise.all([
      this.prisma.collationResult.findMany({
        where: {
          campaignId,
          contestId: this.contests.id(),
          level: CollationLevel.POLLING_UNIT,
          OR: [
            { irevVerification: { path: ['status'], equals: 'MISMATCH' } },
            { irevVerification: { path: ['status'], equals: 'REPLACED' } },
          ],
        },
        select: {
          id: true,
          scopeId: true,
          partyResults: true,
          irevVerification: true,
          irevVerifiedAt: true,
        },
        take: 2000,
      }),
      this.prisma.irevPuSnapshot.count({
        where: { campaignId, uploadedAt: { gte: windowStart } },
      }),
      this.prisma.irevScanRevision.count({
        where: { observedAt: { gte: windowStart }, snapshot: { campaignId } },
      }),
      this.prisma.collationResult.count({
        where: {
          campaignId,
          level: CollationLevel.POLLING_UNIT,
          irevVerifiedAt: { gte: windowStart },
          irevVerification: { path: ['status'], equals: 'MATCH' },
        },
      }),
    ]);

    const puIds = investigateRows.map((row) => row.scopeId);
    const pus = puIds.length
      ? await this.prisma.pollingUnit.findMany({
          where: { id: { in: puIds } },
          select: {
            id: true,
            name: true,
            code: true,
            ward: {
              select: {
                id: true,
                name: true,
                lga: { select: { name: true, state: { select: { name: true } } } },
              },
            },
          },
        })
      : [];
    const puMap = new Map(pus.map((row) => [row.id, row]));
    const riskRows: Array<{
      resultId: string;
      pollingUnitId: string;
      pollingUnitCode: string;
      pollingUnitName: string;
      wardName: string;
      lgaName: string;
      stateName: string;
      agent: number | null;
      irev: number | null;
      delta: number | null;
      replaced: boolean;
      severity: IrevSeverity | undefined;
    }> = [];
    const clusterSource: Array<{
      wardId: string;
      wardName: string;
      lgaName: string;
      stateName: string;
      mismatch: boolean;
      replaced: boolean;
      votesAtRisk: number;
    }> = [];
    let newMaterialMismatches = 0;

    for (const row of investigateRows) {
      const parsed = resolveIrevVerification(row);
      if (!parsed) continue;
      const parties = parsePartyTotals(row.partyResults, partyColumns);
      const verification = attachAttention(parsed, {
        clientPartyCode: partyCode,
        agentPartyResults: parties,
      });
      const pu = puMap.get(row.scopeId);
      const replaced = verification.status === 'REPLACED';
      const delta = verification.clientPartyDelta ?? null;
      if (verification.material && row.irevVerifiedAt && row.irevVerifiedAt >= windowStart) {
        newMaterialMismatches += 1;
      }
      riskRows.push({
        resultId: row.id,
        pollingUnitId: row.scopeId,
        pollingUnitCode: pu?.code ?? '',
        pollingUnitName: pu?.name?.toUpperCase() ?? '',
        wardName: pu?.ward.name ?? '',
        lgaName: pu?.ward.lga.name ?? '',
        stateName: pu?.ward.lga.state.name ?? '',
        agent: verification.clientPartyAgent ?? null,
        irev: verification.clientPartyIrev ?? null,
        delta,
        replaced,
        severity: verification.severity,
      });
      clusterSource.push({
        wardId: pu?.ward.id ?? '',
        wardName: pu?.ward.name ?? 'Unknown ward',
        lgaName: pu?.ward.lga.name ?? '',
        stateName: pu?.ward.lga.state.name ?? '',
        mismatch: verification.status === 'MISMATCH' || replaced,
        replaced,
        votesAtRisk: delta != null && delta > 0 ? delta : 0,
      });
    }

    return {
      votesAtRisk: summarizeVotesAtRisk(partyCode, riskRows),
      clusters: clusterAttentionRows(clusterSource),
      feed: {
        windowMinutes: ATTENTION_FEED_WINDOW_MINUTES,
        newOfficialScans,
        newMaterialMismatches,
        replacements,
        newlyAligned,
      },
    };
  }

  private pulseFields(row?: {
    phase: string | null;
    silent: boolean;
    silentCount: number;
    pulseTotal: number;
    rivalHeavyCount: number;
    rivalMobilization: string | null;
    whoLooksAhead: string | null;
    hasObserved: boolean;
  }) {
    return {
      phase: row?.phase ?? null,
      silent: row?.silent ?? false,
      silentCount: row?.silentCount ?? 0,
      pulseTotal: row?.pulseTotal ?? 0,
      rivalHeavyCount: row?.rivalHeavyCount ?? 0,
      rivalMobilization: row?.rivalMobilization ?? null,
      whoLooksAhead: row?.whoLooksAhead ?? null,
      hasObserved: row?.hasObserved ?? false,
    };
  }

  private reportingStats(total: number, submitted: number, approved = 0): ScopeReporting {
    return reportingStatsExtended(total, submitted, approved);
  }

  private buildReportingFromCov(
    cov: { total: number; reported: number; approved?: number; lastAt: Date | null } | undefined,
  ): ScopeReporting {
    return this.reportingStats(cov?.total ?? 0, cov?.reported ?? 0, cov?.approved ?? 0);
  }

  private async listMapIncidents(
    campaignId: string,
    scope: { lgaIds?: string[]; wardIds?: string[]; stateIds?: string[] },
  ) {
    const or: Prisma.FieldReportWhereInput[] = [];
    if (scope.wardIds?.length) or.push({ wardId: { in: scope.wardIds } });
    if (scope.lgaIds?.length) {
      or.push({ ward: { lgaId: { in: scope.lgaIds } } });
      or.push({ pollingUnit: { ward: { lgaId: { in: scope.lgaIds } } } });
    }
    if (scope.stateIds?.length) {
      or.push({ ward: { lga: { stateId: { in: scope.stateIds } } } });
      or.push({ pollingUnit: { ward: { lga: { stateId: { in: scope.stateIds } } } } });
    }
    if (!or.length) return [];

    const reports = await this.prisma.fieldReport.findMany({
      where: {
        campaignId,
        type: { in: [FieldReportType.INCIDENT, FieldReportType.SECURITY_CONCERN] },
        status: { not: 'RESOLVED' },
        OR: or,
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      select: {
        id: true,
        type: true,
        incidentType: true,
        incidentSeverity: true,
        status: true,
        title: true,
        description: true,
        isUrgent: true,
        wardId: true,
        pollingUnitId: true,
        latitude: true,
        longitude: true,
        updatedAt: true,
        ward: { select: { id: true, name: true, lgaId: true } },
        pollingUnit: {
          select: {
            id: true,
            name: true,
            wardId: true,
            ward: { select: { lgaId: true, name: true } },
          },
        },
        reporter: { select: { firstName: true, lastName: true } },
      },
    });

    return reports.map((r) => ({
      id: r.id,
      type: r.type,
      incidentType: r.incidentType,
      severity: r.incidentSeverity,
      status: r.status,
      title: r.title ?? r.description?.slice(0, 80) ?? 'Incident',
      lgaId: r.ward?.lgaId ?? r.pollingUnit?.ward?.lgaId ?? null,
      wardId: r.wardId ?? r.pollingUnit?.wardId ?? null,
      puId: r.pollingUnitId ?? null,
      latitude: r.latitude,
      longitude: r.longitude,
      reportedBy: r.reporter
        ? `${r.reporter.firstName ?? ''} ${r.reporter.lastName ?? ''}`.trim()
        : null,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /** PU totals + reported counts keyed by LGA and ward for coverage layers. */
  private async loadPuReportingMaps(campaignId: string, lgaIds: string[]) {
    const empty = {
      byLga: new Map<string, { total: number; reported: number; approved: number; lastAt: Date | null }>(),
      byWard: new Map<string, { total: number; reported: number; approved: number; lastAt: Date | null }>(),
      puByLga: new Map<string, Set<string>>(),
      puByWard: new Map<string, Set<string>>(),
      puResults: [] as Array<{
        scopeId: string;
        status: string;
        submittedAt: Date | null;
        approvedAt: Date | null;
        createdAt: Date;
        partyResults?: unknown;
      }>,
    };
    if (!lgaIds.length) return empty;

    const pus = await this.prisma.pollingUnit.findMany({
      where: { ward: { lgaId: { in: lgaIds } } },
      select: {
        id: true,
        wardId: true,
        ward: { select: { lgaId: true } },
      },
    });

    const byLga = new Map<string, { total: number; reported: number; approved: number; lastAt: Date | null }>();
    const byWard = new Map<string, { total: number; reported: number; approved: number; lastAt: Date | null }>();
    const puByLga = new Map<string, Set<string>>();
    const puByWard = new Map<string, Set<string>>();
    for (const id of lgaIds) byLga.set(id, { total: 0, reported: 0, approved: 0, lastAt: null });

    for (const pu of pus) {
      const lgaId = pu.ward.lgaId;
      const lga = byLga.get(lgaId) ?? { total: 0, reported: 0, approved: 0, lastAt: null };
      lga.total += 1;
      byLga.set(lgaId, lga);

      const ward = byWard.get(pu.wardId) ?? { total: 0, reported: 0, approved: 0, lastAt: null };
      ward.total += 1;
      byWard.set(pu.wardId, ward);

      const lgaSet = puByLga.get(lgaId) ?? new Set<string>();
      lgaSet.add(pu.id);
      puByLga.set(lgaId, lgaSet);
      const wardSet = puByWard.get(pu.wardId) ?? new Set<string>();
      wardSet.add(pu.id);
      puByWard.set(pu.wardId, wardSet);
    }

    const puResults = await this.prisma.collationResult.findMany({
      where: {
        campaignId,
        contestId: this.contests.id(),
        level: CollationLevel.POLLING_UNIT,
        scopeId: { in: pus.map((p) => p.id) },
        status: {
          in: [
            CollationResultStatus.SUBMITTED,
            CollationResultStatus.APPROVED,
            CollationResultStatus.REJECTED,
          ],
        },
      },
      select: {
        scopeId: true,
        status: true,
        submittedAt: true,
        approvedAt: true,
        createdAt: true,
        partyResults: true,
      },
    });

    const puById = new Map(pus.map((p) => [p.id, p]));
    for (const result of puResults) {
      const pu = puById.get(result.scopeId);
      if (!pu) continue;
      const stamp = result.submittedAt ?? result.createdAt;
      const lga = byLga.get(pu.ward.lgaId);
      if (lga) {
        lga.reported += 1;
        if (result.status === CollationResultStatus.APPROVED) lga.approved += 1;
        if (!lga.lastAt || stamp > lga.lastAt) lga.lastAt = stamp;
      }
      const ward = byWard.get(pu.wardId);
      if (ward) {
        ward.reported += 1;
        if (result.status === CollationResultStatus.APPROVED) ward.approved += 1;
        if (!ward.lastAt || stamp > ward.lastAt) ward.lastAt = stamp;
      }
    }

    return { byLga, byWard, puByLga, puByWard, puResults };
  }

  /** SUBMITTED + REJECTED PU vote totals by state — only for states with no approved PUs yet. */
  private async loadUnapprovedPuPartiesByState(
    campaignId: string,
    stateIds: string[],
    partyColumns: string[],
  ) {
    const byState = new Map<string, { submitted: Record<string, number>; returned: Record<string, number> }>();
    if (!stateIds.length) return byState;

    const rows = await this.prisma.$queryRaw<
      Array<{ stateId: string; status: string; partyResults: unknown }>
    >`
      SELECT l."stateId" AS "stateId", cr.status::text AS status, cr."partyResults" AS "partyResults"
      FROM collation_results cr
      INNER JOIN polling_units p ON p.id = cr."scopeId"
      INNER JOIN wards w ON w.id = p."wardId"
      INNER JOIN lgas l ON l.id = w."lgaId"
      WHERE cr."campaignId" = ${campaignId}
        AND cr.level = 'POLLING_UNIT'::"CollationLevel"
        AND cr.status IN ('SUBMITTED'::"CollationResultStatus", 'REJECTED'::"CollationResultStatus")
        AND l."stateId" IN (${Prisma.join(stateIds)})
    `;

    for (const row of rows) {
      const current = byState.get(row.stateId) ?? { submitted: {}, returned: {} };
      const parties = parsePartyTotals(row.partyResults, partyColumns);
      if (row.status === CollationResultStatus.REJECTED) {
        addPartyTotals(current.returned, parties);
      } else {
        addPartyTotals(current.submitted, parties);
      }
      byState.set(row.stateId, current);
    }
    return byState;
  }

  private async loadPuReportingByState(campaignId: string, stateIds: string[]) {
    const empty = new Map<
      string,
      { total: number; reported: number; approved: number; lastAt: Date | null }
    >();
    if (!stateIds.length) return empty;
    for (const id of stateIds) empty.set(id, { total: 0, reported: 0, approved: 0, lastAt: null });

    const totals = await this.prisma.$queryRaw<Array<{ stateId: string; total: number }>>`
      SELECT l."stateId" AS "stateId", COUNT(p.id)::int AS total
      FROM polling_units p
      INNER JOIN wards w ON w.id = p."wardId"
      INNER JOIN lgas l ON l.id = w."lgaId"
      WHERE l."stateId" IN (${Prisma.join(stateIds)})
      GROUP BY l."stateId"
    `;
    for (const row of totals) {
      empty.set(row.stateId, { total: row.total, reported: 0, approved: 0, lastAt: null });
    }

    const reported = await this.prisma.$queryRaw<
      Array<{ stateId: string; reported: number; approved: number; lastAt: Date | null }>
    >`
      SELECT l."stateId" AS "stateId",
             COUNT(cr.id)::int AS reported,
             COUNT(*) FILTER (WHERE cr.status = 'APPROVED'::"CollationResultStatus")::int AS approved,
             MAX(COALESCE(cr."submittedAt", cr."createdAt")) AS "lastAt"
      FROM collation_results cr
      INNER JOIN polling_units p ON p.id = cr."scopeId"
      INNER JOIN wards w ON w.id = p."wardId"
      INNER JOIN lgas l ON l.id = w."lgaId"
      WHERE cr."campaignId" = ${campaignId}
        AND cr.level = 'POLLING_UNIT'::"CollationLevel"
        AND cr.status IN ('SUBMITTED'::"CollationResultStatus", 'APPROVED'::"CollationResultStatus", 'REJECTED'::"CollationResultStatus")
        AND l."stateId" IN (${Prisma.join(stateIds)})
      GROUP BY l."stateId"
    `;
    for (const row of reported) {
      const current = empty.get(row.stateId) ?? {
        total: 0,
        reported: 0,
        approved: 0,
        lastAt: null,
      };
      current.reported = row.reported;
      current.approved = row.approved;
      current.lastAt = row.lastAt;
      empty.set(row.stateId, current);
    }
    return empty;
  }

  /** 15-minute velocity rollup by state — SQL only, no PU id materialization. */
  private async loadPuVelocityByState(
    campaignId: string,
    stateIds: string[],
    windowMinutes = 15,
  ) {
    const empty = new Map<string, ScopeVelocity>();
    if (!stateIds.length) return empty;
    for (const id of stateIds) {
      empty.set(id, { newlyReported: 0, newlyApproved: 0, windowMinutes });
    }

    const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);
    const rows = await this.prisma.$queryRaw<
      Array<{ stateId: string; newlyReported: number; newlyApproved: number }>
    >`
      SELECT l."stateId" AS "stateId",
             COUNT(*) FILTER (
               WHERE COALESCE(cr."submittedAt", cr."createdAt") >= ${windowStart}
             )::int AS "newlyReported",
             COUNT(*) FILTER (
               WHERE cr."approvedAt" IS NOT NULL AND cr."approvedAt" >= ${windowStart}
             )::int AS "newlyApproved"
      FROM collation_results cr
      INNER JOIN polling_units p ON p.id = cr."scopeId"
      INNER JOIN wards w ON w.id = p."wardId"
      INNER JOIN lgas l ON l.id = w."lgaId"
      WHERE cr."campaignId" = ${campaignId}
        AND cr.level = 'POLLING_UNIT'::"CollationLevel"
        AND cr.status IN ('SUBMITTED'::"CollationResultStatus", 'APPROVED'::"CollationResultStatus", 'REJECTED'::"CollationResultStatus")
        AND l."stateId" IN (${Prisma.join(stateIds)})
      GROUP BY l."stateId"
    `;
    for (const row of rows) {
      empty.set(row.stateId, {
        newlyReported: row.newlyReported,
        newlyApproved: row.newlyApproved,
        windowMinutes,
      });
    }
    return empty;
  }

  /** Open incident pressure rolled up by state without scanning all LGA ids. */
  private async aggregateIncidentsByState(campaignId: string, stateIds: string[]) {
    const byState = new Map<string, IncidentBucket>();
    for (const id of stateIds) byState.set(id, emptyIncidentBucket());
    if (!stateIds.length) return byState;

    const reports = await this.prisma.fieldReport.findMany({
      where: {
        campaignId,
        type: { in: [FieldReportType.INCIDENT, FieldReportType.SECURITY_CONCERN] },
        status: { not: 'RESOLVED' },
        OR: [
          { ward: { lga: { stateId: { in: stateIds } } } },
          { pollingUnit: { ward: { lga: { stateId: { in: stateIds } } } } },
        ],
      },
      select: {
        isUrgent: true,
        incidentSeverity: true,
        ward: { select: { lga: { select: { stateId: true } } } },
        pollingUnit: { select: { ward: { select: { lga: { select: { stateId: true } } } } } },
      },
    });

    for (const report of reports) {
      const stateId =
        report.ward?.lga?.stateId ?? report.pollingUnit?.ward?.lga?.stateId ?? null;
      if (!stateId) continue;
      const severity = report.incidentSeverity ?? (report.isUrgent ? 'HIGH' : 'LOW');
      const weight = severityWeight(severity);
      const urgent = report.isUrgent || severity === 'HIGH' || severity === 'CRITICAL' ? 1 : 0;
      bumpIncident(byState, stateId, weight, urgent, severity);
    }

    return byState;
  }

  private async aggregateIncidentsByScope(
    campaignId: string,
    scope: { lgaIds?: string[]; wardIds?: string[]; pollingUnitIds?: string[] },
  ) {
    const or: Prisma.FieldReportWhereInput[] = [];
    if (scope.wardIds?.length) or.push({ wardId: { in: scope.wardIds } });
    if (scope.pollingUnitIds?.length) or.push({ pollingUnitId: { in: scope.pollingUnitIds } });
    if (scope.lgaIds?.length) {
      or.push({ ward: { lgaId: { in: scope.lgaIds } } });
      or.push({ pollingUnit: { ward: { lgaId: { in: scope.lgaIds } } } });
    }

    if (!or.length) {
      return {
        byLga: new Map<string, IncidentBucket>(),
        byWard: new Map<string, IncidentBucket>(),
        byPu: new Map<string, IncidentBucket>(),
      };
    }

    const reports = await this.prisma.fieldReport.findMany({
      where: {
        campaignId,
        type: { in: [FieldReportType.INCIDENT, FieldReportType.SECURITY_CONCERN] },
        status: { not: 'RESOLVED' },
        OR: or,
      },
      select: {
        wardId: true,
        pollingUnitId: true,
        isUrgent: true,
        incidentSeverity: true,
        ward: { select: { id: true, lgaId: true } },
        pollingUnit: { select: { id: true, wardId: true, ward: { select: { lgaId: true } } } },
      },
    });

    const byLga = new Map<string, IncidentBucket>();
    const byWard = new Map<string, IncidentBucket>();
    const byPu = new Map<string, IncidentBucket>();

    for (const report of reports) {
      const severity = report.incidentSeverity ?? (report.isUrgent ? 'HIGH' : 'LOW');
      const weight = severityWeight(severity);
      const urgent = report.isUrgent || severity === 'HIGH' || severity === 'CRITICAL' ? 1 : 0;

      const lgaId = report.ward?.lgaId ?? report.pollingUnit?.ward?.lgaId;
      const wardId = report.wardId ?? report.pollingUnit?.wardId ?? report.ward?.id;
      const puId = report.pollingUnitId ?? report.pollingUnit?.id;

      if (lgaId) bumpIncident(byLga, lgaId, weight, urgent, severity);
      if (wardId) bumpIncident(byWard, wardId, weight, urgent, severity);
      if (puId) bumpIncident(byPu, puId, weight, urgent, severity);
    }

    return { byLga, byWard, byPu };
  }

  /**
   * Unresolved-incident pressure, weighted by severity. Thin public wrapper over
   * the private aggregator so the AI assistant reuses the same counting rules as
   * the situation map instead of inventing its own.
   *
   * Rolls up to STATES on a national campaign and to LGAs once the caller is
   * inside one state, matching how getRaceAnalytics picks its geography level.
   */
  async getIncidentHotspots(user: JwtPayload) {
    const context = await this.getContext(user);
    this.assertCanBrowseLevel(user, CollationLevel.LGA);

    const geo = this.browseGeoFilter(user, context);
    const lgaLocked = this.isScopedToLga(user);
    const nationalScope = context.isNational && !geo.stateId && !lgaLocked;

    const lgaWhere: Prisma.LGAWhereInput = geo.stateId
      ? { stateId: geo.stateId }
      : context.isNational && !lgaLocked
        ? {}
        : { stateId: context.stateId };
    if (lgaLocked) lgaWhere.id = user.scopeId!;

    const lgas = await this.prisma.lGA.findMany({
      where: lgaWhere,
      select: { id: true, name: true, stateId: true },
    });

    const { byLga } = await this.aggregateIncidentsByScope(user.campaignId!, {
      lgaIds: lgas.map((lga) => lga.id),
    });

    let rows: Array<{
      id: string;
      name: string;
      openIncidents: number;
      urgentIncidents: number;
      severityWeight: number;
      maxSeverity: string | null;
    }>;

    if (nationalScope) {
      const states = await this.prisma.state.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      });
      const lgaToState = new Map(lgas.map((lga) => [lga.id, lga.stateId]));
      const byState = new Map<string, IncidentBucket>();
      for (const state of states) byState.set(state.id, emptyIncidentBucket());

      for (const [lgaId, bucket] of byLga.entries()) {
        const stateId = lgaToState.get(lgaId);
        if (!stateId) continue;
        const current = byState.get(stateId) ?? emptyIncidentBucket();
        byState.set(stateId, {
          count: current.count + bucket.count,
          urgent: current.urgent + bucket.urgent,
          weight: current.weight + bucket.weight,
          maxSeverity:
            !current.maxSeverity ||
            severityWeight(bucket.maxSeverity) > severityWeight(current.maxSeverity)
              ? bucket.maxSeverity
              : current.maxSeverity,
        });
      }

      rows = states.map((state) => {
        const bucket = byState.get(state.id) ?? emptyIncidentBucket();
        return {
          id: state.id,
          name: state.name,
          openIncidents: bucket.count,
          urgentIncidents: bucket.urgent,
          severityWeight: bucket.weight,
          maxSeverity: bucket.maxSeverity,
        };
      });
    } else {
      rows = lgas.map((lga) => {
        const bucket = byLga.get(lga.id) ?? emptyIncidentBucket();
        return {
          id: lga.id,
          name: lga.name,
          openIncidents: bucket.count,
          urgentIncidents: bucket.urgent,
          severityWeight: bucket.weight,
          maxSeverity: bucket.maxSeverity,
        };
      });
    }

    const hotspots = rows
      .filter((row) => row.openIncidents > 0)
      .sort((a, b) => b.severityWeight - a.severityWeight);

    return {
      scopeName: context.stateName,
      geographyLevel: nationalScope ? 'STATE' : 'LGA',
      unitLabel: nationalScope ? 'States' : 'LGAs',
      totalOpenIncidents: hotspots.reduce((sum, row) => sum + row.openIncidents, 0),
      totalUrgentIncidents: hotspots.reduce((sum, row) => sum + row.urgentIncidents, 0),
      unitsWithIncidents: hotspots.length,
      hotspots,
    };
  }

  private buildMeta(page: number, limit: number, total: number) {
    return {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  private assertCanBrowseLevel(user: JwtPayload, minLevel: CollationLevel) {
    const role = user.role as CampaignRole | undefined;
    const level = role ? getCollationLevelForRole(role) : undefined;

    // DATA_ANALYST has no collation level of its own but is a read-only
    // analytics role, and the AI assistant reads race analytics on its behalf.
    if (
      !level &&
      role !== CampaignRole.CAMPAIGN_DIRECTOR &&
      role !== CampaignRole.CANDIDATE &&
      role !== CampaignRole.DATA_ANALYST
    ) {
      throw new ForbiddenException('Insufficient permissions to browse this level');
    }

    const order = [CollationLevel.POLLING_UNIT, CollationLevel.WARD, CollationLevel.LGA, CollationLevel.STATE, CollationLevel.NATIONAL];
    if (level && order.indexOf(level) < order.indexOf(minLevel)) {
      // PU officer can't browse LGAs - handled by scoped queries
    }
  }

  private isScopedToPu(user: JwtPayload) {
    return (
      user.scopeType === ScopeType.POLLING_UNIT || user.role === CampaignRole.POLLING_AGENT
    );
  }

  private isScopedToWard(user: JwtPayload) {
    return (
      user.scopeType === ScopeType.WARD || user.role === CampaignRole.WARD_RA_OFFICER
    );
  }

  private isScopedToLga(user: JwtPayload) {
    return (
      user.scopeType === ScopeType.LGA || user.role === CampaignRole.LGA_COLLATION_OFFICER
    );
  }
}
