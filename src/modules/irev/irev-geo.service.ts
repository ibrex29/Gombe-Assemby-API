import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IrevClient } from './irev.client';
import { normalizeGeoName } from './irev-mapper';
import { IrevRateLimiter } from './irev-rate-limiter';

@Injectable()
export class IrevGeoService {
  private readonly logger = new Logger(IrevGeoService.name);

  constructor(
    private prisma: PrismaService,
    private client: IrevClient,
    private rateLimiter: IrevRateLimiter,
  ) {}

  async resolveIrevWardId(
    wardId: string,
    electionId: string,
    options?: { maxWaitMs?: number },
  ): Promise<string | null> {
    const cached = await this.prisma.irevGeoMapping.findUnique({ where: { wardId } });
    if (cached?.irevWardId && cached.irevWardId !== 'unresolved') return cached.irevWardId;

    const ward = await this.prisma.ward.findUnique({
      where: { id: wardId },
      include: { lga: { include: { state: { select: { code: true } } } } },
    });
    if (!ward) return null;

    const allowed = await this.rateLimiter.waitForSlot(options?.maxWaitMs ?? 5_000);
    if (!allowed) {
      this.logger.warn({ wardId }, 'IReV rate limit exceeded while resolving ward mapping');
      return null;
    }

    const resolved = await this.client.resolveWardMapping({
      electionId,
      stateCode: ward.lga.state.code,
      lgaName: ward.lga.name,
      wardName: ward.name,
    });
    if (!resolved) return null;

    const siblings = await this.prisma.ward.findMany({
      where: { lgaId: ward.lgaId },
      select: { id: true, name: true },
    });
    const now = new Date();
    for (const sibling of siblings) {
      const match = resolved.lgaWards.find(
        (row) => normalizeGeoName(row.name ?? '') === normalizeGeoName(sibling.name),
      );
      if (!match?._id) continue;
      await this.prisma.irevGeoMapping.upsert({
        where: { wardId: sibling.id },
        create: {
          wardId: sibling.id,
          irevWardId: match._id,
          irevLgaId: resolved.irevLgaId,
          irevStateId: resolved.irevStateId,
        },
        update: {
          irevWardId: match._id,
          irevLgaId: resolved.irevLgaId,
          irevStateId: resolved.irevStateId,
          updatedAt: now,
        },
      });
    }

    return resolved.irevWardId;
  }
}
