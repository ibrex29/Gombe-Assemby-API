import { Injectable } from '@nestjs/common';
import { Prisma } from '@electromon/db';
import { ContestType } from '@electromon/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  ContestService,
  type ResolvedContest,
  type ResolvedSeat,
} from '../../common/contest/contest.service';
import { DeploymentScopeService } from '../../common/deployment-scope/deployment-scope.service';

/** Placeholder on IrevElectionConfig — never used as an IReV API election id. */
export const IREV_PER_SEAT_CONFIG_ID = 'per-seat';

@Injectable()
export class IrevElectionResolver {
  constructor(
    private prisma: PrismaService,
    private contests: ContestService,
    private deploymentScope: DeploymentScopeService,
  ) {}

  /**
   * Statewide IReV election. Assembly has none — one ID per constituency.
   * Never falls back to the governorship portal ID for SHA.
   */
  forContest(contest: ResolvedContest): string | null {
    if (contest.type === ContestType.ASSEMBLY) return null;
    const fromContest = contest.irevElectionId?.trim();
    if (fromContest && fromContest !== IREV_PER_SEAT_CONFIG_ID) return fromContest;
    return this.deploymentScope.irevElectionId();
  }

  forSeat(contest: ResolvedContest, seat: ResolvedSeat | null | undefined): string | null {
    if (contest.type !== ContestType.ASSEMBLY) return this.forContest(contest);
    const id = seat?.irevElectionId?.trim();
    return id && id !== IREV_PER_SEAT_CONFIG_ID ? id : null;
  }

  async forWard(
    contest: ResolvedContest,
    wardId: string | null | undefined,
  ): Promise<string | null> {
    if (contest.type !== ContestType.ASSEMBLY) return this.forContest(contest);
    if (!wardId) return this.forSeat(contest, this.contests.seat());

    const ward = await this.prisma.ward.findUnique({
      where: { id: wardId },
      select: { constituency: { select: { irevElectionId: true } } },
    });
    const id = ward?.constituency?.irevElectionId?.trim();
    return id && id !== IREV_PER_SEAT_CONFIG_ID ? id : null;
  }

  catalogWardFilter(contest: ResolvedContest): Prisma.WardWhereInput {
    if (contest.type !== ContestType.ASSEMBLY) return {};
    return { constituency: { is: { irevElectionId: { not: null } } } };
  }

  configElectionId(contest: ResolvedContest): string | null {
    if (contest.type === ContestType.ASSEMBLY) return IREV_PER_SEAT_CONFIG_ID;
    return this.forContest(contest);
  }
}
