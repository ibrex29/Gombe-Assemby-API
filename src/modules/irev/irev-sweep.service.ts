import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { IrevPuSnapshotStatus } from '@electromon/db';
import { CollationLevel } from '@electromon/shared';
import { isOcrEligibleDocumentUrl, isStaleIrevDocumentUrl } from './irev-mapper';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContestService } from '../../common/contest/contest.service';
import { DeploymentScopeService } from '../../common/deployment-scope/deployment-scope.service';
import { IrevOfficialStatsService } from './irev-official-stats.service';
import { IrevClient } from './irev.client';
import { IrevQueueService } from './irev-queue.service';
import { inecStateIdForCode } from './irev-inec-state-codes';
import { IrevElectionResolver } from './irev-election.resolver';

const DEFAULT_CATALOG_INTERVAL_MS = 20_000;
const DEFAULT_CATALOG_STALE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CATALOG_WARD_BATCH = 8;
const DEFAULT_OCR_BACKFILL_INTERVAL_MS = 10_000;
const DEFAULT_OCR_BACKFILL_BATCH = 100;

@Injectable()
export class IrevSweepService implements OnModuleInit {
  private readonly logger = new Logger(IrevSweepService.name);
  private catalogEnqueueRunning = false;
  private ocrBackfillEnqueueRunning = false;

  constructor(
    private prisma: PrismaService,
    private client: IrevClient,
    private queue: IrevQueueService,
    private deploymentScope: DeploymentScopeService,
    private officialStats: IrevOfficialStatsService,
    private contests: ContestService,
    private irevElections: IrevElectionResolver,
  ) {}

  onModuleInit() {
    if (process.env.DISABLE_BACKGROUND_WORKERS === 'true') {
      this.logger.log('Background workers disabled; skipping IReV sweep');
      return;
    }
    if (!this.client.isEnabled()) return;

    const catalogMs = Number.parseInt(
      process.env.IREV_CATALOG_INTERVAL_MS ?? String(DEFAULT_CATALOG_INTERVAL_MS),
      10,
    );
    const waitMs = Number.parseInt(process.env.IREV_SWEEP_INTERVAL_MS ?? '3600000', 10);

    if (this.deploymentScope.isStateLocked() && process.env.IREV_BOOTSTRAP_ON_START !== 'false') {
      void this.bootstrapPipeline();
    }

    if (catalogMs > 0) {
      void this.enqueueCatalogBatch();
      setInterval(() => void this.enqueueCatalogBatch(), catalogMs);
      this.logger.log(`IReV catalog crawl every ${catalogMs}ms`);
    }
    if (waitMs > 0) {
      setInterval(() => void this.sweepWaitIrev(), waitMs);
    }

    const ocrBackfillMs = Number.parseInt(
      process.env.IREV_OCR_BACKFILL_INTERVAL_MS ?? String(DEFAULT_OCR_BACKFILL_INTERVAL_MS),
      10,
    );
    if (ocrBackfillMs > 0) {
      void this.enqueueOcrBackfill();
      setInterval(() => void this.enqueueOcrBackfill(), ocrBackfillMs);
      this.logger.log(`IReV OCR backfill every ${ocrBackfillMs}ms`);
    }
  }

  async enqueueCatalogBatch(limit?: number) {
    if (!this.client.isEnabled() || this.catalogEnqueueRunning) return;
    this.catalogEnqueueRunning = true;
    try {
      const campaignIds = await this.enabledCampaignIds();
      if (campaignIds.length === 0) return;

      const contest = await this.contests.active(campaignIds[0]);
      const configuredBatch = Number.parseInt(
        process.env.IREV_CATALOG_WARD_BATCH ?? String(DEFAULT_CATALOG_WARD_BATCH),
        10,
      );
      const take = Math.min(50, Math.max(1, limit ?? configuredBatch));
      const staleMs = Number.parseInt(
        process.env.IREV_CATALOG_STALE_MS ?? String(DEFAULT_CATALOG_STALE_MS),
        10,
      );
      const staleBefore = new Date(Date.now() - (Number.isFinite(staleMs) && staleMs > 0 ? staleMs : DEFAULT_CATALOG_STALE_MS));
      const retryFailedAfter = new Date(Date.now() - 15 * 60 * 1000);

      const wards = await this.prisma.ward.findMany({
        where: {
          ...this.deploymentScope.wardInLockedStateWhere(),
          ...this.irevElections.catalogWardFilter(contest),
          OR: [
            { irevGeoMapping: null },
            {
              irevGeoMapping: {
                AND: [
                  { lastCatalogedAt: null },
                  {
                    OR: [
                      { lastCatalogAttemptAt: null },
                      { lastCatalogAttemptAt: { lt: retryFailedAfter } },
                    ],
                  },
                ],
              },
            },
            { irevGeoMapping: { lastCatalogedAt: { lt: staleBefore } } },
          ],
        },
        orderBy: { irevGeoMapping: { lastCatalogAttemptAt: { sort: 'asc', nulls: 'first' } } },
        select: { id: true },
        take,
      });
      if (wards.length === 0) return;

      for (const campaignId of campaignIds) {
        for (const ward of wards) {
          this.queue.publish({ campaignId, wardId: ward.id });
        }
      }

      this.logger.log(
        { wards: wards.length, campaigns: campaignIds.length },
        'Enqueued IReV catalog for unfetched wards',
      );
    } catch (error) {
      this.logger.warn({ err: error }, 'IReV catalog enqueue failed');
    } finally {
      this.catalogEnqueueRunning = false;
    }
  }

  async sweepWaitIrev(limit = 50) {
    if (!this.client.isEnabled()) return;

    const rows = await this.prisma.collationResult.findMany({
      where: {
        level: CollationLevel.POLLING_UNIT,
        irevVerification: {
          path: ['recommendation'],
          equals: 'WAIT_IREV',
        },
      },
      select: { id: true, campaignId: true, scopeId: true },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });

    if (rows.length === 0) return;

    for (const row of rows) {
      this.queue.publish({
        collationResultId: row.id,
        pollingUnitId: row.scopeId,
        campaignId: row.campaignId,
      });
    }

    this.logger.log({ count: rows.length }, 'Re-enqueued WAIT_IREV collation rows');
  }

  async enqueueOcrBackfill(limit?: number) {
    if (!this.client.isEnabled() || this.ocrBackfillEnqueueRunning) {
      return { queued: 0, backlog: 0 };
    }
    this.ocrBackfillEnqueueRunning = true;
    try {
      const campaignIds = await this.enabledCampaignIds();
      if (campaignIds.length === 0) return { queued: 0, backlog: 0 };

      const configuredBatch = Number.parseInt(
        process.env.IREV_OCR_BACKFILL_BATCH ?? String(DEFAULT_OCR_BACKFILL_BATCH),
        10,
      );
      const take = Math.min(1000, Math.max(1, limit ?? configuredBatch));

      const where = {
        campaignId: { in: campaignIds },
        documentUrl: { not: null },
        status: { in: [IrevPuSnapshotStatus.FETCHED, IrevPuSnapshotStatus.OCR_FAILED] },
      };

      const [backlog, rows] = await Promise.all([
        this.prisma.irevPuSnapshot.count({ where }),
        this.prisma.irevPuSnapshot.findMany({
          where,
          select: { campaignId: true, pollingUnitId: true },
          orderBy: { fetchedAt: 'asc' },
          take,
        }),
      ]);

      for (const row of rows) {
        this.queue.publish({
          campaignId: row.campaignId,
          pollingUnitId: row.pollingUnitId,
          ocrOnly: true,
        });
      }

      if (rows.length > 0) {
        this.logger.log({ queued: rows.length, backlog }, 'Enqueued IReV OCR backfill');
      }

      return { queued: rows.length, backlog, limit: take, truncated: backlog > rows.length };
    } finally {
      this.ocrBackfillEnqueueRunning = false;
    }
  }

  async getOcrPipelineStatus(campaignIds: string[]) {
    if (!campaignIds.length) {
      return {
        published: 0,
        ocrReady: 0,
        ocrFailed: 0,
        pendingOcr: 0,
        backlog: 0,
        eligibleBacklog: 0,
        staleUrls: 0,
      };
    }

    const snapshots = await this.prisma.irevPuSnapshot.findMany({
      where: { campaignId: { in: campaignIds }, documentUrl: { not: null } },
      select: { status: true, documentUrl: true },
    });

    let fetched = 0;
    let ocrReady = 0;
    let ocrFailed = 0;
    let staleUrls = 0;
    let eligiblePending = 0;
    let eligibleFailed = 0;

    for (const row of snapshots) {
      const stale = isStaleIrevDocumentUrl(row.documentUrl);
      const eligible = isOcrEligibleDocumentUrl(row.documentUrl);
      if (stale) staleUrls += 1;

      switch (row.status) {
        case IrevPuSnapshotStatus.FETCHED:
          fetched += 1;
          if (eligible) eligiblePending += 1;
          break;
        case IrevPuSnapshotStatus.OCR_READY:
          ocrReady += 1;
          break;
        case IrevPuSnapshotStatus.OCR_FAILED:
          ocrFailed += 1;
          if (eligible) eligibleFailed += 1;
          break;
        default:
          break;
      }
    }

    const published = fetched + ocrReady + ocrFailed;
    const eligibleBacklog = eligiblePending + eligibleFailed;

    return {
      published,
      ocrReady,
      ocrFailed,
      pendingOcr: fetched,
      backlog: fetched + ocrFailed,
      eligibleBacklog,
      staleUrls,
    };
  }

  private async enabledCampaignIds(): Promise<string[]> {
    await this.ensureElectionConfigs();
    const configured = await this.prisma.irevElectionConfig.findMany({
      where: { enabled: true },
      select: { campaignId: true },
    });
    if (configured.length > 0) return configured.map((row) => row.campaignId);
    const campaign = await this.prisma.campaign.findFirst({
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    return campaign ? [campaign.id] : [];
  }

  /** State-scoped deploys: catalog + OCR all wards on startup (no agent submissions needed). */
  private async bootstrapPipeline() {
    try {
      await this.ensureElectionConfigs();
      void this.warmOfficialPortalStats();
      const totalWards = await this.prisma.ward.count({
        where: this.deploymentScope.wardInLockedStateWhere(),
      });
      if (totalWards === 0) return;

      const batchCap = Number.parseInt(process.env.IREV_BOOTSTRAP_WARD_BATCH ?? '200', 10);
      const batch = Math.min(totalWards, Number.isFinite(batchCap) && batchCap > 0 ? batchCap : 200);

      this.logger.log({ totalWards, batch }, 'IReV bootstrap: enqueuing ward catalog crawl');
      await this.enqueueCatalogBatch(batch);

      const ocrBatch = Number.parseInt(process.env.IREV_BOOTSTRAP_OCR_BATCH ?? '500', 10);
      if (Number.isFinite(ocrBatch) && ocrBatch > 0) {
        await this.enqueueOcrBackfill(ocrBatch);
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'IReV bootstrap failed');
    }
  }

  /** Prefetch INEC portal totals so race headers match inecelectionresults.ng. */
  private async warmOfficialPortalStats() {
    const campaign = await this.prisma.campaign.findFirst({
      where: { isActive: true },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!campaign) return;
    const contest = await this.contests.active(campaign.id);
    const electionId = this.irevElections.forContest(contest);
    const stateCode = this.deploymentScope.lockedStateCode();
    if (!electionId || !stateCode || !this.deploymentScope.isGovernorshipElection()) return;

    const stateInecId = inecStateIdForCode(stateCode);
    if (stateInecId == null) return;

    try {
      const stats = await this.officialStats.getStateOfficialStats(electionId, stateInecId);
      if (stats.available) {
        this.logger.log(
          {
            documentsUploaded: stats.documentsUploaded,
            totalPollingUnits: stats.totalPollingUnits,
            uploadPercent: stats.uploadPercent,
          },
          'Warmed INEC official portal stats',
        );
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'Could not warm INEC official portal stats');
    }
  }

  private async ensureElectionConfigs() {
    const campaigns = await this.prisma.campaign.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    for (const { id: campaignId } of campaigns) {
      const contest = await this.contests.active(campaignId);
      const electionId = this.irevElections.configElectionId(contest);
      if (!electionId) continue;
      const electionLabel =
        contest.irevElectionLabel ?? this.deploymentScope.irevElectionLabel();
      await this.prisma.irevElectionConfig.upsert({
        where: { contestId: contest.id },
        create: {
          campaignId,
          contestId: contest.id,
          irevElectionId: electionId,
          electionLabel,
          enabled: true,
        },
        update: {
          irevElectionId: electionId,
          electionLabel,
          enabled: true,
        },
      });
    }
  }
}
