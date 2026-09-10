import { Injectable } from '@nestjs/common';
import { CollationLevel, CollationResultStatus } from '@electromon/shared';
import { Prisma } from '@electromon/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { countPuVerifications } from './ocr-verification';

export type LgaApprovalPipeline = {
  pollingUnits: {
    total: number;
    submitted: number;
    wardVerified: number;
    lgaApproved: number;
    stateApproved: number;
    rejected: number;
    notStarted: number;
  };
};

@Injectable()
export class CollationReadinessService {
  constructor(private prisma: PrismaService) {}

  async getWardPuReadinessMap(campaignId: string, wardIds: string[]) {
    const map = new Map<
      string,
      {
        totalPus: number;
        approvedPus: number;
        submittedPus: number;
        rejectedPus: number;
        missingPus: number;
        readyForLgaApproval: boolean;
        verifyMatched: number;
        verifyFlagged: number;
        verifyCheckPhoto: number;
        verifyPending: number;
      }
    >();

    if (wardIds.length === 0) return map;

    const pus = await this.prisma.pollingUnit.findMany({
      where: { wardId: { in: wardIds } },
      select: { id: true, wardId: true },
    });

    const puIds = pus.map((pu) => pu.id);
    const results = puIds.length
      ? await this.prisma.collationResult.findMany({
          where: {
            campaignId,
            level: CollationLevel.POLLING_UNIT,
            scopeId: { in: puIds },
          },
          select: {
            scopeId: true,
            status: true,
            registeredVoters: true,
            accreditedVoters: true,
            ballotPapersIssued: true,
            unusedBallotPapers: true,
            spoiledBallotPapers: true,
            invalidVotes: true,
            votesCast: true,
            usedBallotPapers: true,
            partyResults: true,
            ec8aPhotoUrls: true,
            ocrVerification: true,
          },
        })
      : [];

    const resultByPu = new Map(results.map((r) => [r.scopeId, r]));
    const pusByWard = new Map<string, string[]>();
    for (const pu of pus) {
      const list = pusByWard.get(pu.wardId) ?? [];
      list.push(pu.id);
      pusByWard.set(pu.wardId, list);
    }

    for (const wardId of wardIds) {
      const wardPuIds = pusByWard.get(wardId) ?? [];
      let approvedPus = 0;
      let submittedPus = 0;
      let rejectedPus = 0;
      let missingPus = 0;

      const verificationRows: typeof results = [];
      for (const puId of wardPuIds) {
        const row = resultByPu.get(puId);
        if (!row) {
          missingPus += 1;
          continue;
        }
        if (row.status === CollationResultStatus.APPROVED) approvedPus += 1;
        else if (row.status === CollationResultStatus.SUBMITTED) submittedPus += 1;
        else if (row.status === CollationResultStatus.REJECTED) rejectedPus += 1;
        else missingPus += 1;
        verificationRows.push(row);
      }

      const totalPus = wardPuIds.length;
      map.set(wardId, {
        totalPus,
        approvedPus,
        submittedPus,
        rejectedPus,
        missingPus,
        readyForLgaApproval: totalPus > 0 && approvedPus === totalPus,
        ...countPuVerifications(verificationRows),
      });
    }

    return map;
  }

  async getLgaWardReadinessMap(campaignId: string, lgaIds: string[]) {
    const map = new Map<
      string,
      {
        totalWards: number;
        approvedWards: number;
        submittedWards: number;
        rejectedWards: number;
        missingWards: number;
        readyForStateApproval: boolean;
      }
    >();

    if (lgaIds.length === 0) return map;

    const wards = await this.prisma.ward.findMany({
      where: { lgaId: { in: lgaIds } },
      select: { id: true, lgaId: true },
    });

    const wardIds = wards.map((w) => w.id);
    const results =
      wardIds.length > 0
        ? await this.prisma.collationResult.findMany({
            where: {
              campaignId,
              level: CollationLevel.WARD,
              scopeId: { in: wardIds },
            },
            select: { scopeId: true, status: true },
          })
        : [];

    const resultByWard = new Map(results.map((r) => [r.scopeId, r]));
    const wardsByLga = new Map<string, string[]>();
    for (const ward of wards) {
      const list = wardsByLga.get(ward.lgaId) ?? [];
      list.push(ward.id);
      wardsByLga.set(ward.lgaId, list);
    }

    for (const lgaId of lgaIds) {
      const lgaWardIds = wardsByLga.get(lgaId) ?? [];
      let approvedWards = 0;
      let submittedWards = 0;
      let rejectedWards = 0;
      let missingWards = 0;

      for (const wardId of lgaWardIds) {
        const row = resultByWard.get(wardId);
        if (!row) {
          missingWards += 1;
          continue;
        }
        if (row.status === CollationResultStatus.APPROVED) approvedWards += 1;
        else if (row.status === CollationResultStatus.SUBMITTED) submittedWards += 1;
        else if (row.status === CollationResultStatus.REJECTED) rejectedWards += 1;
        else missingWards += 1;
      }

      const totalWards = lgaWardIds.length;
      map.set(lgaId, {
        totalWards,
        approvedWards,
        submittedWards,
        rejectedWards,
        missingWards,
        readyForStateApproval: totalWards > 0 && approvedWards === totalWards,
      });
    }

    return map;
  }

  /** PU counts at each approval stage, keyed by LGA id. */
  async loadApprovalPipelineByLga(
    campaignId: string,
    lgaIds: string[],
  ): Promise<Map<string, LgaApprovalPipeline>> {
    const empty = new Map<string, LgaApprovalPipeline>();
    if (!lgaIds.length) return empty;

    for (const id of lgaIds) {
      empty.set(id, {
        pollingUnits: {
          total: 0,
          submitted: 0,
          wardVerified: 0,
          lgaApproved: 0,
          stateApproved: 0,
          rejected: 0,
          notStarted: 0,
        },
      });
    }

    const pus = await this.prisma.pollingUnit.findMany({
      where: { ward: { lgaId: { in: lgaIds } } },
      select: { id: true, wardId: true, ward: { select: { lgaId: true } } },
    });

    const puResults = await this.prisma.collationResult.findMany({
      where: {
        campaignId,
        level: CollationLevel.POLLING_UNIT,
        scopeId: { in: pus.map((p) => p.id) },
      },
      select: { scopeId: true, status: true },
    });

    const puStatus = new Map(puResults.map((r) => [r.scopeId, r.status]));

    for (const pu of pus) {
      const lgaId = pu.ward.lgaId;
      const pipeline = empty.get(lgaId);
      if (!pipeline) continue;
      pipeline.pollingUnits.total += 1;

      const status = puStatus.get(pu.id);
      if (!status || status === CollationResultStatus.DRAFT) {
        pipeline.pollingUnits.notStarted += 1;
        continue;
      }
      if (status === CollationResultStatus.REJECTED) {
        pipeline.pollingUnits.rejected += 1;
        pipeline.pollingUnits.submitted += 1;
        continue;
      }
      if (
        status === CollationResultStatus.SUBMITTED ||
        status === CollationResultStatus.APPROVED
      ) {
        pipeline.pollingUnits.submitted += 1;
      }
      if (status === CollationResultStatus.APPROVED) {
        pipeline.pollingUnits.wardVerified += 1;
        pipeline.pollingUnits.lgaApproved += 1;
        pipeline.pollingUnits.stateApproved += 1;
      }
    }

    return empty;
  }

  /** Aggregate LGA pipelines into state-level counts. */
  aggregatePipelineToState(
    lgaIdsByState: Map<string, string[]>,
    pipelines: Map<string, LgaApprovalPipeline>,
  ): Map<string, LgaApprovalPipeline> {
    const byState = new Map<string, LgaApprovalPipeline>();
    for (const [stateId, lgaIds] of lgaIdsByState.entries()) {
      const agg: LgaApprovalPipeline = {
        pollingUnits: {
          total: 0,
          submitted: 0,
          wardVerified: 0,
          lgaApproved: 0,
          stateApproved: 0,
          rejected: 0,
          notStarted: 0,
        },
      };
      for (const lgaId of lgaIds) {
        const p = pipelines.get(lgaId);
        if (!p) continue;
        for (const key of Object.keys(agg.pollingUnits) as Array<
          keyof LgaApprovalPipeline['pollingUnits']
        >) {
          agg.pollingUnits[key] += p.pollingUnits[key];
        }
      }
      byState.set(stateId, agg);
    }
    return byState;
  }

  /**
   * National Situation Room: approval pipeline rolled up by state via SQL.
   * Avoids loading every polling unit into memory (required after full INEC seed).
   */
  async loadApprovalPipelineByState(
    campaignId: string,
    stateIds: string[],
  ): Promise<Map<string, LgaApprovalPipeline>> {
    const empty = new Map<string, LgaApprovalPipeline>();
    if (!stateIds.length) return empty;

    const blank = (): LgaApprovalPipeline => ({
      pollingUnits: {
        total: 0,
        submitted: 0,
        wardVerified: 0,
        lgaApproved: 0,
        stateApproved: 0,
        rejected: 0,
        notStarted: 0,
      },
    });
    for (const id of stateIds) empty.set(id, blank());

    const totals = await this.prisma.$queryRaw<Array<{ stateId: string; total: number }>>`
      SELECT l."stateId" AS "stateId", COUNT(p.id)::int AS total
      FROM polling_units p
      INNER JOIN wards w ON w.id = p."wardId"
      INNER JOIN lgas l ON l.id = w."lgaId"
      WHERE l."stateId" IN (${Prisma.join(stateIds)})
      GROUP BY l."stateId"
    `;
    for (const row of totals) {
      const pipeline = empty.get(row.stateId) ?? blank();
      pipeline.pollingUnits.total = row.total;
      empty.set(row.stateId, pipeline);
    }

    const byStatus = await this.prisma.$queryRaw<
      Array<{ stateId: string; status: string; cnt: number }>
    >`
      SELECT l."stateId" AS "stateId",
             cr.status::text AS status,
             COUNT(*)::int AS cnt
      FROM collation_results cr
      INNER JOIN polling_units p ON p.id = cr."scopeId"
      INNER JOIN wards w ON w.id = p."wardId"
      INNER JOIN lgas l ON l.id = w."lgaId"
      WHERE cr."campaignId" = ${campaignId}
        AND cr.level = 'POLLING_UNIT'::"CollationLevel"
        AND l."stateId" IN (${Prisma.join(stateIds)})
      GROUP BY l."stateId", cr.status
    `;

    for (const row of byStatus) {
      const pipeline = empty.get(row.stateId) ?? blank();
      const n = row.cnt;
      if (row.status === CollationResultStatus.REJECTED) {
        pipeline.pollingUnits.rejected += n;
        pipeline.pollingUnits.submitted += n;
      } else if (row.status === CollationResultStatus.SUBMITTED) {
        pipeline.pollingUnits.submitted += n;
      } else if (row.status === CollationResultStatus.APPROVED) {
        pipeline.pollingUnits.submitted += n;
        pipeline.pollingUnits.wardVerified += n;
        pipeline.pollingUnits.lgaApproved += n;
        pipeline.pollingUnits.stateApproved += n;
      }
      // DRAFT / missing → notStarted (residual from total − submitted)
      empty.set(row.stateId, pipeline);
    }

    for (const pipeline of empty.values()) {
      pipeline.pollingUnits.notStarted = Math.max(
        0,
        pipeline.pollingUnits.total - pipeline.pollingUnits.submitted,
      );
    }

    return empty;
  }
}
