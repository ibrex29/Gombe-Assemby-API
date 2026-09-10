import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IrevPuSnapshotStatus, Prisma } from '@electromon/db';
import { getPartyCodes, normalizeTrackedParties } from '@electromon/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContestService } from '../../common/contest/contest.service';
import { DeploymentScopeService } from '../../common/deployment-scope/deployment-scope.service';
import { MetricsService } from '../../common/metrics/metrics.service';
import { Ec8aPhotoReaderService } from '../collation/ec8a-photo-reader.service';
import type { VisionExtract } from '../collation/ocr-ec8a-parse';
import { IrevClient } from './irev.client';
import { IrevGeoService } from './irev-geo.service';
import { IREV_FETCH_EVENT, type IrevFetchJob } from './irev-fetch.events';
import { IrevRateLimiter } from './irev-rate-limiter';
import { IrevElectionResolver } from './irev-election.resolver';
import {
  catalogRowsForWard,
  findIrevPuByCode,
  irevDocumentHash,
  irevDocumentUploadedAt,
  irevDocumentUrl,
  isOcrEligibleDocumentUrl,
  isStaleIrevDocumentUrl,
} from './irev-mapper';
import {
  agentHasComparableFigures,
  compareAgentToIrev,
  isIrevDocumentSubstitution,
  pendingIrevVerification,
  persistIrevVerification,
} from './irev-verification';

const MAX_ATTEMPTS = 3;

@Injectable()
export class IrevFetchWorker {
  private readonly logger = new Logger(IrevFetchWorker.name);

  constructor(
    private prisma: PrismaService,
    private client: IrevClient,
    private geo: IrevGeoService,
    private rateLimiter: IrevRateLimiter,
    private photoReader: Ec8aPhotoReaderService,
    private metrics: MetricsService,
    private deploymentScope: DeploymentScopeService,
    private contests: ContestService,
    private irevElections: IrevElectionResolver,
    private events: EventEmitter2,
  ) {}

  async handle(job: IrevFetchJob) {
    if (!this.client.isEnabled()) return;
    const contest = await this.contests.active(job.campaignId);
    job.contestId = job.contestId ?? contest.id;
    return this.contests.run(contest, () => this.handleResolved(job));
  }

  private async handleResolved(job: IrevFetchJob) {
    if (!this.client.isEnabled()) return;

    const result = job.collationResultId
      ? await this.prisma.collationResult.findUnique({
          where: { id: job.collationResultId },
          include: {
            campaign: { select: { trackedParties: true, clientPartyCode: true } },
          },
        })
      : null;
    if (job.collationResultId && !result) return;

    const pu = job.pollingUnitId
      ? await this.prisma.pollingUnit.findUnique({
          where: { id: job.pollingUnitId },
          select: { id: true, code: true, wardId: true },
        })
      : null;
    if (job.pollingUnitId && !pu) return;

    if (job.ocrOnly && pu) {
      await this.processSnapshotOcrOnly(job, pu);
      return;
    }

    const wardId = job.wardId ?? pu?.wardId;
    if (!wardId) return;

    const config = await this.resolveElectionConfig(job.campaignId);
    if (!config?.enabled) {
      if (result) {
        await this.writePending(result.id, 'IReV comparison is not configured for this campaign');
      }
      return;
    }

    const contest = this.contests.current();
    const electionId = contest
      ? await this.irevElections.forWard(contest, wardId)
      : null;
    if (!electionId) {
      if (result) await this.writePending(result.id, 'No IReV election ID for this assembly seat');
      return;
    }

    const catalogOnly = !result;
    const allowed = await this.rateLimiter.waitForSlot(catalogOnly ? 120_000 : 5_000);
    if (!allowed) {
      this.metrics.recordIrevFetch('rate_limited');
      throw new Error('IReV rate limit exceeded');
    }

    const irevWardId = await this.geo.resolveIrevWardId(wardId, electionId, {
      maxWaitMs: catalogOnly ? 120_000 : 5_000,
    });
    if (!irevWardId) {
      this.metrics.recordIrevFetch('error');
      await this.markWardCatalogAttempt(wardId, 'unresolved');
      if (result) await this.writePending(result.id, 'Could not map ward to IReV geography');
      return;
    }

    const wardPus = await this.client.getWardPollingUnits(electionId, irevWardId);
    if (wardPus.length === 0) {
      this.logger.warn({ wardId, irevWardId }, 'IReV ward PU list empty; will retry catalog');
      await this.markWardCatalogAttempt(wardId);
      if (result) await this.writePending(result.id, 'Could not load IReV polling units for this ward');
      return;
    }

    await this.persistWardCatalog(job.campaignId, wardId, wardPus);
    await this.markWardCataloged(wardId);

    if (!pu || !result) {
      await this.prisma.irevElectionConfig.update({
        where: { contestId: job.contestId ?? this.contests.id() },
        data: { lastSyncAt: new Date() },
      });
      await this.ocrCatalogedWard(job, wardId);
      this.metrics.recordIrevFetch('success');
      this.logger.log({ wardId, campaignId: job.campaignId, pus: wardPus.length }, 'IReV ward catalog stored');
      return;
    }

    const irevPu = findIrevPuByCode(wardPus, pu.code);
    const documentUrl = irevPu ? irevDocumentUrl(irevPu) : null;
    const uploadedAt = irevPu ? irevDocumentUploadedAt(irevPu) : null;
    const documentHash = irevDocumentHash(documentUrl);

    const existingSnapshot = await this.prisma.irevPuSnapshot.findUnique({
      where: {
        campaignId_contestId_pollingUnitId: {
          campaignId: job.campaignId,
          contestId: job.contestId ?? this.contests.id(),
          pollingUnitId: pu.id,
        },
      },
      include: {
        revisions: { orderBy: { observedAt: 'desc' }, take: 1 },
      },
    });

    if (
      !job.force &&
      existingSnapshot?.documentHash === documentHash &&
      existingSnapshot.status === IrevPuSnapshotStatus.OCR_READY &&
      existingSnapshot.ocrExtract
    ) {
      const previous = previousFromSnapshot(existingSnapshot);
      await this.compareAndPersist(result, existingSnapshot.ocrExtract as unknown as VisionExtract, {
        documentUrl,
        missingOnIrev: !documentUrl,
        previousIrevExtract: previous?.extract ?? null,
        previousDocumentUrl: previous?.documentUrl ?? null,
        replacedAt: previous?.replacedAt ?? null,
      });
      this.metrics.recordIrevFetch('success');
      return;
    }

    if (!irevPu || !documentUrl) {
      await this.prisma.irevPuSnapshot.upsert({
        where: {
          campaignId_contestId_pollingUnitId: {
            campaignId: job.campaignId,
            contestId: job.contestId ?? this.contests.id(),
            pollingUnitId: pu.id,
          },
        },
        create: {
          campaignId: job.campaignId,
          contestId: job.contestId ?? this.contests.id(),
          pollingUnitId: pu.id,
          irevPuId: irevPu?._id ?? null,
          status: IrevPuSnapshotStatus.NOT_ON_IREV,
        },
        update: {
          irevPuId: irevPu?._id ?? null,
          documentUrl: null,
          documentHash: null,
          uploadedAt: null,
          status: IrevPuSnapshotStatus.NOT_ON_IREV,
          fetchedAt: new Date(),
        },
      });
      await this.compareAndPersist(result, null, { documentUrl: null, missingOnIrev: true });
      this.metrics.recordIrevFetch('missing');
      return;
    }

    const substituted =
      Boolean(existingSnapshot?.ocrExtract) &&
      isIrevDocumentSubstitution(existingSnapshot?.documentHash, documentHash);

    if (substituted && existingSnapshot) {
      await this.prisma.irevScanRevision.create({
        data: {
          snapshotId: existingSnapshot.id,
          documentUrl: existingSnapshot.documentUrl,
          documentHash: existingSnapshot.documentHash,
          uploadedAt: existingSnapshot.uploadedAt,
          ocrExtract: existingSnapshot.ocrExtract ?? undefined,
        },
      });
    }

    let ocrExtract: VisionExtract | null = null;
    if (
      !job.force &&
      existingSnapshot?.documentHash === documentHash &&
      existingSnapshot.ocrExtract
    ) {
      ocrExtract = existingSnapshot.ocrExtract as unknown as VisionExtract;
    } else {
      const partyCodes = getPartyCodes(normalizeTrackedParties(result.campaign.trackedParties));
      ocrExtract = await this.photoReader.extractEc8aFromUrl(documentUrl, partyCodes);
    }

    const snapshotStatus =
      ocrExtract?.unreadable || !ocrExtract
        ? IrevPuSnapshotStatus.OCR_FAILED
        : IrevPuSnapshotStatus.OCR_READY;

    const previous = substituted
      ? {
          extract: existingSnapshot?.ocrExtract as unknown as VisionExtract,
          documentUrl: existingSnapshot?.documentUrl ?? null,
          replacedAt: new Date().toISOString(),
        }
      : previousFromSnapshot(existingSnapshot);

    await this.prisma.irevPuSnapshot.upsert({
      where: {
        campaignId_contestId_pollingUnitId: {
          campaignId: job.campaignId,
          contestId: job.contestId ?? this.contests.id(),
          pollingUnitId: pu.id,
        },
      },
      create: {
        campaignId: job.campaignId,
        contestId: job.contestId ?? this.contests.id(),
        pollingUnitId: pu.id,
        irevPuId: irevPu._id,
        documentUrl,
        documentHash,
        uploadedAt,
        ocrExtract: ocrExtract as object,
        status: snapshotStatus,
      },
      update: {
        irevPuId: irevPu._id,
        documentUrl,
        documentHash,
        uploadedAt,
        ocrExtract: ocrExtract as object,
        status: snapshotStatus,
        fetchedAt: new Date(),
      },
    });

    if (snapshotStatus === IrevPuSnapshotStatus.OCR_FAILED) {
      this.metrics.recordIrevOcrFailure();
    }

    await this.compareAndPersist(result, ocrExtract, {
      documentUrl,
      missingOnIrev: false,
      unreadable: ocrExtract?.unreadable,
      ocrError: ocrExtract?.error,
      previousIrevExtract: previous?.extract ?? null,
      previousDocumentUrl: previous?.documentUrl ?? null,
      replacedAt: previous?.replacedAt ?? null,
    });

    await this.prisma.irevElectionConfig.update({
      where: { contestId: job.contestId ?? this.contests.id() },
      data: { lastSyncAt: new Date() },
    });

    this.metrics.recordIrevFetch('success');
    this.logger.log(
      {
        collationResultId: result.id,
        pollingUnitId: pu.id,
        status: snapshotStatus,
      },
      'IReV comparison stored',
    );
  }

  private async compareAndPersist(
    result: {
      id: string;
      registeredVoters: number | null;
      accreditedVoters: number | null;
      ballotPapersIssued: number | null;
      unusedBallotPapers: number | null;
      spoiledBallotPapers: number | null;
      invalidVotes: number | null;
      votesCast: number | null;
      usedBallotPapers: number | null;
      partyResults: unknown;
      campaign: { trackedParties: unknown; clientPartyCode?: string | null };
    },
    irevExtract: VisionExtract | null,
    options: {
      documentUrl: string | null;
      missingOnIrev?: boolean;
      unreadable?: boolean;
      ocrError?: string | null;
      previousIrevExtract?: VisionExtract | null;
      previousDocumentUrl?: string | null;
      replacedAt?: string | null;
    },
  ) {
    const partyCodes = getPartyCodes(normalizeTrackedParties(result.campaign.trackedParties));
    const agent = {
      registeredVoters: result.registeredVoters,
      accreditedVoters: result.accreditedVoters,
      ballotPapersIssued: result.ballotPapersIssued,
      unusedBallotPapers: result.unusedBallotPapers,
      spoiledBallotPapers: result.spoiledBallotPapers,
      invalidVotes: result.invalidVotes,
      votesCast: result.votesCast,
      usedBallotPapers: result.usedBallotPapers,
      partyResults: result.partyResults,
    };

    if (!agentHasComparableFigures(agent) && !options.missingOnIrev) {
      await this.writePending(result.id, 'Agent figures not ready for IReV comparison');
      return;
    }

    const verification = compareAgentToIrev({
      agent,
      irevExtract,
      partyCodes,
      documentUrl: options.documentUrl,
      missingOnIrev: options.missingOnIrev,
      unreadable: options.unreadable,
      ocrError: options.ocrError,
      previousIrevExtract: options.previousIrevExtract,
      previousDocumentUrl: options.previousDocumentUrl,
      replacedAt: options.replacedAt,
      clientPartyCode: result.campaign.clientPartyCode ?? null,
    });

    await this.prisma.collationResult.update({
      where: { id: result.id },
      data: persistIrevVerification(verification),
    });
    this.metrics.recordIrevVerification(verification.status);
  }

  private async persistWardCatalog(
    campaignId: string,
    wardId: string,
    wardPus: Parameters<typeof catalogRowsForWard>[1],
  ) {
    const localPus = await this.prisma.pollingUnit.findMany({
      where: { wardId },
      select: { id: true, code: true },
    });
    const rows = catalogRowsForWard(localPus, wardPus);
    if (rows.length === 0) return;

    const existing = await this.prisma.irevPuSnapshot.findMany({
      where: {
        campaignId,
        pollingUnitId: { in: rows.map((row) => row.pollingUnitId) },
      },
    });
    const byPu = new Map(existing.map((row) => [row.pollingUnitId, row]));
    const fetchedAt = new Date();

    for (const row of rows) {
      const previous = byPu.get(row.pollingUnitId);
      const substituted =
        Boolean(previous?.ocrExtract) &&
        isIrevDocumentSubstitution(previous?.documentHash, row.documentHash);
      if (substituted && previous) {
        await this.prisma.irevScanRevision.create({
          data: {
            snapshotId: previous.id,
            documentUrl: previous.documentUrl,
            documentHash: previous.documentHash,
            uploadedAt: previous.uploadedAt,
            ocrExtract: previous.ocrExtract ?? undefined,
          },
        });
      }

      const sameHash =
        Boolean(row.documentHash) && previous?.documentHash === row.documentHash;
      const status = !row.documentUrl
        ? IrevPuSnapshotStatus.NOT_ON_IREV
        : sameHash && previous?.status === IrevPuSnapshotStatus.OCR_READY
          ? IrevPuSnapshotStatus.OCR_READY
          : IrevPuSnapshotStatus.FETCHED;

      await this.prisma.irevPuSnapshot.upsert({
        where: {
          campaignId_contestId_pollingUnitId: {
            campaignId,
            contestId: this.contests.id(),
            pollingUnitId: row.pollingUnitId,
          },
        },
        create: {
          campaignId,
          contestId: this.contests.id(),
          pollingUnitId: row.pollingUnitId,
          irevPuId: row.irevPuId,
          documentUrl: row.documentUrl,
          documentHash: row.documentHash,
          uploadedAt: row.uploadedAt,
          status,
          fetchedAt,
        },
        update: {
          irevPuId: row.irevPuId,
          documentUrl: row.documentUrl,
          documentHash: row.documentHash,
          uploadedAt: row.uploadedAt,
          status,
          fetchedAt,
          ocrExtract: sameHash ? undefined : Prisma.DbNull,
        },
      });
    }
  }

  /** OCR a cataloged IReV sheet for national results rollups (no agent comparison). */
  private async processSnapshotOcrOnly(
    job: IrevFetchJob,
    pu: { id: string; code: string; wardId: string },
  ) {
    const allowed = await this.rateLimiter.waitForSlot(120_000);
    if (!allowed) {
      this.metrics.recordIrevFetch('rate_limited');
      throw new Error('IReV rate limit exceeded');
    }

    const [snapshot, campaign] = await Promise.all([
      this.prisma.irevPuSnapshot.findUnique({
        where: {
          campaignId_contestId_pollingUnitId: {
            campaignId: job.campaignId,
            contestId: job.contestId ?? this.contests.id(),
            pollingUnitId: pu.id,
          },
        },
      }),
      this.prisma.campaign.findUnique({
        where: { id: job.campaignId },
        select: { trackedParties: true },
      }),
    ]);

    if (!snapshot?.documentUrl) {
      this.metrics.recordIrevFetch('missing');
      return;
    }

    const documentUrl = await this.resolveOcrDocumentUrl(job.campaignId, pu, snapshot);
    if (!documentUrl) {
      this.logger.debug(
        { pollingUnitId: pu.id, documentUrl: snapshot.documentUrl },
        'Skipping OCR — no live IReV document URL',
      );
      return;
    }

    if (
      !job.force &&
      snapshot.status === IrevPuSnapshotStatus.OCR_READY &&
      snapshot.ocrExtract &&
      documentUrl === snapshot.documentUrl
    ) {
      this.metrics.recordIrevFetch('success');
      return;
    }

    const partyCodes = getPartyCodes(normalizeTrackedParties(campaign?.trackedParties));
    const ocrExtract = await this.photoReader.extractEc8aFromUrl(documentUrl, partyCodes);
    const snapshotStatus =
      ocrExtract?.unreadable || !ocrExtract
        ? IrevPuSnapshotStatus.OCR_FAILED
        : IrevPuSnapshotStatus.OCR_READY;

    await this.prisma.irevPuSnapshot.update({
      where: { id: snapshot.id },
      data: {
        documentUrl,
        documentHash: irevDocumentHash(documentUrl),
        ocrExtract: ocrExtract as object,
        status: snapshotStatus,
        fetchedAt: new Date(),
      },
    });

    if (snapshotStatus === IrevPuSnapshotStatus.OCR_FAILED) {
      this.metrics.recordIrevOcrFailure();
    }

    this.metrics.recordIrevFetch('success');
    this.logger.log(
      { pollingUnitId: pu.id, status: snapshotStatus },
      'IReV snapshot OCR stored',
    );
  }

  private async resolveOcrDocumentUrl(
    campaignId: string,
    pu: { id: string; code: string; wardId: string },
    snapshot: { id: string; documentUrl: string | null; irevPuId: string | null },
  ): Promise<string | null> {
    if (snapshot.documentUrl && isOcrEligibleDocumentUrl(snapshot.documentUrl)) {
      return snapshot.documentUrl;
    }

    const refreshed = await this.refreshLiveDocumentUrl(campaignId, pu, snapshot.irevPuId);
    if (refreshed && isOcrEligibleDocumentUrl(refreshed)) {
      return refreshed;
    }

    return null;
  }

  /** Swap dead legacy hosts for the live CDN URL the IReV API still exposes. */
  private async refreshLiveDocumentUrl(
    campaignId: string,
    pu: { id: string; code: string; wardId: string },
    irevPuId: string | null,
  ): Promise<string | null> {
    const config = await this.resolveElectionConfig(campaignId);
    if (!config?.enabled) return null;
    const contest = this.contests.current();
    const electionId = contest
      ? await this.irevElections.forWard(contest, pu.wardId)
      : null;
    if (!electionId) return null;

    const irevWardId = await this.geo.resolveIrevWardId(pu.wardId, electionId, {
      maxWaitMs: 120_000,
    });
    if (!irevWardId) return null;

    const wardPus = await this.client.getWardPollingUnits(electionId, irevWardId);
    const irevPu =
      (irevPuId ? wardPus.find((row) => row._id === irevPuId) : null) ??
      findIrevPuByCode(wardPus, pu.code);
    const liveUrl = irevPu ? irevDocumentUrl(irevPu) : null;
    if (!liveUrl || !isOcrEligibleDocumentUrl(liveUrl)) return null;

    await this.prisma.irevPuSnapshot.update({
      where: {
        campaignId_contestId_pollingUnitId: {
          campaignId,
          contestId: this.contests.id(),
          pollingUnitId: pu.id,
        },
      },
      data: {
        irevPuId: irevPu?._id ?? undefined,
        documentUrl: liveUrl,
        documentHash: irevDocumentHash(liveUrl),
        uploadedAt: irevPu ? irevDocumentUploadedAt(irevPu) : undefined,
        status: IrevPuSnapshotStatus.FETCHED,
        ocrExtract: Prisma.DbNull,
      },
    });

    return liveUrl;
  }

  /** Run OCR on cataloged sheets in a ward — no agent submission required. */
  private async ocrCatalogedWard(job: IrevFetchJob, wardId: string) {
    if (process.env.IREV_OCR_AFTER_CATALOG === 'false') return;

    const snapshots = await this.prisma.irevPuSnapshot.findMany({
      where: {
        campaignId: job.campaignId,
        status: IrevPuSnapshotStatus.FETCHED,
        documentUrl: { not: null },
        pollingUnit: { wardId },
      },
      select: { pollingUnitId: true, documentUrl: true },
    });

    let ocrReady = 0;
    let queued = 0;
    for (const row of snapshots) {
      if (!isOcrEligibleDocumentUrl(row.documentUrl)) continue;
      const pu = { id: row.pollingUnitId, code: '', wardId };
      try {
        await this.processSnapshotOcrOnly(
          { ...job, pollingUnitId: row.pollingUnitId, ocrOnly: true },
          pu,
        );
        ocrReady += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('rate limit')) {
          this.events.emit(IREV_FETCH_EVENT, {
            campaignId: job.campaignId,
            pollingUnitId: row.pollingUnitId,
            ocrOnly: true,
          });
          queued += 1;
        } else {
          this.logger.warn({ err: error, pollingUnitId: row.pollingUnitId }, 'IReV ward OCR failed');
        }
      }
    }

    if (ocrReady > 0 || queued > 0) {
      this.logger.log({ wardId, ocrReady, queued }, 'IReV ward OCR after catalog');
    }
  }

  private async markWardCataloged(wardId: string) {
    const now = new Date();
    await this.prisma.irevGeoMapping.updateMany({
      where: { wardId },
      data: { lastCatalogedAt: now, lastCatalogAttemptAt: now },
    });
  }

  private async markWardCatalogAttempt(wardId: string, unresolvedIrevWardId?: string) {
    const now = new Date();
    const existing = await this.prisma.irevGeoMapping.findUnique({ where: { wardId } });
    if (existing) {
      await this.prisma.irevGeoMapping.update({
        where: { wardId },
        data: { lastCatalogAttemptAt: now },
      });
      return;
    }
    if (!unresolvedIrevWardId) return;
    await this.prisma.irevGeoMapping.create({
      data: {
        wardId,
        irevWardId: unresolvedIrevWardId,
        lastCatalogAttemptAt: now,
      },
    });
  }

  private async writePending(collationResultId: string, ocrError?: string) {
    const verification = pendingIrevVerification();
    if (ocrError) verification.ocrError = ocrError;
    await this.prisma.collationResult.update({
      where: { id: collationResultId },
      data: persistIrevVerification(verification),
    });
  }

  private async resolveElectionConfig(campaignId: string) {
    const contest = await this.contests.active(campaignId);
    const electionId = this.irevElections.configElectionId(contest);
    if (!electionId) return null;
    const electionLabel =
      contest.irevElectionLabel ?? this.deploymentScope.irevElectionLabel();

    return this.prisma.irevElectionConfig.upsert({
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

  shouldRetry(error: unknown, attempt = 1): boolean {
    if (attempt >= MAX_ATTEMPTS) return false;
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('rate limit');
  }
}

function previousFromSnapshot(
  snapshot:
    | {
        documentUrl: string | null;
        ocrExtract: unknown;
        revisions?: Array<{
          documentUrl: string | null;
          ocrExtract: unknown;
          observedAt: Date;
        }>;
      }
    | null
    | undefined,
): { extract: VisionExtract; documentUrl: string | null; replacedAt: string } | null {
  const revision = snapshot?.revisions?.[0];
  if (!revision?.ocrExtract) return null;
  return {
    extract: revision.ocrExtract as VisionExtract,
    documentUrl: revision.documentUrl,
    replacedAt: revision.observedAt.toISOString(),
  };
}
