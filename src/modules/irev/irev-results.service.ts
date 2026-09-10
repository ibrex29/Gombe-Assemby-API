import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  CampaignRole,
  CollationLevel,
  ScopeType,
  emptyPartyTotals,
  getPartyCodes,
  isCampaignAdminRole,
  normalizeTrackedParties,
  normalizeZoneLabel,
  parsePartyTotals,
  type JwtPayload,
  type TrackedParty,
} from '@electromon/shared';
import { Prisma } from '@electromon/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContestService, type ResolvedSeat } from '../../common/contest/contest.service';
import { DeploymentScopeService } from '../../common/deployment-scope/deployment-scope.service';
import { IrevClient } from './irev.client';
import { IrevOfficialStatsService } from './irev-official-stats.service';
import { IrevElectionResolver } from './irev-election.resolver';

type ListResultsQuery = {
  status?: string;
  stateId?: string;
  lgaId?: string;
  wardId?: string;
  zone?: string;
  search?: string;
  sort?: string;
  limit?: number;
};

type GeoRollupScope =
  | { level: 'national' }
  | { level: 'state'; stateId: string }
  | { level: 'constituency'; stateId: string }
  | { level: 'seat'; wardIds: string[] }
  | { level: 'lga'; lgaId: string }
  | { level: 'ward'; wardId: string };

type MapOutcome = 'WIN' | 'LOSS' | 'TIE' | 'PENDING';

type CoverageRow = {
  scopeId: string;
  scopeName: string;
  stateCode: string | null;
  stateZone: string | null;
  stateName: string | null;
  totalPus: number;
  publishedPus: number;
  readablePus: number;
  failedPus: number;
  pendingOcrPus: number;
};

type ScopeAggregate = {
  partyResults: Record<string, number>;
  totalVotes: number;
  registeredVoters: number;
  votesCast: number;
  accreditedVoters: number;
};

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

function parseOcrExtract(ocrExtract: unknown, partyColumns: string[]) {
  if (!ocrExtract || typeof ocrExtract !== 'object' || Array.isArray(ocrExtract)) {
    return {
      parties: emptyPartyTotals(partyColumns),
      registeredVoters: 0,
      votesCast: 0,
      accreditedVoters: 0,
    };
  }

  const extract = ocrExtract as {
    partyResults?: unknown;
    fields?: Record<string, number | null>;
    unreadable?: boolean;
  };

  if (extract.unreadable) {
    return {
      parties: emptyPartyTotals(partyColumns),
      registeredVoters: 0,
      votesCast: 0,
      accreditedVoters: 0,
    };
  }

  const parties = parsePartyTotals(extract.partyResults, partyColumns);
  const fields = extract.fields ?? {};
  const registeredVoters = fields.registeredVoters ?? 0;
  const accreditedVoters = fields.accreditedVoters ?? 0;
  const votesCast =
    fields.votesCast ??
    fields.usedBallotPapers ??
    Object.values(parties).reduce((sum, value) => sum + value, 0);

  return { parties, registeredVoters, votesCast, accreditedVoters };
}

function deriveIrevStatus(coverage: CoverageRow, totalVotes: number): string {
  if (coverage.readablePus > 0 && totalVotes > 0) return 'APPROVED';
  if (coverage.pendingOcrPus > 0 || (coverage.publishedPus > 0 && coverage.readablePus === 0)) {
    return 'SUBMITTED';
  }
  if (coverage.failedPus > 0 && coverage.readablePus === 0) return 'REJECTED';
  return 'NOT_STARTED';
}

@Injectable()
export class IrevResultsService {
  constructor(
    private prisma: PrismaService,
    private deploymentScope: DeploymentScopeService,
    private officialStats: IrevOfficialStatsService,
    private irevClient: IrevClient,
    private contests: ContestService,
    private irevElections: IrevElectionResolver,
  ) {}

  private lockedStateId(): string | undefined {
    return this.deploymentScope.lockedStateId() ?? undefined;
  }

  private contestId(): string {
    return this.contests.id();
  }

  async listResults(user: JwtPayload, query: ListResultsQuery = {}) {
    if (!user.campaignId) throw new ForbiddenException('No active campaign membership');

    const lockedStateId = this.lockedStateId();
    if (lockedStateId) {
      this.deploymentScope.clampStateId(query.stateId);
    }

    if (query.wardId) {
      await this.assertWardInScope(query.wardId, lockedStateId ?? query.stateId);
      return this.listPuResults(user.campaignId, {
        ...query,
        limit: query.limit ?? 500,
      });
    }

    const seat = this.contests.seat();
    if (seat) {
      return this.listSeatWardResults(user.campaignId, {
        ...query,
        seat,
        limit: query.limit ?? 200,
      });
    }

    if (
      isCampaignAdminRole(user.role) ||
      user.role === CampaignRole.STATE_COLLATION_OFFICER ||
      user.role === 'NATIONAL_COLLATION_OFFICER' ||
      user.role === 'DATA_ANALYST'
    ) {
      return this.listConstituencyResults(user.campaignId, {
        ...query,
        stateId: lockedStateId ?? query.stateId,
        limit: query.limit ?? 24,
      });
    }

    throw new ForbiddenException('IReV results require admin or state collation access');
  }

  async getRaceAnalytics(user: JwtPayload, stateId?: string) {
    if (!user.campaignId) throw new ForbiddenException('No active campaign membership');
    if (!isCampaignAdminRole(user.role) && user.role !== CampaignRole.STATE_COLLATION_OFFICER && user.role !== CampaignRole.NATIONAL_COLLATION_OFFICER && user.role !== CampaignRole.DATA_ANALYST) {
      throw new ForbiddenException('IReV results require admin or state collation access');
    }

    const lockedStateId = this.lockedStateId();
    if (lockedStateId) {
      this.deploymentScope.clampStateId(stateId);
    }

    const resolvedStateId = lockedStateId
      ? lockedStateId
      : user.role === CampaignRole.STATE_COLLATION_OFFICER
        ? user.scopeId ?? undefined
        : stateId;

    const partyConfig = await this.getCampaignPartyConfig(user.campaignId);
    const campaign = await this.prisma.campaign.findUniqueOrThrow({
      where: { id: user.campaignId },
      select: { stateId: true },
    });
    const seatStateId = resolvedStateId ?? campaign.stateId;

    const contest = this.contests.current();
    const seat = this.contests.seat();
    const electionId = contest
      ? this.irevElections.forSeat(contest, seat)
      : null;

    const [coverageRows, voteByScope] = await Promise.all([
      this.loadCoverageRows(
        user.campaignId,
        seatStateId ? { level: 'constituency', stateId: seatStateId } : { level: 'national' },
      ),
      this.loadVoteAggregates(
        user.campaignId,
        seatStateId ? { level: 'constituency', stateId: seatStateId } : { level: 'national' },
        partyConfig.partyColumns,
      ),
    ]);

    let wins = 0;
    let losses = 0;
    let ties = 0;
    let pending = 0;
    const partyTotals = emptyPartyTotals(partyConfig.partyColumns);
    let statewideRegistered = 0;
    let statewideCast = 0;
    let puTotal = 0;
    let puPublished = 0;
    let puReadable = 0;

    for (const row of coverageRows) {
      const votes = voteByScope.get(row.scopeId) ?? {
        partyResults: emptyPartyTotals(partyConfig.partyColumns),
        totalVotes: 0,
        registeredVoters: 0,
        votesCast: 0,
        accreditedVoters: 0,
      };

      for (const code of partyConfig.partyColumns) {
        partyTotals[code] = (partyTotals[code] ?? 0) + (votes.partyResults[code] ?? 0);
      }
      statewideRegistered += votes.registeredVoters;
      statewideCast += votes.votesCast;
      puTotal += row.totalPus;
      puPublished += row.publishedPus;
      puReadable += row.readablePus;

      const { outcome } = computeClientOutcome(
        votes.partyResults,
        partyConfig.partyColumns,
        partyConfig.clientPartyCode,
      );
      if (votes.totalVotes <= 0 || row.readablePus === 0) pending += 1;
      else if (outcome === 'WIN') wins += 1;
      else if (outcome === 'LOSS') losses += 1;
      else if (outcome === 'TIE') ties += 1;
      else pending += 1;
    }

    const statewideTotal = Object.values(partyTotals).reduce((sum, value) => sum + value, 0);
    const clientCode =
      partyConfig.clientPartyCode ?? this.deploymentScope.clientPartyCode() ?? 'APC';
    const clientVotes = partyTotals[clientCode] ?? 0;
    const rankedParties = partyConfig.partyColumns
      .map((code) => ({
        code,
        name: partyConfig.trackedParties.find((party) => party.code === code)?.name ?? code,
        votes: partyTotals[code] ?? 0,
        share:
          statewideTotal > 0
            ? Math.round(((partyTotals[code] ?? 0) / statewideTotal) * 1000) / 10
            : 0,
      }))
      .sort((a, b) => b.votes - a.votes);
    const rival = rankedParties.find((party) => party.code !== clientCode);
    const reportingPct = puTotal > 0 ? Math.round((puPublished / puTotal) * 1000) / 10 : 0;
    const ocrPct =
      puPublished > 0 ? Math.round((puReadable / puPublished) * 1000) / 10 : 0;

    const displayStateName =
      this.deploymentScope.lockedStateName()?.toUpperCase() ??
      coverageRows[0]?.stateName?.toUpperCase() ??
      'GOMBE';

    const lgaRows = coverageRows.map((row) => {
          const votes = voteByScope.get(row.scopeId) ?? {
            partyResults: emptyPartyTotals(partyConfig.partyColumns),
            totalVotes: 0,
            registeredVoters: 0,
            votesCast: 0,
            accreditedVoters: 0,
          };
          const parties = votes.partyResults;
          const totalVotes = votes.totalVotes;
          const clientVotes = partyConfig.clientPartyCode
            ? (parties[partyConfig.clientPartyCode] ?? 0)
            : 0;
          const { outcome, leadingParty, margin } = computeClientOutcome(
            parties,
            partyConfig.partyColumns,
            partyConfig.clientPartyCode,
          );
          return {
            id: row.scopeId,
            name: row.scopeName.toUpperCase(),
            parties,
            totalVotes,
            clientVotes,
            margin,
            outcome,
            leadingParty,
            resultStatus: deriveIrevStatus(row, totalVotes),
            share:
              totalVotes > 0 && partyConfig.clientPartyCode
                ? Math.round((clientVotes / totalVotes) * 1000) / 10
                : 0,
            reporting: {
              total: row.totalPus,
              reported: row.publishedPus,
              approved: row.readablePus,
              percentSubmitted:
                row.totalPus > 0
                  ? Math.round((row.publishedPus / row.totalPus) * 1000) / 10
                  : 0,
            },
          };
        });

    const biggestLeads = [...lgaRows]
      .filter((row) => row.outcome === 'WIN')
      .sort((a, b) => b.margin - a.margin)
      .slice(0, 8);
    const biggestDeficits = [...lgaRows]
      .filter((row) => row.outcome === 'LOSS')
      .sort((a, b) => b.margin - a.margin)
      .slice(0, 8);
    const closestRaces = [...lgaRows]
      .filter((row) => row.outcome !== 'PENDING' && row.totalVotes > 0)
      .sort((a, b) => Math.abs(a.margin) - Math.abs(b.margin))
      .slice(0, 8);

    const electionLabel = seat
      ? `${seat.name} House of Assembly`
      : contest?.irevElectionLabel ?? this.deploymentScope.irevElectionLabel();
    const electionType = contest?.type === 'ASSEMBLY' ? 'ASSEMBLY' : this.deploymentScope.irevElectionType();
    let portalUrl: string | null = null;

    if (electionId) {
      portalUrl = this.irevClient.electionPortalUrl(electionId);
    }

    return {
      stateName: displayStateName,
      stateId: resolvedStateId ?? seatStateId ?? 'state',
      geographyLevel: 'CONSTITUENCY',
      unitLabel: 'Seats',
      electionLabel,
      electionType,
      portalUrl,
      officialPortal: null,
      clientPartyCode: clientCode,
      trackedParties: partyConfig.trackedParties,
      partyColumns: partyConfig.partyColumns,
      summary: {
        lgaCount: coverageRows.length,
        wins,
        losses,
        ties,
        pending,
        statewideTotalVotes: statewideTotal,
        clientVotes,
        raceLead: clientVotes - (rival?.votes ?? 0),
        rivalCode: rival?.code ?? null,
        rivalVotes: rival?.votes ?? 0,
        reporting: {
          pollingUnitsTotal: puTotal,
          pollingUnitsReported: puPublished,
          percent: reportingPct,
          readableUnits: puReadable,
          ocrPercent: ocrPct,
        },
        /** Local ward crawl / snapshot counts — compare against officialPortal above. */
        catalogReporting: {
          pollingUnitsTotal: puTotal,
          pollingUnitsReported: puPublished,
          percent: reportingPct,
          readableUnits: puReadable,
          ocrPercent: ocrPct,
        },
        velocity: {
          windowMinutes: 0,
          newlyReported: 0,
          newlyApproved: 0,
        },
        incidents: {
          open: 0,
          urgent: 0,
        },
        irevMismatches: 0,
      },
      partyStandings: rankedParties,
      lgas: lgaRows.sort((a, b) => a.name.localeCompare(b.name)),
      biggestLeads,
      biggestDeficits,
      closestRaces,
    };
  }

  private async listConstituencyResults(campaignId: string, query: ListResultsQuery = {}) {
    const { status, search, sort = 'name', limit = 24 } = query;
    const partyConfig = await this.getCampaignPartyConfig(campaignId);
    const campaign = await this.prisma.campaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: { stateId: true },
    });
    const stateId = query.stateId ?? campaign.stateId;
    if (!stateId) return [];

    const where: Prisma.StateAssemblyConstituencyWhereInput = { stateId };
    if (search?.trim()) {
      const term = search.trim();
      where.OR = [
        { name: { contains: term, mode: Prisma.QueryMode.insensitive } },
        { code: { contains: term, mode: Prisma.QueryMode.insensitive } },
      ];
    }

    const seats = await this.prisma.stateAssemblyConstituency.findMany({
      where,
      orderBy: { name: 'asc' },
      take: limit,
      include: {
        lga: { select: { name: true } },
        state: { select: { name: true, code: true, zone: true } },
        wards: { select: { id: true } },
      },
    });
    if (!seats.length) return [];

    const [coverageRows, voteByScope] = await Promise.all([
      this.loadCoverageRows(campaignId, { level: 'constituency', stateId }),
      this.loadVoteAggregates(campaignId, { level: 'constituency', stateId }, partyConfig.partyColumns),
    ]);
    const coverageBySeat = new Map(coverageRows.map((row) => [row.scopeId, row]));

    let mapped = seats.map((seat) =>
      this.mapScopeRow({
        scopeId: seat.id,
        scopeName: seat.name,
        scopeCode: seat.code,
        portalUrl: seat.irevElectionId
          ? this.irevClient.electionPortalUrl(seat.irevElectionId)
          : null,
        stateName: seat.lga?.name ?? seat.state.name,
        stateCode: seat.state.code ?? null,
        stateZone: seat.state.zone ?? null,
        areaCount: seat.wards.length,
        level: CollationLevel.CONSTITUENCY,
        coverage:
          coverageBySeat.get(seat.id) ??
          this.emptyCoverage(seat.id, seat.name, seat.state.code, seat.state.zone, seat.state.name),
        votes: voteByScope.get(seat.id),
        partyConfig,
        campaignId,
      }),
    );

    if (status) mapped = mapped.filter((row) => row.status === status);
    mapped.sort(this.buildSorter(sort));
    return mapped;
  }

  private async listSeatWardResults(
    campaignId: string,
    query: ListResultsQuery & { seat: ResolvedSeat },
  ) {
    const { status, search, sort = 'name', limit = 200, seat } = query;
    if (seat.wardIds.length === 0) return [];

    const partyConfig = await this.getCampaignPartyConfig(campaignId);
    const wardWhere: Prisma.WardWhereInput = { id: { in: seat.wardIds } };
    if (search?.trim()) {
      wardWhere.name = { contains: search.trim(), mode: Prisma.QueryMode.insensitive };
    }

    const wards = await this.prisma.ward.findMany({
      where: wardWhere,
      orderBy: { name: 'asc' },
      take: limit,
      select: {
        id: true,
        name: true,
        lga: {
          select: {
            name: true,
            state: { select: { name: true, code: true, zone: true } },
          },
        },
        _count: { select: { pollingUnits: true } },
      },
    });
    if (!wards.length) return [];

    const [coverageRows, voteByScope] = await Promise.all([
      this.loadCoverageRows(campaignId, { level: 'seat', wardIds: seat.wardIds }),
      this.loadVoteAggregates(
        campaignId,
        { level: 'seat', wardIds: seat.wardIds },
        partyConfig.partyColumns,
      ),
    ]);
    const coverageByWard = new Map(coverageRows.map((row) => [row.scopeId, row]));

    let mapped = wards.map((ward) =>
      this.mapScopeRow({
        scopeId: ward.id,
        scopeName: ward.name,
        stateName: ward.lga.state.name ?? null,
        stateCode: ward.lga.state.code ?? null,
        stateZone: ward.lga.state.zone ?? null,
        areaCount: ward._count.pollingUnits,
        level: CollationLevel.WARD,
        coverage:
          coverageByWard.get(ward.id) ??
          this.emptyCoverage(
            ward.id,
            ward.name,
            ward.lga.state.code,
            ward.lga.state.zone,
            ward.lga.state.name,
          ),
        votes: voteByScope.get(ward.id),
        partyConfig,
        campaignId,
      }),
    );

    if (status) mapped = mapped.filter((row) => row.status === status);
    mapped.sort(this.buildSorter(sort));
    return mapped;
  }

  private async listStateResults(campaignId: string, query: ListResultsQuery = {}) {
    const { status, zone, search, sort = 'name', limit = 50 } = query;
    const partyConfig = await this.getCampaignPartyConfig(campaignId);

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

    const stateIds = states.map((state) => state.id);
    const [coverageRows, voteByScope, lgaCounts] = await Promise.all([
      this.loadCoverageRows(campaignId, { level: 'national' }),
      this.loadVoteAggregates(campaignId, { level: 'national' }, partyConfig.partyColumns),
      this.prisma.lGA.groupBy({
        by: ['stateId'],
        where: { stateId: { in: stateIds } },
        _count: { id: true },
      }),
    ]);
    const coverageByState = new Map(coverageRows.map((row) => [row.scopeId, row]));
    const lgaCountByState = new Map(lgaCounts.map((row) => [row.stateId, row._count.id]));

    let mapped = states.map((state) =>
      this.mapScopeRow({
        scopeId: state.id,
        scopeName: state.name,
        stateName: null,
        stateCode: state.code ?? null,
        stateZone: state.zone ?? null,
        areaCount: lgaCountByState.get(state.id) ?? 0,
        level: CollationLevel.STATE,
        coverage: coverageByState.get(state.id) ?? this.emptyCoverage(state.id, state.name, state.code, state.zone),
        votes: voteByScope.get(state.id),
        partyConfig,
        campaignId,
      }),
    );

    if (status) mapped = mapped.filter((row) => row.status === status);
    mapped.sort(this.buildSorter(sort));
    return mapped;
  }

  private async listLgaResults(campaignId: string, query: ListResultsQuery = {}) {
    const { status, stateId, zone, search, sort = 'name', limit = 774 } = query;
    if (!stateId) return [];

    const partyConfig = await this.getCampaignPartyConfig(campaignId);
    const lgaWhere: Prisma.LGAWhereInput = { stateId };
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

    const [coverageRows, voteByScope] = await Promise.all([
      this.loadCoverageRows(campaignId, { level: 'state', stateId }),
      this.loadVoteAggregates(campaignId, { level: 'state', stateId }, partyConfig.partyColumns),
    ]);
    const coverageByLga = new Map(coverageRows.map((row) => [row.scopeId, row]));

    let mapped = lgas.map((lga) =>
      this.mapScopeRow({
        scopeId: lga.id,
        scopeName: lga.name,
        stateName: lga.state.name ?? null,
        stateCode: lga.state.code ?? null,
        stateZone: lga.state.zone ?? null,
        areaCount: undefined,
        level: CollationLevel.LGA,
        coverage:
          coverageByLga.get(lga.id) ??
          this.emptyCoverage(lga.id, lga.name, lga.state.code, lga.state.zone, lga.state.name),
        votes: voteByScope.get(lga.id),
        partyConfig,
        campaignId,
      }),
    );

    if (status) mapped = mapped.filter((row) => row.status === status);
    mapped.sort(this.buildSorter(sort));
    return mapped;
  }

  private async listWardResults(campaignId: string, query: ListResultsQuery = {}) {
    const { status, lgaId, search, sort = 'name', limit = 200 } = query;
    if (!lgaId) return [];

    const partyConfig = await this.getCampaignPartyConfig(campaignId);
    const wardWhere: Prisma.WardWhereInput = { lgaId };
    if (search?.trim()) {
      wardWhere.name = { contains: search.trim(), mode: Prisma.QueryMode.insensitive };
    }

    const wards = await this.prisma.ward.findMany({
      where: wardWhere,
      orderBy: { name: 'asc' },
      take: limit,
      select: {
        id: true,
        name: true,
        lga: {
          select: {
            name: true,
            state: { select: { name: true, code: true, zone: true } },
          },
        },
        _count: { select: { pollingUnits: true } },
      },
    });
    if (!wards.length) return [];

    const [coverageRows, voteByScope] = await Promise.all([
      this.loadCoverageRows(campaignId, { level: 'lga', lgaId }),
      this.loadVoteAggregates(campaignId, { level: 'lga', lgaId }, partyConfig.partyColumns),
    ]);
    const coverageByWard = new Map(coverageRows.map((row) => [row.scopeId, row]));

    let mapped = wards.map((ward) =>
      this.mapScopeRow({
        scopeId: ward.id,
        scopeName: ward.name,
        stateName: ward.lga.state.name ?? null,
        stateCode: ward.lga.state.code ?? null,
        stateZone: ward.lga.state.zone ?? null,
        areaCount: ward._count.pollingUnits,
        level: CollationLevel.WARD,
        coverage:
          coverageByWard.get(ward.id) ??
          this.emptyCoverage(
            ward.id,
            ward.name,
            ward.lga.state.code,
            ward.lga.state.zone,
            ward.lga.state.name,
          ),
        votes: voteByScope.get(ward.id),
        partyConfig,
        campaignId,
      }),
    );

    if (status) mapped = mapped.filter((row) => row.status === status);
    mapped.sort(this.buildSorter(sort));
    return mapped;
  }

  private async listPuResults(campaignId: string, query: ListResultsQuery = {}) {
    const { status, wardId, search, sort = 'name', limit = 500 } = query;
    if (!wardId) return [];

    const partyConfig = await this.getCampaignPartyConfig(campaignId);
    const puWhere: Prisma.PollingUnitWhereInput = { wardId };
    if (search?.trim()) {
      const term = search.trim();
      puWhere.OR = [
        { name: { contains: term, mode: Prisma.QueryMode.insensitive } },
        { code: { contains: term, mode: Prisma.QueryMode.insensitive } },
      ];
    }

    const pollingUnits = await this.prisma.pollingUnit.findMany({
      where: puWhere,
      orderBy: [{ code: 'asc' }, { name: 'asc' }],
      take: limit,
      select: {
        id: true,
        code: true,
        name: true,
        ward: {
          select: {
            name: true,
            lga: {
              select: {
                name: true,
                state: { select: { name: true, code: true, zone: true } },
              },
            },
          },
        },
      },
    });
    if (!pollingUnits.length) return [];

    const [coverageRows, voteByScope] = await Promise.all([
      this.loadCoverageRows(campaignId, { level: 'ward', wardId }),
      this.loadVoteAggregates(campaignId, { level: 'ward', wardId }, partyConfig.partyColumns),
    ]);
    const coverageByPu = new Map(coverageRows.map((row) => [row.scopeId, row]));

    let mapped = pollingUnits.map((pu) => {
      const label = pu.code ? `${pu.code} · ${pu.name}` : pu.name;
      return this.mapScopeRow({
        scopeId: pu.id,
        scopeName: label,
        stateName: pu.ward.lga.state.name ?? null,
        stateCode: pu.ward.lga.state.code ?? null,
        stateZone: pu.ward.lga.state.zone ?? null,
        areaCount: undefined,
        level: CollationLevel.POLLING_UNIT,
        coverage:
          coverageByPu.get(pu.id) ??
          this.emptyCoverage(
            pu.id,
            label,
            pu.ward.lga.state.code,
            pu.ward.lga.state.zone,
            pu.ward.lga.state.name,
          ),
        votes: voteByScope.get(pu.id),
        partyConfig,
        campaignId,
      });
    });

    if (status) mapped = mapped.filter((row) => row.status === status);
    mapped.sort(this.buildSorter(sort));
    return mapped;
  }

  private async assertLgaInScope(lgaId: string, stateId?: string) {
    const lga = await this.prisma.lGA.findUnique({
      where: { id: lgaId },
      select: { stateId: true },
    });
    if (!lga) throw new ForbiddenException('LGA not found');
    this.deploymentScope.assertStateInScope(lga.stateId);
    if (stateId && lga.stateId !== stateId) {
      throw new ForbiddenException('LGA is outside the selected state');
    }
  }

  private async assertWardInScope(wardId: string, stateId?: string) {
    const ward = await this.prisma.ward.findUnique({
      where: { id: wardId },
      select: { lga: { select: { stateId: true } } },
    });
    if (!ward) throw new ForbiddenException('Ward not found');
    this.deploymentScope.assertStateInScope(ward.lga.stateId);
    if (stateId && ward.lga.stateId !== stateId) {
      throw new ForbiddenException('Ward is outside the selected state');
    }
  }

  private mapScopeRow(input: {
    scopeId: string;
    scopeName: string;
    scopeCode?: string | null;
    portalUrl?: string | null;
    stateName: string | null;
    stateCode: string | null;
    stateZone: string | null;
    areaCount?: number;
    level: CollationLevel;
    coverage: CoverageRow;
    votes?: ScopeAggregate;
    partyConfig: { partyColumns: string[]; clientPartyCode: string | null; trackedParties: TrackedParty[] };
    campaignId: string;
  }) {
    const parties = input.votes?.partyResults ?? emptyPartyTotals(input.partyConfig.partyColumns);
    const totalVotes =
      input.votes?.totalVotes ??
      Object.values(parties).reduce((sum, value) => sum + value, 0);
    const { outcome, leadingParty, margin } = computeClientOutcome(
      parties,
      input.partyConfig.partyColumns,
      input.partyConfig.clientPartyCode,
    );
    const registered = input.votes?.registeredVoters ?? 0;
    const cast = input.votes?.votesCast ?? totalVotes;
    const turnoutPercent = registered > 0 ? (cast / registered) * 100 : 0;
    const clientVotes = input.partyConfig.clientPartyCode
      ? (parties[input.partyConfig.clientPartyCode] ?? 0)
      : 0;
    const status = deriveIrevStatus(input.coverage, totalVotes);

    return {
      id: `irev:${input.level.toLowerCase()}:${input.scopeId}`,
      campaignId: input.campaignId,
      level: input.level,
      scopeType:
        input.level === CollationLevel.STATE
          ? ScopeType.STATE
          : input.level === CollationLevel.CONSTITUENCY
            ? ScopeType.CONSTITUENCY
            : input.level === CollationLevel.LGA
              ? ScopeType.LGA
              : input.level === CollationLevel.WARD
                ? ScopeType.WARD
                : ScopeType.POLLING_UNIT,
      scopeCode: input.scopeCode ?? null,
      portalUrl: input.portalUrl ?? null,
      scopeId: input.scopeId,
      status,
      partyResults: parties,
      registeredVoters: registered > 0 ? registered : null,
      votesCast: cast > 0 ? cast : null,
      accreditedVoters: input.votes?.accreditedVoters ? input.votes.accreditedVoters : null,
      updatedAt: new Date(0),
      submittedAt: null,
      submittedBy: null,
      approvedBy: null,
      scopeName: input.scopeName,
      stateName: input.stateName,
      stateCode: input.stateCode,
      stateZone: input.stateZone,
      areaCount: input.areaCount,
      leadingParty,
      margin,
      outcome,
      totalVotes,
      clientVotes,
      turnoutPercent,
      irevCoverage: {
        totalPollingUnits: input.coverage.totalPus,
        publishedPollingUnits: input.coverage.publishedPus,
        readablePollingUnits: input.coverage.readablePus,
        pendingOcrPollingUnits: input.coverage.pendingOcrPus,
        failedPollingUnits: input.coverage.failedPus,
      },
    };
  }

  private buildSorter(sort: string) {
    return (
      a: { scopeName?: string | null; totalVotes?: number; clientVotes?: number; turnoutPercent?: number; updatedAt?: Date | string | null },
      b: { scopeName?: string | null; totalVotes?: number; clientVotes?: number; turnoutPercent?: number; updatedAt?: Date | string | null },
    ) => {
      switch (sort) {
        case 'total':
          return (b.totalVotes ?? 0) - (a.totalVotes ?? 0);
        case 'client':
          return (b.clientVotes ?? 0) - (a.clientVotes ?? 0);
        case 'turnout':
          return (b.turnoutPercent ?? 0) - (a.turnoutPercent ?? 0);
        case 'updated':
          return new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime();
        case 'name':
        default:
          return (a.scopeName ?? '').localeCompare(b.scopeName ?? '', undefined, {
            sensitivity: 'base',
          });
      }
    };
  }

  private emptyCoverage(
    scopeId: string,
    scopeName: string,
    stateCode: string | null,
    stateZone: string | null,
    stateName: string | null = null,
  ): CoverageRow {
    return {
      scopeId,
      scopeName,
      stateCode,
      stateZone,
      stateName,
      totalPus: 0,
      publishedPus: 0,
      readablePus: 0,
      failedPus: 0,
      pendingOcrPus: 0,
    };
  }

  private async getCampaignPartyConfig(campaignId: string) {
    const campaign = await this.prisma.campaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: { clientPartyCode: true, trackedParties: true },
    });
    const trackedParties = normalizeTrackedParties(campaign.trackedParties);
    return {
      trackedParties,
      clientPartyCode: this.deploymentScope.resolveClientPartyCode(campaign.clientPartyCode),
      partyColumns: getPartyCodes(trackedParties),
    };
  }

  private async loadCoverageRows(
    campaignId: string,
    scope: GeoRollupScope = { level: 'national' },
  ): Promise<CoverageRow[]> {
    if (scope.level === 'ward') {
      return this.prisma.$queryRaw<CoverageRow[]>`
        SELECT
          pu.id AS "scopeId",
          CONCAT(pu.code, ' · ', pu.name) AS "scopeName",
          st.code AS "stateCode",
          st.zone AS "stateZone",
          st.name AS "stateName",
          1::int AS "totalPus",
          COUNT(snap.id) FILTER (
            WHERE snap."documentUrl" IS NOT NULL AND snap.status::text <> 'NOT_ON_IREV'
          )::int AS "publishedPus",
          COUNT(snap.id) FILTER (WHERE snap.status::text = 'OCR_READY')::int AS "readablePus",
          COUNT(snap.id) FILTER (WHERE snap.status::text = 'OCR_FAILED')::int AS "failedPus",
          COUNT(snap.id) FILTER (
            WHERE snap."documentUrl" IS NOT NULL AND snap.status::text = 'FETCHED'
          )::int AS "pendingOcrPus"
        FROM polling_units pu
        JOIN wards w ON w.id = pu."wardId"
        JOIN lgas l ON l.id = w."lgaId"
        JOIN states st ON st.id = l."stateId"
        LEFT JOIN irev_pu_snapshots snap
          ON snap."pollingUnitId" = pu.id AND snap."campaignId" = ${campaignId} AND snap."contestId" = ${this.contestId()}
        WHERE w.id = ${scope.wardId}
        GROUP BY pu.id, pu.code, pu.name, st.code, st.zone, st.name
        ORDER BY pu.code ASC, pu.name ASC
      `;
    }

    if (scope.level === 'lga') {
      return this.prisma.$queryRaw<CoverageRow[]>`
        SELECT
          w.id AS "scopeId",
          w.name AS "scopeName",
          st.code AS "stateCode",
          st.zone AS "stateZone",
          st.name AS "stateName",
          COUNT(pu.id)::int AS "totalPus",
          COUNT(snap.id) FILTER (
            WHERE snap."documentUrl" IS NOT NULL AND snap.status::text <> 'NOT_ON_IREV'
          )::int AS "publishedPus",
          COUNT(snap.id) FILTER (WHERE snap.status::text = 'OCR_READY')::int AS "readablePus",
          COUNT(snap.id) FILTER (WHERE snap.status::text = 'OCR_FAILED')::int AS "failedPus",
          COUNT(snap.id) FILTER (
            WHERE snap."documentUrl" IS NOT NULL AND snap.status::text = 'FETCHED'
          )::int AS "pendingOcrPus"
        FROM wards w
        JOIN lgas l ON l.id = w."lgaId"
        JOIN states st ON st.id = l."stateId"
        JOIN polling_units pu ON pu."wardId" = w.id
        LEFT JOIN irev_pu_snapshots snap
          ON snap."pollingUnitId" = pu.id AND snap."campaignId" = ${campaignId} AND snap."contestId" = ${this.contestId()}
        WHERE l.id = ${scope.lgaId}
        GROUP BY w.id, w.name, st.code, st.zone, st.name
        ORDER BY w.name ASC
      `;
    }

    if (scope.level === 'seat') {
      if (scope.wardIds.length === 0) return [];
      return this.prisma.$queryRaw<CoverageRow[]>`
        SELECT
          w.id AS "scopeId",
          w.name AS "scopeName",
          st.code AS "stateCode",
          st.zone AS "stateZone",
          st.name AS "stateName",
          COUNT(pu.id)::int AS "totalPus",
          COUNT(snap.id) FILTER (
            WHERE snap."documentUrl" IS NOT NULL AND snap.status::text <> 'NOT_ON_IREV'
          )::int AS "publishedPus",
          COUNT(snap.id) FILTER (WHERE snap.status::text = 'OCR_READY')::int AS "readablePus",
          COUNT(snap.id) FILTER (WHERE snap.status::text = 'OCR_FAILED')::int AS "failedPus",
          COUNT(snap.id) FILTER (
            WHERE snap."documentUrl" IS NOT NULL AND snap.status::text = 'FETCHED'
          )::int AS "pendingOcrPus"
        FROM wards w
        JOIN lgas l ON l.id = w."lgaId"
        JOIN states st ON st.id = l."stateId"
        LEFT JOIN polling_units pu ON pu."wardId" = w.id
        LEFT JOIN irev_pu_snapshots snap
          ON snap."pollingUnitId" = pu.id AND snap."campaignId" = ${campaignId} AND snap."contestId" = ${this.contestId()}
        WHERE w.id IN (${Prisma.join(scope.wardIds)})
        GROUP BY w.id, w.name, st.code, st.zone, st.name
        ORDER BY w.name ASC
      `;
    }

    if (scope.level === 'constituency') {
      return this.prisma.$queryRaw<CoverageRow[]>`
        SELECT
          c.id AS "scopeId",
          c.name AS "scopeName",
          st.code AS "stateCode",
          st.zone AS "stateZone",
          st.name AS "stateName",
          COUNT(pu.id)::int AS "totalPus",
          COUNT(snap.id) FILTER (
            WHERE snap."documentUrl" IS NOT NULL AND snap.status::text <> 'NOT_ON_IREV'
          )::int AS "publishedPus",
          COUNT(snap.id) FILTER (WHERE snap.status::text = 'OCR_READY')::int AS "readablePus",
          COUNT(snap.id) FILTER (WHERE snap.status::text = 'OCR_FAILED')::int AS "failedPus",
          COUNT(snap.id) FILTER (
            WHERE snap."documentUrl" IS NOT NULL AND snap.status::text = 'FETCHED'
          )::int AS "pendingOcrPus"
        FROM state_assembly_constituencies c
        JOIN states st ON st.id = c."stateId"
        LEFT JOIN wards w ON w."constituencyId" = c.id
        LEFT JOIN polling_units pu ON pu."wardId" = w.id
        LEFT JOIN irev_pu_snapshots snap
          ON snap."pollingUnitId" = pu.id AND snap."campaignId" = ${campaignId} AND snap."contestId" = ${this.contestId()}
        WHERE c."stateId" = ${scope.stateId}
        GROUP BY c.id, c.name, st.code, st.zone, st.name
        ORDER BY c.name ASC
      `;
    }

    if (scope.level === 'state') {
      return this.prisma.$queryRaw<CoverageRow[]>`
        SELECT
          l.id AS "scopeId",
          l.name AS "scopeName",
          st.code AS "stateCode",
          st.zone AS "stateZone",
          st.name AS "stateName",
          COUNT(pu.id)::int AS "totalPus",
          COUNT(snap.id) FILTER (
            WHERE snap."documentUrl" IS NOT NULL AND snap.status::text <> 'NOT_ON_IREV'
          )::int AS "publishedPus",
          COUNT(snap.id) FILTER (WHERE snap.status::text = 'OCR_READY')::int AS "readablePus",
          COUNT(snap.id) FILTER (WHERE snap.status::text = 'OCR_FAILED')::int AS "failedPus",
          COUNT(snap.id) FILTER (
            WHERE snap."documentUrl" IS NOT NULL AND snap.status::text = 'FETCHED'
          )::int AS "pendingOcrPus"
        FROM lgas l
        JOIN states st ON st.id = l."stateId"
        JOIN wards w ON w."lgaId" = l.id
        JOIN polling_units pu ON pu."wardId" = w.id
        LEFT JOIN irev_pu_snapshots snap
          ON snap."pollingUnitId" = pu.id AND snap."campaignId" = ${campaignId} AND snap."contestId" = ${this.contestId()}
        WHERE st.id = ${scope.stateId}
        GROUP BY l.id, l.name, st.code, st.zone, st.name
        ORDER BY l.name ASC
      `;
    }

    return this.prisma.$queryRaw<CoverageRow[]>`
      SELECT
        st.id AS "scopeId",
        st.name AS "scopeName",
        st.code AS "stateCode",
        st.zone AS "stateZone",
        NULL::text AS "stateName",
        COUNT(pu.id)::int AS "totalPus",
        COUNT(snap.id) FILTER (
          WHERE snap."documentUrl" IS NOT NULL AND snap.status::text <> 'NOT_ON_IREV'
        )::int AS "publishedPus",
        COUNT(snap.id) FILTER (WHERE snap.status::text = 'OCR_READY')::int AS "readablePus",
        COUNT(snap.id) FILTER (WHERE snap.status::text = 'OCR_FAILED')::int AS "failedPus",
        COUNT(snap.id) FILTER (
          WHERE snap."documentUrl" IS NOT NULL AND snap.status::text = 'FETCHED'
        )::int AS "pendingOcrPus"
      FROM states st
      JOIN lgas l ON l."stateId" = st.id
      JOIN wards w ON w."lgaId" = l.id
      JOIN polling_units pu ON pu."wardId" = w.id
      LEFT JOIN irev_pu_snapshots snap
        ON snap."pollingUnitId" = pu.id AND snap."campaignId" = ${campaignId}
      GROUP BY st.id, st.name, st.code, st.zone
      ORDER BY st.name ASC
    `;
  }

  private async loadVoteAggregates(
    campaignId: string,
    scope: GeoRollupScope,
    partyColumns: string[],
  ): Promise<Map<string, ScopeAggregate>> {
    if (scope.level === 'seat' && scope.wardIds.length === 0) {
      return new Map();
    }

    const scopeColumn =
      scope.level === 'ward'
        ? Prisma.sql`pu.id`
        : scope.level === 'lga' || scope.level === 'seat'
          ? Prisma.sql`w.id`
          : scope.level === 'constituency'
            ? Prisma.sql`c.id`
            : scope.level === 'state'
              ? Prisma.sql`l.id`
              : Prisma.sql`st.id`;
    const geoFilter =
      scope.level === 'ward'
        ? Prisma.sql`AND w.id = ${scope.wardId}`
        : scope.level === 'seat'
          ? Prisma.sql`AND w.id IN (${Prisma.join(scope.wardIds)})`
          : scope.level === 'constituency'
            ? Prisma.sql`AND c."stateId" = ${scope.stateId}`
            : scope.level === 'lga'
              ? Prisma.sql`AND l.id = ${scope.lgaId}`
              : scope.level === 'state'
                ? Prisma.sql`AND st.id = ${scope.stateId}`
                : Prisma.empty;
    const constituencyJoin =
      scope.level === 'constituency'
        ? Prisma.sql`JOIN state_assembly_constituencies c ON c.id = w."constituencyId"`
        : Prisma.empty;

    const rows = await this.prisma.$queryRaw<Array<{ scopeId: string; ocrExtract: unknown }>>`
      SELECT
        ${scopeColumn} AS "scopeId",
        snap."ocrExtract" AS "ocrExtract"
      FROM irev_pu_snapshots snap
      JOIN polling_units pu ON pu.id = snap."pollingUnitId"
      JOIN wards w ON w.id = pu."wardId"
      JOIN lgas l ON l.id = w."lgaId"
      JOIN states st ON st.id = l."stateId"
      ${constituencyJoin}
      WHERE snap."campaignId" = ${campaignId}
        AND snap."contestId" = ${this.contestId()}
        AND snap.status::text = 'OCR_READY'
        AND snap."ocrExtract" IS NOT NULL
        ${geoFilter}
    `;

    const byScope = new Map<string, ScopeAggregate>();
    for (const row of rows) {
      const parsed = parseOcrExtract(row.ocrExtract, partyColumns);
      const bucket =
        byScope.get(row.scopeId) ??
        ({
          partyResults: emptyPartyTotals(partyColumns),
          totalVotes: 0,
          registeredVoters: 0,
          votesCast: 0,
          accreditedVoters: 0,
        } satisfies ScopeAggregate);

      for (const code of partyColumns) {
        bucket.partyResults[code] = (bucket.partyResults[code] ?? 0) + (parsed.parties[code] ?? 0);
      }
      bucket.registeredVoters += parsed.registeredVoters;
      bucket.votesCast += parsed.votesCast;
      bucket.accreditedVoters += parsed.accreditedVoters;
      bucket.totalVotes = Object.values(bucket.partyResults).reduce((sum, value) => sum + value, 0);
      byScope.set(row.scopeId, bucket);
    }

    return byScope;
  }
}
