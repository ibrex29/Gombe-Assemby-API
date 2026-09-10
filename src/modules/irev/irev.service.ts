import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CollationLevel } from '@electromon/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContestService } from '../../common/contest/contest.service';
import type { JwtPayload } from '@electromon/shared';
import { IrevClient } from './irev.client';
import { IrevQueueService } from './irev-queue.service';
import { IrevRateLimiter } from './irev-rate-limiter';
import { resolveIrevVerification } from './irev-verification';

@Injectable()
export class IrevService {
  constructor(
    private prisma: PrismaService,
    private contests: ContestService,
    private client: IrevClient,
    private queue: IrevQueueService,
    private rateLimiter: IrevRateLimiter,
  ) {}

  async getPuSnapshot(user: JwtPayload, pollingUnitId: string) {
    if (!user.campaignId) throw new ForbiddenException('No active campaign membership');

    const [snapshot, result] = await Promise.all([
      this.prisma.irevPuSnapshot.findUnique({
        where: {
          campaignId_contestId_pollingUnitId: {
            campaignId: user.campaignId,
            contestId: this.contests.id(),
            pollingUnitId,
          },
        },
        include: {
          revisions: { orderBy: { observedAt: 'desc' }, take: 5 },
        },
      }),
      this.prisma.collationResult.findFirst({
        where: {
          campaignId: user.campaignId,
          level: CollationLevel.POLLING_UNIT,
          scopeId: pollingUnitId,
        },
        select: { irevVerification: true, irevVerifiedAt: true },
      }),
    ]);

    return {
      snapshot,
      irevVerification: resolveIrevVerification(result ?? {}),
      irevVerifiedAt: result?.irevVerifiedAt?.toISOString() ?? null,
    };
  }

  async refreshResult(user: JwtPayload, resultId: string) {
    if (!user.campaignId) throw new ForbiddenException('No active campaign membership');
    if (!this.client.isEnabled()) {
      throw new ForbiddenException('IReV comparison is disabled');
    }

    const allowed = await this.rateLimiter.waitForSlot(10_000);
    if (!allowed) {
      throw new HttpException('IReV refresh rate limit reached — try again shortly', HttpStatus.TOO_MANY_REQUESTS);
    }

    const result = await this.prisma.collationResult.findFirst({
      where: { id: resultId, campaignId: user.campaignId },
      select: { id: true, campaignId: true, scopeId: true, level: true },
    });
    if (!result) throw new NotFoundException('Collation result not found');
    if (result.level !== CollationLevel.POLLING_UNIT) {
      throw new ForbiddenException('IReV refresh is only available for polling unit results');
    }

    this.queue.publish({
      collationResultId: result.id,
      pollingUnitId: result.scopeId,
      campaignId: result.campaignId,
      force: true,
    });

    return { queued: true, collationResultId: result.id };
  }
}
