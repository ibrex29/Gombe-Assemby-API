import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  CampaignRole,
  CollationLevel,
  CollationResultStatus,
  JwtPayload,
  ScopeType,
  isCampaignAdminRole,
  parsePartyTotals,
} from '@electromon/shared';
import { Prisma } from '@electromon/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContestService, type ResolvedContest } from '../../common/contest/contest.service';
import { DeploymentScopeService } from '../../common/deployment-scope/deployment-scope.service';
import { CollationBrowseService } from '../collation/collation-browse.service';
import {
  getLgaScopeId,
  getStateScopeId,
  getWardScopeId,
  isLgaScopedUser,
  isStateScopedUser,
  isWardScopedUser,
} from '../../common/scoping/campaign-scope';
import {
  irevVerificationSortRank,
  resolveIrevVerification,
  type IrevVerification,
} from './irev-verification';
import { IrevClient } from './irev.client';
import { IrevElectionResolver } from './irev-election.resolver';
import { IrevOfficialStatsService, type StatePortalEstimate } from './irev-official-stats.service';
import { IrevQueueService } from './irev-queue.service';
import {
  ATTENTION_FEED_WINDOW_MINUTES,
  attachAttention,
  clusterAttentionRows,
  explainIrevAttention,
  summarizeVotesAtRisk,
  type IrevAttentionCluster,
  type IrevAttentionFeed,
  type IrevVotesAtRisk,
  type IrevVotesAtRiskPu,
} from './irev-attention';

export type IrevQueueFilter =
  | 'ALL'
  | 'ATTENTION'
  | 'READABLE'
  | 'INVESTIGATE'
  | 'MATCH'
  | 'MISMATCH'
  | 'PENDING'
  | 'IREV_MISSING'
  | 'UNREADABLE'
  | 'NOT_CHECKED'
  | 'INEC_ONLY'
  | 'CAMPAIGN_ONLY'
  | 'BOTH_PRESENT'
  | 'AWAITING_IREV'
  | 'REPLACED';

export type IrevCorpusScope = 'national' | 'state' | 'lga' | 'ward' | 'pu';

const SUBMITTED_STATUSES: CollationResultStatus[] = [
  CollationResultStatus.SUBMITTED,
  CollationResultStatus.APPROVED,
  CollationResultStatus.REJECTED,
  CollationResultStatus.DRAFT,
];

type CorpusSqlRow = {
  totalPollingUnits: number;
  inecPublished: number;
  campaignSubmitted: number;
  overlapBoth: number;
  inecOnly: number;
  campaignOnly: number;
  verifiedAligned: number;
  verifiedMismatch: number;
  investigate: number;
  pending: number;
  notChecked: number;
  irevMissing: number;
  unreadable: number;
  replaced: number;
};

type QueueSourceRow = {
  id: string;
  scopeId: string;
  status: string;
  partyResults: unknown;
  irevVerification: unknown;
  irevVerifiedAt: Date | null;
  submittedAt: Date | null;
  ec8aPhotoUrls?: string[];
  votesCast?: number | null;
  registeredVoters?: number | null;
  accreditedVoters?: number | null;
  invalidVotes?: number | null;
  ballotPapersIssued?: number | null;
  unusedBallotPapers?: number | null;
  spoiledBallotPapers?: number | null;
  usedBallotPapers?: number | null;
  inecPublished?: boolean;
  irevDocumentUrl?: string | null;
  puName?: string;
  puCode?: string;
  wardName?: string;
  lgaName?: string;
  stateName?: string;
};

type StateCorpusSqlRow = CorpusSqlRow & {
  stateId: string;
  stateCode: string;
  stateName: string;
  zone: string | null;
};

type LgaCorpusSqlRow = CorpusSqlRow & {
  lgaId: string;
  lgaName: string;
  stateName: string;
};

type WardCorpusSqlRow = CorpusSqlRow & {
  wardId: string;
  wardCode: string | null;
  wardName: string;
  lgaName: string;
};

export type IrevGeoNavLevel = 'state' | 'lga' | 'ward' | 'pu';

export type IrevGeoNavBreadcrumb = {
  level: IrevGeoNavLevel | 'national';
  id?: string;
  label: string;
};

export type IrevGeoNavItem = {
  id: string;
  name: string;
  code?: string;
  subtitle?: string;
  totalPollingUnits: number;
  campaignSubmitted: number;
  inecPublished: number;
  gapScore: number;
  zone?: string | null;
};

export type IrevGeoNav = {
  level: IrevGeoNavLevel;
  breadcrumbs: IrevGeoNavBreadcrumb[];
  items: IrevGeoNavItem[];
};

@Injectable()
export class IrevCommandCenterService {
  constructor(
    private prisma: PrismaService,
    private browse: CollationBrowseService,
    private client: IrevClient,
    private officialStats: IrevOfficialStatsService,
    private queue: IrevQueueService,
    private deploymentScope: DeploymentScopeService,
    private contests: ContestService,
    private irevElections: IrevElectionResolver,
  ) {}

  async getCommandCenter(
    user: JwtPayload,
    params: {
      page?: number;
      limit?: number;
      search?: string;
      status?: string;
      lgaId?: string;
      wardId?: string;
      stateId?: string;
      view?: string;
    },
  ) {
    if (!user.campaignId) throw new ForbiddenException('No active campaign membership');

    const context = await this.browse.getContext(user);
    const safeLimit = Math.min(100, Math.max(1, Number(params.limit) || 25));
    const safePage = Math.max(1, Number(params.page) || 1);
    const status = this.parseFilter(params.status);
    const search = params.search?.trim();
    const view = params.view === 'triage' ? 'triage' : 'overview';

    const corpusScope = this.resolveCorpusScope(user, context);
    const geoScope = this.resolveGeoScope(user, context, {
      stateId: params.stateId,
      lgaId: params.lgaId,
      wardId: params.wardId,
    });

    const browseLevel = this.resolveBrowseLevel(user, context, geoScope, search);
    const showPuQueue = view === 'triage' || browseLevel === 'pu';

    const scopeIds = showPuQueue
      ? await this.resolveScopePuIds(user, context, {
          lgaId: geoScope.lgaId,
          wardId: geoScope.wardId,
          stateId: geoScope.stateId,
          search,
        })
      : null;

    const contest = await this.contests.active(user.campaignId);
    const [corpus, stateGrid, electionConfig] = await Promise.all([
      this.loadCorpusMetrics(user.campaignId, geoScope),
      corpusScope === 'national' || corpusScope === 'state'
        ? this.loadStateGrid(user.campaignId, geoScope.stateId)
        : Promise.resolve([]),
      this.prisma.irevElectionConfig.findUnique({
        where: { contestId: contest.id },
        select: { electionLabel: true, lastSyncAt: true, irevElectionId: true },
      }),
    ]);

    const focusStateId =
      geoScope.stateId ?? (stateGrid.length === 1 ? stateGrid[0]?.stateId : undefined);
    const lgaGrid = focusStateId
      ? this.mapLgaGrid(await this.loadLgaGrid(user.campaignId, focusStateId))
      : [];

    const summary = this.corpusToSummary(corpus);
    const geoScopeIds = showPuQueue
      ? scopeIds
      : await this.resolveScopePuIds(user, context, {
          lgaId: geoScope.lgaId,
          wardId: geoScope.wardId,
          stateId: geoScope.stateId,
        });
    const partyDrift = await this.buildPartyDrift(user.campaignId, geoScopeIds, context.partyColumns);
    const attention = await this.loadAttention(
      user.campaignId,
      context.clientPartyCode,
      context.partyColumns,
      geoScopeIds,
    );

    let total = 0;
    let pageRows: Awaited<ReturnType<IrevCommandCenterService['mapQueueRows']>> = [];

    if (showPuQueue) {
      const baseWhere = this.baseResultWhere(user.campaignId, scopeIds);
      const queueWhere = this.applyStatusFilter(baseWhere, status, user.campaignId, scopeIds);
      const [queueTotal, rawRows] = await Promise.all([
        this.countQueue(queueWhere, status, user.campaignId, scopeIds),
        this.fetchQueueRows(queueWhere, status, user.campaignId, scopeIds, safeLimit),
      ]);
      total = queueTotal;
      const sorted = await this.mapQueueRows(rawRows, context, user.campaignId);
      const start = (safePage - 1) * safeLimit;
      pageRows = sorted.slice(start, start + safeLimit);
    }

    const scopeLabel = await this.buildScopeLabel(corpusScope, geoScope, context, stateGrid);
    const resolvedElection = await this.resolveCommandElection(contest, geoScope);
    const electionId = resolvedElection.electionId;

    const submissionRace = await this.officialStats.buildSubmissionRace({
      electionId,
      scopeLabel,
      campaignSubmitted: corpus.campaignSubmitted,
      campaignTotalPollingUnits: corpus.totalPollingUnits,
    });
    const enrichedStateGrid =
      stateGrid.length && submissionRace
        ? this.officialStats.enrichStateGridWithPortalEstimates(stateGrid, submissionRace)
        : stateGrid;

    const focusStateRow = geoScope.stateId
      ? (enrichedStateGrid.find((row) => row.stateId === geoScope.stateId) as
          | (typeof enrichedStateGrid)[number] & { officialPortal?: StatePortalEstimate | null }
          | undefined)
      : undefined;
    const scopedSubmissionRace =
      focusStateRow?.officialPortal && electionId
        ? this.officialStats.buildStateSubmissionRace({
            electionId,
            stateCode: focusStateRow.stateCode,
            stateName: focusStateRow.stateName,
            campaignSubmitted: corpus.campaignSubmitted,
            totalPollingUnits: focusStateRow.totalPollingUnits,
            officialPortal: focusStateRow.officialPortal,
            nationalRace: submissionRace,
          }) ?? submissionRace
        : submissionRace;

    const geoNav = await this.buildGeoNav(
      browseLevel,
      user,
      context,
      geoScope,
      enrichedStateGrid,
      user.campaignId,
      Boolean(search),
    );

    return {
      enabled: this.client.isEnabled(),
      view,
      corpusScope,
      scopeLabel,
      clientPartyCode: context.clientPartyCode,
      partyColumns: context.partyColumns,
      trackedParties: context.trackedParties,
      election: {
        label: resolvedElection.label,
        irevElectionId: resolvedElection.electionId,
        lastSyncAt: electionConfig?.lastSyncAt?.toISOString() ?? null,
      },
      corpus: {
        ...corpus,
        inecPublishPercent: pct(corpus.inecPublished, corpus.totalPollingUnits),
        campaignSubmitPercent: pct(corpus.campaignSubmitted, corpus.totalPollingUnits),
        trustPercent: pct(corpus.verifiedAligned, corpus.overlapBoth),
        verificationPercent: pct(corpus.verifiedAligned + corpus.verifiedMismatch, corpus.campaignSubmitted),
      },
      stateGrid: enrichedStateGrid,
      lgaGrid,
      submissionRace: scopedSubmissionRace,
      geoScope,
      geoNav,
      summary: {
        ...summary,
        coveragePercent: pct(summary.checked, summary.submitted),
        partyDrift,
      },
      votesAtRisk: attention.votesAtRisk,
      clusters: attention.clusters,
      feed: attention.feed,
      queue: {
        data: pageRows,
        meta: {
          page: safePage,
          limit: safeLimit,
          total,
          totalPages: Math.max(1, Math.ceil(total / safeLimit)),
        },
        filter: status,
      },
    };
  }

  async queuePendingChecks(
    user: JwtPayload,
    params: {
      stateId?: string;
      lgaId?: string;
      wardId?: string;
      search?: string;
      limit?: number;
    },
  ) {
    if (!user.campaignId) throw new ForbiddenException('No active campaign membership');
    if (!this.client.isEnabled()) {
      throw new ForbiddenException('IReV comparison is disabled');
    }

    const context = await this.browse.getContext(user);
    const geoScope = this.resolveGeoScope(user, context, {
      stateId: params.stateId,
      lgaId: params.lgaId,
      wardId: params.wardId,
    });
    const scopeIds = await this.resolveScopePuIds(user, context, {
      lgaId: geoScope.lgaId,
      wardId: geoScope.wardId,
      stateId: geoScope.stateId,
      search: params.search?.trim(),
    });

    const configuredLimit = Number.parseInt(process.env.IREV_BULK_QUEUE_LIMIT ?? '500', 10) || 500;
    const safeLimit = Math.min(1000, Math.max(1, params.limit ?? configuredLimit));

    const pendingWhere: Prisma.CollationResultWhereInput = {
      ...this.baseResultWhere(user.campaignId, scopeIds),
      OR: [
        { irevVerification: { equals: Prisma.DbNull } },
        { irevVerification: { path: ['status'], equals: 'PENDING' } },
        { irevVerification: { path: ['status'], equals: 'IREV_MISSING' } },
      ],
    };

    const [totalPending, rows] = await Promise.all([
      this.prisma.collationResult.count({ where: pendingWhere }),
      this.prisma.collationResult.findMany({
        where: pendingWhere,
        select: { id: true, scopeId: true, campaignId: true, irevVerification: true },
        orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
        take: safeLimit,
      }),
    ]);

    for (const row of rows) {
      const verification = resolveIrevVerification(row);
      this.queue.publish({
        collationResultId: row.id,
        pollingUnitId: row.scopeId,
        campaignId: row.campaignId,
        force: verification?.status === 'PENDING',
      });
    }

    const catalogedWards = await this.enqueueScopeCatalog(user.campaignId, geoScope);

    const corpusScope = this.resolveCorpusScope(user, context);
    const scopeLabel = await this.buildScopeLabel(corpusScope, geoScope, context, []);

    return {
      queued: rows.length,
      catalogedWards,
      totalPending,
      limit: safeLimit,
      scopeLabel,
      truncated: totalPending > rows.length,
    };
  }

  private async resolveCommandElection(
    contest: ResolvedContest,
    geoScope: { wardId?: string },
  ) {
    const seat = this.contests.seat();
    const electionId = geoScope.wardId
      ? await this.irevElections.forWard(contest, geoScope.wardId)
      : this.irevElections.forSeat(contest, seat);
    const label = seat
      ? `${seat.name} House of Assembly`
      : contest.irevElectionLabel ??
        this.deploymentScope.irevElectionLabel() ??
        'INEC IReV';
    return { electionId, label };
  }

  private async enqueueScopeCatalog(
    campaignId: string,
    geoScope: { stateId?: string; lgaId?: string; wardId?: string },
  ) {
    if (geoScope.wardId) {
      this.queue.publish({ campaignId, wardId: geoScope.wardId });
      return 1;
    }
    if (geoScope.lgaId) {
      const wards = await this.prisma.ward.findMany({
        where: { lgaId: geoScope.lgaId },
        select: { id: true },
        take: 80,
      });
      for (const ward of wards) {
        this.queue.publish({ campaignId, wardId: ward.id });
      }
      return wards.length;
    }
    if (geoScope.stateId) {
      const wards = await this.prisma.ward.findMany({
        where: { lga: { stateId: geoScope.stateId } },
        select: { id: true },
        take: 40,
      });
      for (const ward of wards) {
        this.queue.publish({ campaignId, wardId: ward.id });
      }
      return wards.length;
    }
    return 0;
  }

  private resolveCorpusScope(
    user: JwtPayload,
    context: Awaited<ReturnType<CollationBrowseService['getContext']>>,
  ): IrevCorpusScope {
    if (user.scopeType === ScopeType.POLLING_UNIT || user.role === CampaignRole.POLLING_AGENT) {
      return 'pu';
    }
    if (isWardScopedUser(user)) return 'ward';
    if (isLgaScopedUser(user)) return 'lga';
    if (isStateScopedUser(user)) return 'state';
    if (
      context.isNational ||
      (isCampaignAdminRole(user.role) && !this.deploymentScope.isStateLocked())
    ) {
      return 'national';
    }
    return 'state';
  }

  private resolveGeoScope(
    user: JwtPayload,
    context: Awaited<ReturnType<CollationBrowseService['getContext']>>,
    requested: { stateId?: string; lgaId?: string; wardId?: string },
  ) {
    if (isWardScopedUser(user)) {
      return this.clampSeatGeo(
        context,
        this.deploymentScope.clampGeoScope({
          wardId: getWardScopeId(user),
          lgaId: context.lgaId ?? undefined,
          stateId: context.stateId,
        }),
      );
    }
    if (isLgaScopedUser(user)) {
      return this.clampSeatGeo(
        context,
        this.deploymentScope.clampGeoScope({
          lgaId: getLgaScopeId(user),
          wardId: requested.wardId,
          stateId: context.stateId,
        }),
      );
    }
    if (isStateScopedUser(user)) {
      return this.clampSeatGeo(
        context,
        this.deploymentScope.clampGeoScope({
          stateId: getStateScopeId(user),
          lgaId: requested.lgaId,
          wardId: requested.wardId,
        }),
      );
    }
    if (!context.isNational) {
      return this.clampSeatGeo(
        context,
        this.deploymentScope.clampGeoScope({
          stateId: context.stateId,
          lgaId: requested.lgaId,
          wardId: requested.wardId,
        }),
      );
    }
    return this.clampSeatGeo(
      context,
      this.deploymentScope.clampGeoScope({
        stateId: requested.stateId,
        lgaId: requested.lgaId,
        wardId: requested.wardId,
      }),
    );
  }

  private clampSeatGeo(
    context: Awaited<ReturnType<CollationBrowseService['getContext']>>,
    geo: { stateId?: string; lgaId?: string; wardId?: string },
  ) {
    const seat = context.activeSeat;
    if (!seat) return geo;
    const wardAllowed = Boolean(geo.wardId && seat.wardIds.includes(geo.wardId));
    return {
      ...geo,
      lgaId: seat.lgaId ?? geo.lgaId,
      wardId: wardAllowed ? geo.wardId : undefined,
    };
  }

  private resolveBrowseLevel(
    user: JwtPayload,
    context: Awaited<ReturnType<CollationBrowseService['getContext']>>,
    geoScope: { stateId?: string; lgaId?: string; wardId?: string },
    search?: string,
  ): IrevGeoNavLevel {
    if (search) return 'pu';
    if (geoScope.wardId) return 'pu';
    if (user.scopeType === ScopeType.POLLING_UNIT || user.role === CampaignRole.POLLING_AGENT) {
      return 'pu';
    }
    if (isWardScopedUser(user)) return 'pu';
    if (geoScope.lgaId) return 'ward';
    if (isLgaScopedUser(user)) return 'ward';
    if (geoScope.stateId) return 'lga';
    if (isStateScopedUser(user)) return 'lga';
    if (
      context.isNational ||
      (isCampaignAdminRole(user.role) && !this.deploymentScope.isStateLocked())
    ) {
      return 'state';
    }
    return 'lga';
  }

  private async mapQueueRows(
    rawRows: QueueSourceRow[],
    context: Awaited<ReturnType<CollationBrowseService['getContext']>>,
    campaignId: string,
  ) {
    const puIds = rawRows.map((row) => row.scopeId);
    const [puMap, snapshots] = await Promise.all([
      this.loadPuMap(puIds),
      this.loadSnapshotTimes(campaignId, puIds),
    ]);
    return rawRows
      .map((row: QueueSourceRow) => {
        const pu = puMap.get(row.scopeId);
        const parties = parsePartyTotals(row.partyResults, context.partyColumns);
        const clientVotes = context.clientPartyCode
          ? (parties[context.clientPartyCode] ?? 0)
          : null;
        let verification = resolveIrevVerification(row);
        if (verification) {
          verification = attachAttention(verification, {
            clientPartyCode: context.clientPartyCode,
            agentPartyResults: parties,
          });
        }
        const snapshot = snapshots.get(row.scopeId);
        return {
          resultId: row.id,
          pollingUnitId: row.scopeId,
          pollingUnitName: pu?.name?.toUpperCase() ?? row.puName?.toUpperCase() ?? 'Unknown PU',
          pollingUnitCode: pu?.code ?? row.puCode ?? '',
          wardId: pu?.ward.id,
          wardName: pu?.ward.name ?? row.wardName ?? '',
          lgaId: pu?.ward.lga.id,
          lgaName: pu?.ward.lga.name ?? row.lgaName ?? '',
          stateId: pu?.ward.lga.state.id,
          stateName: pu?.ward.lga.state.name ?? row.stateName ?? '',
          latitude: pu?.latitude ?? null,
          longitude: pu?.longitude ?? null,
          resultStatus: row.status,
          clientPartyVotes: clientVotes,
          clientPartyIrevVotes: verification?.clientPartyIrev ?? null,
          clientPartyDelta: verification?.clientPartyDelta ?? null,
          totalVotes: Object.values(parties).reduce((sum, n) => sum + n, 0),
          partyResults: parties,
          ec8aPhotoUrls: row.ec8aPhotoUrls ?? [],
          votesCast: row.votesCast ?? null,
          registeredVoters: row.registeredVoters ?? null,
          accreditedVoters: row.accreditedVoters ?? null,
          invalidVotes: row.invalidVotes ?? null,
          ballotPapersIssued: row.ballotPapersIssued ?? null,
          unusedBallotPapers: row.unusedBallotPapers ?? null,
          spoiledBallotPapers: row.spoiledBallotPapers ?? null,
          usedBallotPapers: row.usedBallotPapers ?? null,
          irevDocumentUrl:
            verification?.irevDocumentUrl ?? row.irevDocumentUrl ?? null,
          irevVerification: verification,
          irevVerifiedAt: row.irevVerifiedAt?.toISOString() ?? null,
          irevUploadedAt: snapshot?.uploadedAt?.toISOString() ?? null,
          irevFetchedAt: snapshot?.fetchedAt?.toISOString() ?? null,
          submittedAt: row.submittedAt?.toISOString() ?? null,
          inecPublished: row.inecPublished ?? Boolean(verification?.irevDocumentUrl ?? row.irevDocumentUrl),
          attentionWhy: verification
            ? explainIrevAttention({
                status: verification.status,
                partyCode: context.clientPartyCode,
                agent: verification.clientPartyAgent ?? null,
                irev: verification.clientPartyIrev ?? null,
                delta: verification.clientPartyDelta ?? null,
                ocrConfidence: verification.ocrConfidence ?? null,
                replacedAt: verification.replacedAt ?? null,
                submittedAt: row.submittedAt?.toISOString() ?? null,
                publishedAt: snapshot?.uploadedAt?.toISOString() ?? null,
                summaryDiffs: verification.diffs.map((diff) => ({
                  field: diff.field,
                  label: diff.label,
                  agent: diff.agent,
                  irev: diff.irev,
                })),
              })
            : null,
          sortRank: irevVerificationSortRank(verification),
        };
      })
      .sort((a, b) => {
        if (a.sortRank !== b.sortRank) return a.sortRank - b.sortRank;
        const aDelta = Math.abs(a.clientPartyDelta ?? 0);
        const bDelta = Math.abs(b.clientPartyDelta ?? 0);
        if (aDelta !== bDelta) return bDelta - aDelta;
        const aTime = a.irevVerifiedAt ?? a.submittedAt ?? '';
        const bTime = b.irevVerifiedAt ?? b.submittedAt ?? '';
        return bTime.localeCompare(aTime);
      })
      .map(({ sortRank: _sortRank, ...row }) => row);
  }

  private async buildGeoNav(
    level: IrevGeoNavLevel,
    user: JwtPayload,
    context: Awaited<ReturnType<CollationBrowseService['getContext']>>,
    geoScope: { stateId?: string; lgaId?: string; wardId?: string },
    stateGrid: Awaited<ReturnType<IrevCommandCenterService['loadStateGrid']>>,
    campaignId: string,
    isSearch: boolean,
  ): Promise<IrevGeoNav> {
    const breadcrumbs = await this.buildGeoBreadcrumbs(geoScope, context);
    if (isSearch) {
      return { level: 'pu', breadcrumbs, items: [] };
    }
    if (level === 'pu') {
      return { level: 'pu', breadcrumbs, items: [] };
    }

    if (level === 'state') {
      const items: IrevGeoNavItem[] = stateGrid.map((row) => ({
        id: row.stateId,
        name: row.stateName,
        code: row.stateCode,
        subtitle: row.zone ?? undefined,
        totalPollingUnits: row.totalPollingUnits,
        campaignSubmitted: row.campaignSubmitted,
        inecPublished: row.inecPublished,
        gapScore: row.gapScore,
        zone: row.zone,
      }));
      return { level: 'state', breadcrumbs, items };
    }

    const stateId = geoScope.stateId ?? context.stateId;
    if (!stateId) {
      return { level, breadcrumbs, items: [] };
    }

    if (level === 'lga') {
      const rows = await this.loadLgaGrid(campaignId, stateId);
      return {
        level: 'lga',
        breadcrumbs,
        items: rows.map((row) => ({
          id: row.lgaId,
          name: row.lgaName,
          subtitle: row.stateName,
          totalPollingUnits: row.totalPollingUnits,
          campaignSubmitted: row.campaignSubmitted,
          inecPublished: row.inecPublished,
          gapScore: row.investigate + row.notChecked + row.inecOnly,
        })),
      };
    }

    const lgaId = geoScope.lgaId ?? (isLgaScopedUser(user) ? getLgaScopeId(user) : undefined);
    if (!lgaId) {
      return { level, breadcrumbs, items: [] };
    }

    const rows = await this.loadWardGrid(campaignId, lgaId);
    return {
      level: 'ward',
      breadcrumbs,
      items: rows.map((row) => ({
        id: row.wardId,
        name: row.wardName,
        code: row.wardCode ?? undefined,
        subtitle: row.lgaName,
        totalPollingUnits: row.totalPollingUnits,
        campaignSubmitted: row.campaignSubmitted,
        inecPublished: row.inecPublished,
        gapScore: row.investigate + row.notChecked + row.inecOnly,
      })),
    };
  }

  private async buildGeoBreadcrumbs(
    geoScope: { stateId?: string; lgaId?: string; wardId?: string },
    context: Awaited<ReturnType<CollationBrowseService['getContext']>>,
  ): Promise<IrevGeoNavBreadcrumb[]> {
    const crumbs: IrevGeoNavBreadcrumb[] = [
      { level: 'national', label: context.isNational ? 'NIGERIA' : (context.stateName ?? 'NIGERIA') },
    ];

    const stateId = geoScope.stateId ?? (!context.isNational ? context.stateId : undefined);
    if (stateId) {
      const state = await this.prisma.state.findUnique({
        where: { id: stateId },
        select: { id: true, name: true },
      });
      if (state) crumbs.push({ level: 'state', id: state.id, label: state.name });
    }

    if (geoScope.lgaId) {
      const lga = await this.prisma.lGA.findUnique({
        where: { id: geoScope.lgaId },
        select: { id: true, name: true },
      });
      if (lga) crumbs.push({ level: 'lga', id: lga.id, label: lga.name });
    }

    if (geoScope.wardId) {
      const ward = await this.prisma.ward.findUnique({
        where: { id: geoScope.wardId },
        select: { id: true, name: true },
      });
      if (ward) crumbs.push({ level: 'ward', id: ward.id, label: ward.name });
    }

    return crumbs;
  }

  private async loadLgaGrid(campaignId: string, stateId: string) {
    const rows = await this.prisma.$queryRaw<LgaCorpusSqlRow[]>`
      WITH pu_base AS (
        SELECT p.id AS pu_id, l.id AS "lgaId", l.name AS "lgaName", s.name AS "stateName"
        FROM polling_units p
        INNER JOIN wards w ON w.id = p."wardId"
        INNER JOIN lgas l ON l.id = w."lgaId"
        INNER JOIN states s ON s.id = l."stateId"
        WHERE l."stateId" = ${stateId}
      ),
      inec AS (
        SELECT s."pollingUnitId",
          (s."documentUrl" IS NOT NULL AND s.status::text <> 'NOT_ON_IREV') AS published
        FROM irev_pu_snapshots s
        WHERE s."campaignId" = ${campaignId}
      ),
      agent AS (
        SELECT cr."scopeId" AS pu_id, cr."irevVerification"
        FROM collation_results cr
        WHERE cr."campaignId" = ${campaignId}
          AND cr.level = 'POLLING_UNIT'::"CollationLevel"
          AND cr.status IN (
            'SUBMITTED'::"CollationResultStatus",
            'APPROVED'::"CollationResultStatus",
            'REJECTED'::"CollationResultStatus",
            'DRAFT'::"CollationResultStatus"
          )
      )
      SELECT
        pb."lgaId",
        pb."lgaName",
        pb."stateName",
        COUNT(*)::int AS "totalPollingUnits",
        COUNT(*) FILTER (WHERE COALESCE(inec.published, false))::int AS "inecPublished",
        COUNT(*) FILTER (WHERE agent.pu_id IS NOT NULL)::int AS "campaignSubmitted",
        COUNT(*) FILTER (WHERE COALESCE(inec.published, false) AND agent.pu_id IS NOT NULL)::int AS "overlapBoth",
        COUNT(*) FILTER (WHERE COALESCE(inec.published, false) AND agent.pu_id IS NULL)::int AS "inecOnly",
        COUNT(*) FILTER (WHERE NOT COALESCE(inec.published, false) AND agent.pu_id IS NOT NULL)::int AS "campaignOnly",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'MATCH')::int AS "verifiedAligned",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'MISMATCH')::int AS "verifiedMismatch",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'recommendation' = 'INVESTIGATE')::int AS "investigate",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'PENDING')::int AS "pending",
        COUNT(*) FILTER (WHERE agent.pu_id IS NOT NULL AND agent."irevVerification" IS NULL)::int AS "notChecked",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'IREV_MISSING')::int AS "irevMissing",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'UNREADABLE')::int AS "unreadable",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'REPLACED')::int AS "replaced"
      FROM pu_base pb
      LEFT JOIN inec ON inec."pollingUnitId" = pb.pu_id
      LEFT JOIN agent ON agent.pu_id = pb.pu_id
      GROUP BY pb."lgaId", pb."lgaName", pb."stateName"
      ORDER BY pb."lgaName" ASC
    `;
    return rows;
  }

  private async loadWardGrid(campaignId: string, lgaId: string) {
    const rows = await this.prisma.$queryRaw<WardCorpusSqlRow[]>`
      WITH pu_base AS (
        SELECT p.id AS pu_id, w.id AS "wardId", w."registrationAreaCode" AS "wardCode", w.name AS "wardName", l.name AS "lgaName"
        FROM polling_units p
        INNER JOIN wards w ON w.id = p."wardId"
        INNER JOIN lgas l ON l.id = w."lgaId"
        WHERE w."lgaId" = ${lgaId}
      ),
      inec AS (
        SELECT s."pollingUnitId",
          (s."documentUrl" IS NOT NULL AND s.status::text <> 'NOT_ON_IREV') AS published
        FROM irev_pu_snapshots s
        WHERE s."campaignId" = ${campaignId}
      ),
      agent AS (
        SELECT cr."scopeId" AS pu_id, cr."irevVerification"
        FROM collation_results cr
        WHERE cr."campaignId" = ${campaignId}
          AND cr.level = 'POLLING_UNIT'::"CollationLevel"
          AND cr.status IN (
            'SUBMITTED'::"CollationResultStatus",
            'APPROVED'::"CollationResultStatus",
            'REJECTED'::"CollationResultStatus",
            'DRAFT'::"CollationResultStatus"
          )
      )
      SELECT
        pb."wardId",
        pb."wardCode",
        pb."wardName",
        pb."lgaName",
        COUNT(*)::int AS "totalPollingUnits",
        COUNT(*) FILTER (WHERE COALESCE(inec.published, false))::int AS "inecPublished",
        COUNT(*) FILTER (WHERE agent.pu_id IS NOT NULL)::int AS "campaignSubmitted",
        COUNT(*) FILTER (WHERE COALESCE(inec.published, false) AND agent.pu_id IS NOT NULL)::int AS "overlapBoth",
        COUNT(*) FILTER (WHERE COALESCE(inec.published, false) AND agent.pu_id IS NULL)::int AS "inecOnly",
        COUNT(*) FILTER (WHERE NOT COALESCE(inec.published, false) AND agent.pu_id IS NOT NULL)::int AS "campaignOnly",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'MATCH')::int AS "verifiedAligned",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'MISMATCH')::int AS "verifiedMismatch",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'recommendation' = 'INVESTIGATE')::int AS "investigate",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'PENDING')::int AS "pending",
        COUNT(*) FILTER (WHERE agent.pu_id IS NOT NULL AND agent."irevVerification" IS NULL)::int AS "notChecked",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'IREV_MISSING')::int AS "irevMissing",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'UNREADABLE')::int AS "unreadable",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'REPLACED')::int AS "replaced"
      FROM pu_base pb
      LEFT JOIN inec ON inec."pollingUnitId" = pb.pu_id
      LEFT JOIN agent ON agent.pu_id = pb.pu_id
      GROUP BY pb."wardId", pb."wardCode", pb."wardName", pb."lgaName"
      ORDER BY pb."wardName" ASC
    `;
    return rows;
  }

  private async buildScopeLabel(
    corpusScope: IrevCorpusScope,
    geoScope: { stateId?: string; lgaId?: string; wardId?: string },
    context: Awaited<ReturnType<CollationBrowseService['getContext']>>,
    stateGrid: Awaited<ReturnType<IrevCommandCenterService['loadStateGrid']>>,
  ) {
    if (geoScope.wardId) {
      const ward = await this.prisma.ward.findUnique({
        where: { id: geoScope.wardId },
        select: { name: true },
      });
      if (ward?.name) return ward.name;
    }
    if (geoScope.lgaId) {
      const lga = await this.prisma.lGA.findUnique({
        where: { id: geoScope.lgaId },
        select: { name: true },
      });
      if (lga?.name) return lga.name;
    }
    if (geoScope.stateId) {
      const state = stateGrid.find((row) => row.stateId === geoScope.stateId);
      if (state?.stateName) return state.stateName;
      const dbState = await this.prisma.state.findUnique({
        where: { id: geoScope.stateId },
        select: { name: true },
      });
      if (dbState?.name) return dbState.name;
    }
    if (corpusScope === 'national') return 'NIGERIA';
    return context.stateName ?? 'NIGERIA';
  }

  private corpusToSummary(corpus: CorpusSqlRow) {
    const checked =
      corpus.verifiedAligned +
      corpus.verifiedMismatch +
      corpus.pending +
      corpus.irevMissing +
      corpus.unreadable +
      corpus.replaced;
    return {
      submitted: corpus.campaignSubmitted,
      checked,
      notChecked: corpus.notChecked,
      match: corpus.verifiedAligned,
      mismatch: corpus.verifiedMismatch,
      pending: corpus.pending,
      irevMissing: corpus.irevMissing,
      unreadable: corpus.unreadable,
      replaced: corpus.replaced,
      investigate: corpus.investigate,
      aligned: corpus.verifiedAligned,
      waiting: corpus.pending + corpus.irevMissing,
    };
  }

  private geoFilters(scope: { stateId?: string; lgaId?: string; wardId?: string }) {
    return {
      state: scope.stateId ? Prisma.sql`AND l."stateId" = ${scope.stateId}` : Prisma.empty,
      lga: scope.lgaId ? Prisma.sql`AND l.id = ${scope.lgaId}` : Prisma.empty,
      ward: scope.wardId ? Prisma.sql`AND w.id = ${scope.wardId}` : Prisma.empty,
    };
  }

  private async loadCorpusMetrics(
    campaignId: string,
    scope: { stateId?: string; lgaId?: string; wardId?: string },
  ): Promise<CorpusSqlRow> {
    const filters = this.geoFilters(scope);
    const [row] = await this.prisma.$queryRaw<CorpusSqlRow[]>`
      WITH pu_base AS (
        SELECT p.id AS pu_id
        FROM polling_units p
        INNER JOIN wards w ON w.id = p."wardId"
        INNER JOIN lgas l ON l.id = w."lgaId"
        WHERE TRUE
        ${filters.state}
        ${filters.lga}
        ${filters.ward}
      ),
      inec AS (
        SELECT s."pollingUnitId",
          (s."documentUrl" IS NOT NULL AND s.status::text <> 'NOT_ON_IREV') AS published
        FROM irev_pu_snapshots s
        WHERE s."campaignId" = ${campaignId}
      ),
      agent AS (
        SELECT cr."scopeId" AS pu_id, cr."irevVerification"
        FROM collation_results cr
        WHERE cr."campaignId" = ${campaignId}
          AND cr.level = 'POLLING_UNIT'::"CollationLevel"
          AND cr.status IN (
            'SUBMITTED'::"CollationResultStatus",
            'APPROVED'::"CollationResultStatus",
            'REJECTED'::"CollationResultStatus",
            'DRAFT'::"CollationResultStatus"
          )
      )
      SELECT
        COUNT(*)::int AS "totalPollingUnits",
        COUNT(*) FILTER (WHERE COALESCE(inec.published, false))::int AS "inecPublished",
        COUNT(*) FILTER (WHERE agent.pu_id IS NOT NULL)::int AS "campaignSubmitted",
        COUNT(*) FILTER (WHERE COALESCE(inec.published, false) AND agent.pu_id IS NOT NULL)::int AS "overlapBoth",
        COUNT(*) FILTER (WHERE COALESCE(inec.published, false) AND agent.pu_id IS NULL)::int AS "inecOnly",
        COUNT(*) FILTER (WHERE NOT COALESCE(inec.published, false) AND agent.pu_id IS NOT NULL)::int AS "campaignOnly",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'MATCH')::int AS "verifiedAligned",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'MISMATCH')::int AS "verifiedMismatch",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'recommendation' = 'INVESTIGATE')::int AS "investigate",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'PENDING')::int AS "pending",
        COUNT(*) FILTER (WHERE agent.pu_id IS NOT NULL AND agent."irevVerification" IS NULL)::int AS "notChecked",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'IREV_MISSING')::int AS "irevMissing",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'UNREADABLE')::int AS "unreadable",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'REPLACED')::int AS "replaced"
      FROM pu_base pb
      LEFT JOIN inec ON inec."pollingUnitId" = pb.pu_id
      LEFT JOIN agent ON agent.pu_id = pb.pu_id
    `;

    return (
      row ?? {
        totalPollingUnits: 0,
        inecPublished: 0,
        campaignSubmitted: 0,
        overlapBoth: 0,
        inecOnly: 0,
        campaignOnly: 0,
        verifiedAligned: 0,
        verifiedMismatch: 0,
        investigate: 0,
        pending: 0,
        notChecked: 0,
        irevMissing: 0,
        unreadable: 0,
        replaced: 0,
      }
    );
  }

  private async loadStateGrid(campaignId: string, focusStateId?: string) {
    const stateFilter = focusStateId
      ? Prisma.sql`AND s.id = ${focusStateId}`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<StateCorpusSqlRow[]>`
      WITH pu_base AS (
        SELECT p.id AS pu_id, s.id AS "stateId", s.code AS "stateCode", s.name AS "stateName", s.zone
        FROM polling_units p
        INNER JOIN wards w ON w.id = p."wardId"
        INNER JOIN lgas l ON l.id = w."lgaId"
        INNER JOIN states s ON s.id = l."stateId"
        WHERE TRUE
        ${stateFilter}
      ),
      inec AS (
        SELECT s."pollingUnitId",
          (s."documentUrl" IS NOT NULL AND s.status::text <> 'NOT_ON_IREV') AS published
        FROM irev_pu_snapshots s
        WHERE s."campaignId" = ${campaignId}
      ),
      agent AS (
        SELECT cr."scopeId" AS pu_id, cr."irevVerification"
        FROM collation_results cr
        WHERE cr."campaignId" = ${campaignId}
          AND cr.level = 'POLLING_UNIT'::"CollationLevel"
          AND cr.status IN (
            'SUBMITTED'::"CollationResultStatus",
            'APPROVED'::"CollationResultStatus",
            'REJECTED'::"CollationResultStatus",
            'DRAFT'::"CollationResultStatus"
          )
      )
      SELECT
        pb."stateId",
        pb."stateCode",
        pb."stateName",
        pb.zone,
        COUNT(*)::int AS "totalPollingUnits",
        COUNT(*) FILTER (WHERE COALESCE(inec.published, false))::int AS "inecPublished",
        COUNT(*) FILTER (WHERE agent.pu_id IS NOT NULL)::int AS "campaignSubmitted",
        COUNT(*) FILTER (WHERE COALESCE(inec.published, false) AND agent.pu_id IS NOT NULL)::int AS "overlapBoth",
        COUNT(*) FILTER (WHERE COALESCE(inec.published, false) AND agent.pu_id IS NULL)::int AS "inecOnly",
        COUNT(*) FILTER (WHERE NOT COALESCE(inec.published, false) AND agent.pu_id IS NOT NULL)::int AS "campaignOnly",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'MATCH')::int AS "verifiedAligned",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'MISMATCH')::int AS "verifiedMismatch",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'recommendation' = 'INVESTIGATE')::int AS "investigate",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'PENDING')::int AS "pending",
        COUNT(*) FILTER (WHERE agent.pu_id IS NOT NULL AND agent."irevVerification" IS NULL)::int AS "notChecked",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'IREV_MISSING')::int AS "irevMissing",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'UNREADABLE')::int AS "unreadable",
        COUNT(*) FILTER (WHERE agent."irevVerification"->>'status' = 'REPLACED')::int AS "replaced"
      FROM pu_base pb
      LEFT JOIN inec ON inec."pollingUnitId" = pb.pu_id
      LEFT JOIN agent ON agent.pu_id = pb.pu_id
      GROUP BY pb."stateId", pb."stateCode", pb."stateName", pb.zone
      ORDER BY pb."stateName" ASC
    `;

    return rows.map((row) => ({
      ...row,
      inecPublishPercent: pct(row.inecPublished, row.totalPollingUnits),
      campaignSubmitPercent: pct(row.campaignSubmitted, row.totalPollingUnits),
      trustPercent: pct(row.verifiedAligned, row.overlapBoth),
      gapScore: row.investigate + row.notChecked + row.inecOnly,
    }));
  }

  private mapLgaGrid(rows: LgaCorpusSqlRow[]) {
    return rows.map((row) => ({
      ...row,
      inecPublishPercent: pct(row.inecPublished, row.totalPollingUnits),
      campaignSubmitPercent: pct(row.campaignSubmitted, row.totalPollingUnits),
      trustPercent: pct(row.verifiedAligned, row.overlapBoth),
      gapScore: row.investigate + row.notChecked + row.inecOnly,
    }));
  }

  private parseFilter(raw?: string): IrevQueueFilter {
    const allowed: IrevQueueFilter[] = [
      'ALL',
      'ATTENTION',
      'READABLE',
      'INVESTIGATE',
      'MATCH',
      'MISMATCH',
      'PENDING',
      'IREV_MISSING',
      'UNREADABLE',
      'NOT_CHECKED',
      'INEC_ONLY',
      'CAMPAIGN_ONLY',
      'BOTH_PRESENT',
      'AWAITING_IREV',
      'REPLACED',
    ];
    if (raw === 'ATTENTION') return 'READABLE';
    if (raw && allowed.includes(raw as IrevQueueFilter)) return raw as IrevQueueFilter;
    return 'INVESTIGATE';
  }

  private baseResultWhere(
    campaignId: string,
    scopeIds: string[] | null,
  ): Prisma.CollationResultWhereInput {
    const where: Prisma.CollationResultWhereInput = {
      campaignId,
      level: CollationLevel.POLLING_UNIT,
      status: { in: SUBMITTED_STATUSES },
    };
    if (scopeIds) where.scopeId = { in: scopeIds };
    return where;
  }

  private applyStatusFilter(
    base: Prisma.CollationResultWhereInput,
    status: IrevQueueFilter,
    campaignId: string,
    scopeIds: string[] | null,
  ): Prisma.CollationResultWhereInput | 'INEC_ONLY' | 'CAMPAIGN_ONLY' | 'BOTH_PRESENT' {
    if (status === 'INEC_ONLY' || status === 'CAMPAIGN_ONLY' || status === 'BOTH_PRESENT') {
      return status;
    }
    switch (status) {
      case 'INVESTIGATE':
        return {
          ...base,
          irevVerification: { path: ['recommendation'], equals: 'INVESTIGATE' },
        };
      case 'MATCH':
        return { ...base, irevVerification: { path: ['status'], equals: 'MATCH' } };
      case 'MISMATCH':
        return { ...base, irevVerification: { path: ['status'], equals: 'MISMATCH' } };
      case 'PENDING':
        return { ...base, irevVerification: { path: ['status'], equals: 'PENDING' } };
      case 'IREV_MISSING':
        return { ...base, irevVerification: { path: ['status'], equals: 'IREV_MISSING' } };
      case 'UNREADABLE':
        return { ...base, irevVerification: { path: ['status'], equals: 'UNREADABLE' } };
      case 'REPLACED':
        return { ...base, irevVerification: { path: ['status'], equals: 'REPLACED' } };
      case 'NOT_CHECKED':
        return { ...base, irevVerification: { equals: Prisma.DbNull } };
      case 'AWAITING_IREV':
        return {
          ...base,
          OR: [
            { irevVerification: { path: ['status'], equals: 'PENDING' } },
            { irevVerification: { path: ['status'], equals: 'IREV_MISSING' } },
          ],
        };
      case 'READABLE':
        return {
          ...base,
          OR: [
            { irevVerification: { path: ['status'], equals: 'MATCH' } },
            { irevVerification: { path: ['status'], equals: 'MISMATCH' } },
            { irevVerification: { path: ['status'], equals: 'REPLACED' } },
          ],
        };
      case 'ATTENTION':
        return {
          ...base,
          OR: [
            { irevVerification: { equals: Prisma.DbNull } },
            { irevVerification: { path: ['recommendation'], equals: 'INVESTIGATE' } },
            { irevVerification: { path: ['status'], equals: 'PENDING' } },
            { irevVerification: { path: ['status'], equals: 'UNREADABLE' } },
            { irevVerification: { path: ['status'], equals: 'REPLACED' } },
          ],
        };
      case 'ALL':
      default:
        return base;
    }
  }

  private async countQueue(
    queueWhere: Prisma.CollationResultWhereInput | 'INEC_ONLY' | 'CAMPAIGN_ONLY' | 'BOTH_PRESENT',
    status: IrevQueueFilter,
    campaignId: string,
    scopeIds: string[] | null,
  ) {
    if (status === 'INEC_ONLY') {
      return this.countInecOnly(campaignId, scopeIds);
    }
    if (status === 'CAMPAIGN_ONLY') {
      return this.countCampaignOnly(campaignId, scopeIds);
    }
    if (status === 'BOTH_PRESENT') {
      return this.countBothPresent(campaignId, scopeIds);
    }
    return this.prisma.collationResult.count({
      where: queueWhere as Prisma.CollationResultWhereInput,
    });
  }

  private async fetchQueueRows(
    queueWhere: Prisma.CollationResultWhereInput | 'INEC_ONLY' | 'CAMPAIGN_ONLY' | 'BOTH_PRESENT',
    status: IrevQueueFilter,
    campaignId: string,
    scopeIds: string[] | null,
    safeLimit: number,
  ): Promise<QueueSourceRow[]> {
    if (status === 'INEC_ONLY') {
      return this.fetchInecOnlyRows(campaignId, scopeIds, safeLimit);
    }
    if (status === 'CAMPAIGN_ONLY') {
      return this.fetchCampaignOnlyRows(campaignId, scopeIds, safeLimit);
    }
    if (status === 'BOTH_PRESENT') {
      return this.fetchBothPresentRows(campaignId, scopeIds, safeLimit);
    }
    return this.prisma.collationResult.findMany({
      where: queueWhere as Prisma.CollationResultWhereInput,
      select: {
        id: true,
        scopeId: true,
        status: true,
        partyResults: true,
        irevVerification: true,
        irevVerifiedAt: true,
        submittedAt: true,
        ec8aPhotoUrls: true,
        votesCast: true,
        registeredVoters: true,
        accreditedVoters: true,
        invalidVotes: true,
        ballotPapersIssued: true,
        unusedBallotPapers: true,
        spoiledBallotPapers: true,
        usedBallotPapers: true,
      },
      take: Math.min(500, safeLimit * 4),
      orderBy: [{ irevVerifiedAt: 'desc' }, { submittedAt: 'desc' }],
    }) as Promise<QueueSourceRow[]>;
  }

  private async countInecOnly(campaignId: string, scopeIds: string[] | null) {
    const scopeFilter = scopeIds?.length
      ? Prisma.sql`AND s."pollingUnitId" IN (${Prisma.join(scopeIds)})`
      : Prisma.empty;
    const [row] = await this.prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM irev_pu_snapshots s
      LEFT JOIN collation_results cr
        ON cr."scopeId" = s."pollingUnitId"
       AND cr."campaignId" = ${campaignId}
       AND cr.level = 'POLLING_UNIT'::"CollationLevel"
       AND cr.status IN (
         'SUBMITTED'::"CollationResultStatus",
         'APPROVED'::"CollationResultStatus",
         'REJECTED'::"CollationResultStatus",
         'DRAFT'::"CollationResultStatus"
       )
      WHERE s."campaignId" = ${campaignId}
        AND s."documentUrl" IS NOT NULL
        AND s.status::text <> 'NOT_ON_IREV'
        AND cr.id IS NULL
        ${scopeFilter}
    `;
    return row?.count ?? 0;
  }

  private async countCampaignOnly(campaignId: string, scopeIds: string[] | null) {
    const scopeFilter = scopeIds?.length
      ? Prisma.sql`AND cr."scopeId" IN (${Prisma.join(scopeIds)})`
      : Prisma.empty;
    const [row] = await this.prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM collation_results cr
      LEFT JOIN irev_pu_snapshots s
        ON s."pollingUnitId" = cr."scopeId"
       AND s."campaignId" = ${campaignId}
       AND s."documentUrl" IS NOT NULL
       AND s.status::text <> 'NOT_ON_IREV'
      WHERE cr."campaignId" = ${campaignId}
        AND cr.level = 'POLLING_UNIT'::"CollationLevel"
        AND cr.status IN (
          'SUBMITTED'::"CollationResultStatus",
          'APPROVED'::"CollationResultStatus",
          'REJECTED'::"CollationResultStatus",
          'DRAFT'::"CollationResultStatus"
        )
        AND s.id IS NULL
        ${scopeFilter}
    `;
    return row?.count ?? 0;
  }

  private async fetchInecOnlyRows(campaignId: string, scopeIds: string[] | null, limit: number): Promise<QueueSourceRow[]> {
    const scopeFilter = scopeIds?.length
      ? Prisma.sql`AND s."pollingUnitId" IN (${Prisma.join(scopeIds)})`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      Array<{
        pollingUnitId: string;
        irevDocumentUrl: string | null;
        puName: string;
        puCode: string;
        wardName: string;
        lgaName: string;
        stateName: string;
      }>
    >`
      SELECT s."pollingUnitId",
             s."documentUrl" AS "irevDocumentUrl",
             p.name AS "puName",
             p.code AS "puCode",
             w.name AS "wardName",
             l.name AS "lgaName",
             st.name AS "stateName"
      FROM irev_pu_snapshots s
      INNER JOIN polling_units p ON p.id = s."pollingUnitId"
      INNER JOIN wards w ON w.id = p."wardId"
      INNER JOIN lgas l ON l.id = w."lgaId"
      INNER JOIN states st ON st.id = l."stateId"
      LEFT JOIN collation_results cr
        ON cr."scopeId" = s."pollingUnitId"
       AND cr."campaignId" = ${campaignId}
       AND cr.level = 'POLLING_UNIT'::"CollationLevel"
       AND cr.status IN (
         'SUBMITTED'::"CollationResultStatus",
         'APPROVED'::"CollationResultStatus",
         'REJECTED'::"CollationResultStatus",
         'DRAFT'::"CollationResultStatus"
       )
      WHERE s."campaignId" = ${campaignId}
        AND s."documentUrl" IS NOT NULL
        AND s.status::text <> 'NOT_ON_IREV'
        AND cr.id IS NULL
        ${scopeFilter}
      ORDER BY st.name, l.name, p.code
      LIMIT ${Math.min(500, limit * 4)}
    `;

    return rows.map((row) => ({
      id: `inec-only-${row.pollingUnitId}`,
      scopeId: row.pollingUnitId,
      status: 'NOT_CAPTURED',
      partyResults: null,
      irevVerification: null,
      irevVerifiedAt: null,
      submittedAt: null,
      inecPublished: true,
      irevDocumentUrl: row.irevDocumentUrl,
      puName: row.puName,
      puCode: row.puCode,
      wardName: row.wardName,
      lgaName: row.lgaName,
      stateName: row.stateName,
    }));
  }

  private async countBothPresent(campaignId: string, scopeIds: string[] | null) {
    const scopeFilter = scopeIds?.length
      ? Prisma.sql`AND cr."scopeId" IN (${Prisma.join(scopeIds)})`
      : Prisma.empty;
    const [row] = await this.prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM collation_results cr
      INNER JOIN irev_pu_snapshots s
        ON s."pollingUnitId" = cr."scopeId"
       AND s."campaignId" = ${campaignId}
       AND s."documentUrl" IS NOT NULL
       AND s.status::text <> 'NOT_ON_IREV'
      WHERE cr."campaignId" = ${campaignId}
        AND cr.level = 'POLLING_UNIT'::"CollationLevel"
        AND cr.status IN (
          'SUBMITTED'::"CollationResultStatus",
          'APPROVED'::"CollationResultStatus",
          'REJECTED'::"CollationResultStatus",
          'DRAFT'::"CollationResultStatus"
        )
        ${scopeFilter}
    `;
    return row?.count ?? 0;
  }

  private async fetchBothPresentRows(
    campaignId: string,
    scopeIds: string[] | null,
    limit: number,
  ): Promise<QueueSourceRow[]> {
    const scopeFilter = scopeIds?.length
      ? Prisma.sql`AND cr."scopeId" IN (${Prisma.join(scopeIds)})`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        scopeId: string;
        status: string;
        partyResults: unknown;
        irevVerification: unknown;
        irevVerifiedAt: Date | null;
        submittedAt: Date | null;
        ec8aPhotoUrls: string[];
        votesCast: number | null;
        registeredVoters: number | null;
        accreditedVoters: number | null;
        invalidVotes: number | null;
        ballotPapersIssued: number | null;
        unusedBallotPapers: number | null;
        spoiledBallotPapers: number | null;
        usedBallotPapers: number | null;
        irevDocumentUrl: string | null;
      }>
    >`
      SELECT cr.id, cr."scopeId", cr.status::text AS status,
             cr."partyResults", cr."irevVerification",
             cr."irevVerifiedAt", cr."submittedAt", cr."ec8aPhotoUrls",
             cr."votesCast", cr."registeredVoters", cr."accreditedVoters",
             cr."invalidVotes", cr."ballotPapersIssued", cr."unusedBallotPapers",
             cr."spoiledBallotPapers", cr."usedBallotPapers",
             s."documentUrl" AS "irevDocumentUrl"
      FROM collation_results cr
      INNER JOIN irev_pu_snapshots s
        ON s."pollingUnitId" = cr."scopeId"
       AND s."campaignId" = ${campaignId}
       AND s."documentUrl" IS NOT NULL
       AND s.status::text <> 'NOT_ON_IREV'
      WHERE cr."campaignId" = ${campaignId}
        AND cr.level = 'POLLING_UNIT'::"CollationLevel"
        AND cr.status IN (
          'SUBMITTED'::"CollationResultStatus",
          'APPROVED'::"CollationResultStatus",
          'REJECTED'::"CollationResultStatus",
          'DRAFT'::"CollationResultStatus"
        )
        ${scopeFilter}
      ORDER BY cr."submittedAt" DESC NULLS LAST
      LIMIT ${Math.min(500, limit * 4)}
    `;
    return rows.map((row) => ({ ...row, inecPublished: true }));
  }

  private async fetchCampaignOnlyRows(
    campaignId: string,
    scopeIds: string[] | null,
    limit: number,
  ): Promise<QueueSourceRow[]> {
    const scopeFilter = scopeIds?.length
      ? Prisma.sql`AND cr."scopeId" IN (${Prisma.join(scopeIds)})`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        scopeId: string;
        status: string;
        partyResults: unknown;
        irevVerification: unknown;
        irevVerifiedAt: Date | null;
        submittedAt: Date | null;
      }>
    >`
      SELECT cr.id, cr."scopeId", cr.status::text AS status,
             cr."partyResults", cr."irevVerification",
             cr."irevVerifiedAt", cr."submittedAt", cr."ec8aPhotoUrls",
             cr."votesCast", cr."registeredVoters", cr."accreditedVoters",
             cr."invalidVotes", cr."ballotPapersIssued", cr."unusedBallotPapers",
             cr."spoiledBallotPapers", cr."usedBallotPapers"
      FROM collation_results cr
      LEFT JOIN irev_pu_snapshots s
        ON s."pollingUnitId" = cr."scopeId"
       AND s."campaignId" = ${campaignId}
       AND s."documentUrl" IS NOT NULL
       AND s.status::text <> 'NOT_ON_IREV'
      WHERE cr."campaignId" = ${campaignId}
        AND cr.level = 'POLLING_UNIT'::"CollationLevel"
        AND cr.status IN (
          'SUBMITTED'::"CollationResultStatus",
          'APPROVED'::"CollationResultStatus",
          'REJECTED'::"CollationResultStatus",
          'DRAFT'::"CollationResultStatus"
        )
        AND s.id IS NULL
        ${scopeFilter}
      ORDER BY cr."submittedAt" DESC NULLS LAST
      LIMIT ${Math.min(500, limit * 4)}
    `;
    return rows.map((row) => ({ ...row, inecPublished: false }));
  }

  private async buildPartyDrift(
    campaignId: string,
    scopeIds: string[] | null,
    partyColumns: string[],
  ) {
    const rows = await this.prisma.collationResult.findMany({
      where: {
        ...this.baseResultWhere(campaignId, scopeIds),
        irevVerification: { path: ['recommendation'], equals: 'INVESTIGATE' },
      },
      select: { irevVerification: true },
      take: 500,
    });

    const counts = new Map<string, number>();
    for (const row of rows) {
      const verification = resolveIrevVerification(row) as IrevVerification | null;
      if (!verification) continue;
      for (const diff of verification.diffs) {
        if (!diff.field.startsWith('party:')) continue;
        const code = diff.field.replace('party:', '');
        counts.set(code, (counts.get(code) ?? 0) + 1);
      }
    }

    return [...counts.entries()]
      .map(([code, mismatchCount]) => ({ code, mismatchCount }))
      .sort((a, b) => b.mismatchCount - a.mismatchCount)
      .slice(0, 8)
      .filter((row) => partyColumns.length === 0 || partyColumns.includes(row.code));
  }

  private async resolveScopePuIds(
    user: JwtPayload,
    context: Awaited<ReturnType<CollationBrowseService['getContext']>>,
    filters: { lgaId?: string; wardId?: string; stateId?: string; search?: string },
  ): Promise<string[] | null> {
    const puWhere: Prisma.PollingUnitWhereInput = {};

    if (user.scopeType === ScopeType.POLLING_UNIT || user.role === CampaignRole.POLLING_AGENT) {
      if (!user.scopeId) throw new ForbiddenException('No polling unit assigned');
      puWhere.id = user.scopeId;
    } else if (isWardScopedUser(user)) {
      const wardId = getWardScopeId(user);
      if (!wardId) throw new ForbiddenException('No ward assigned');
      puWhere.wardId = wardId;
    } else if (isLgaScopedUser(user)) {
      const lgaId = getLgaScopeId(user);
      if (!lgaId) throw new ForbiddenException('No LGA assigned');
      puWhere.ward = { lgaId, ...(filters.wardId ? { id: filters.wardId } : {}) };
    } else if (isStateScopedUser(user)) {
      const stateId = getStateScopeId(user);
      if (!stateId) throw new ForbiddenException('No state assigned');
      puWhere.ward = {
        lga: {
          stateId,
          ...(filters.lgaId ? { id: filters.lgaId } : {}),
        },
        ...(filters.wardId ? { id: filters.wardId } : {}),
      };
    } else {
      if (filters.stateId || filters.lgaId || filters.wardId) {
        puWhere.ward = {
          ...(filters.lgaId ? { lgaId: filters.lgaId } : {}),
          ...(filters.wardId ? { id: filters.wardId } : {}),
          ...(filters.stateId ? { lga: { stateId: filters.stateId } } : {}),
        };
      } else if (!context.isNational) {
        puWhere.ward = { lga: { stateId: context.stateId } };
      } else if (!filters.search) {
        return null;
      }
    }

    const seat = context.activeSeat;
    if (seat) {
      if (seat.wardIds.length === 0) return [];
      if (filters.wardId && !seat.wardIds.includes(filters.wardId)) return [];
      puWhere.wardId = filters.wardId ?? { in: seat.wardIds };
    }

    if (filters.search) {
      puWhere.OR = [
        { name: { contains: filters.search, mode: Prisma.QueryMode.insensitive } },
        { code: { contains: filters.search, mode: Prisma.QueryMode.insensitive } },
        { ward: { name: { contains: filters.search, mode: Prisma.QueryMode.insensitive } } },
        { ward: { lga: { name: { contains: filters.search, mode: Prisma.QueryMode.insensitive } } } },
        {
          ward: {
            lga: {
              state: { name: { contains: filters.search, mode: Prisma.QueryMode.insensitive } },
            },
          },
        },
      ];
    }

    const rows = await this.prisma.pollingUnit.findMany({
      where: puWhere,
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  private async loadAttention(
    campaignId: string,
    clientPartyCode: string | null | undefined,
    partyColumns: string[],
    scopeIds: string[] | null,
  ): Promise<{
    votesAtRisk: IrevVotesAtRisk;
    clusters: IrevAttentionCluster[];
    feed: IrevAttentionFeed;
  }> {
    const partyCode = clientPartyCode ?? null;
    const windowStart = new Date(Date.now() - ATTENTION_FEED_WINDOW_MINUTES * 60_000);
    const where = this.baseResultWhere(campaignId, scopeIds);
    const snapshotScope = scopeIds?.length ? { pollingUnitId: { in: scopeIds } } : {};

    const [investigateRows, newOfficialScans, replacements, newlyAligned] = await Promise.all([
      this.prisma.collationResult.findMany({
        where: {
          ...where,
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
        where: {
          campaignId,
          uploadedAt: { gte: windowStart },
          ...snapshotScope,
        },
      }),
      this.prisma.irevScanRevision.count({
        where: {
          observedAt: { gte: windowStart },
          snapshot: { campaignId, ...snapshotScope },
        },
      }),
      this.prisma.collationResult.count({
        where: {
          ...where,
          irevVerifiedAt: { gte: windowStart },
          irevVerification: { path: ['status'], equals: 'MATCH' },
        },
      }),
    ]);

    const puMap = await this.loadPuMap(investigateRows.map((row) => row.scopeId));
    const riskRows: IrevVotesAtRiskPu[] = [];
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

  async getAttentionBrief(user: JwtPayload) {
    const context = await this.browse.getContext(user);
    const scopeIds = await this.resolveScopePuIds(user, context, {});
    return this.loadAttention(
      user.campaignId!,
      context.clientPartyCode,
      context.partyColumns,
      scopeIds,
    );
  }

  private async loadSnapshotTimes(campaignId: string, puIds: string[]) {
    const unique = [...new Set(puIds)];
    if (!unique.length) {
      return new Map<string, { uploadedAt: Date | null; fetchedAt: Date }>();
    }
    const rows = await this.prisma.irevPuSnapshot.findMany({
      where: { campaignId, pollingUnitId: { in: unique } },
      select: { pollingUnitId: true, uploadedAt: true, fetchedAt: true },
    });
    return new Map(rows.map((row) => [row.pollingUnitId, row]));
  }

  private async loadPuMap(puIds: string[]) {
    const unique = [...new Set(puIds)];
    if (!unique.length) {
      return new Map<
        string,
        {
          name: string;
          code: string;
          latitude: number | null;
          longitude: number | null;
          ward: {
            id: string;
            name: string;
            lga: { id: string; name: string; state: { id: string; name: string } };
          };
        }
      >();
    }

    const rows = await this.prisma.pollingUnit.findMany({
      where: { id: { in: unique } },
      select: {
        id: true,
        name: true,
        code: true,
        latitude: true,
        longitude: true,
        ward: {
          select: {
            id: true,
            name: true,
            lga: { select: { id: true, name: true, state: { select: { id: true, name: true } } } },
          },
        },
      },
    });

    return new Map(rows.map((row) => [row.id, row]));
  }
}

function pct(part: number, whole: number) {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}
