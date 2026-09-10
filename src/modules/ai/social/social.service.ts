import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@electromon/db';
import { JwtPayload, ScopeType, SocialPlatform } from '@electromon/shared';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  CreateSocialSourceDto,
  IngestSocialBatchDto,
  ListSocialPostsQueryDto,
  UpdateSocialSourceDto,
} from './dto/social.dto';
import { SocialQueueService } from './social-queue.service';

/** Posts per analysis job. Small batches keep one bad post from stalling many. */
const ANALYZE_CHUNK_SIZE = 25;

@Injectable()
export class SocialService {
  private readonly logger = new Logger(SocialService.name);

  constructor(
    private prisma: PrismaService,
    private queue: SocialQueueService,
  ) {}

  private async assertCampaignAccess(userId: string, campaignId: string) {
    const membership = await this.prisma.campaignMembership.findFirst({
      where: { userId, campaignId, isActive: true },
    });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this campaign');
    }
    return membership;
  }

  /**
   * Idempotent batch upsert. Re-ingesting a post refreshes its text and raw
   * payload but leaves analysis columns alone, so replays never discard results
   * or trigger re-spend.
   */
  async ingest(dto: IngestSocialBatchDto) {
    const sources = await this.prisma.socialSource.findMany({
      where: { campaignId: dto.campaignId, isActive: true },
      select: { id: true, platform: true, handle: true },
    });

    const byKey = new Map(
      sources.map((source) => [
        `${source.platform}:${source.handle}`,
        source.id,
      ]),
    );

    let ingested = 0;
    let updated = 0;
    const rejected: Array<{ externalId: string; reason: string }> = [];

    for (const post of dto.posts) {
      const sourceId = byKey.get(`${post.platform}:${post.sourceHandle}`);
      if (!sourceId) {
        rejected.push({
          externalId: post.externalId,
          reason: `No active source for ${post.platform} handle "${post.sourceHandle}"`,
        });
        continue;
      }

      const existing = await this.prisma.socialPost.findUnique({
        where: {
          campaignId_platform_externalId: {
            campaignId: dto.campaignId,
            platform: post.platform,
            externalId: post.externalId,
          },
        },
        select: { id: true },
      });

      const shared = {
        text: post.text,
        lang: post.lang ?? null,
        permalink: post.permalink ?? null,
        mediaUrls: post.mediaUrls ?? [],
        raw: (post.raw ?? undefined) as Prisma.InputJsonValue | undefined,
        fetchedAt: new Date(),
      };

      if (existing) {
        await this.prisma.socialPost.update({
          where: { id: existing.id },
          data: shared,
        });
        updated += 1;
      } else {
        await this.prisma.socialPost.create({
          data: {
            sourceId,
            campaignId: dto.campaignId,
            platform: post.platform,
            externalId: post.externalId,
            authorHandle: post.authorHandle ?? null,
            postedAt: new Date(post.postedAt),
            ...shared,
          },
        });
        ingested += 1;
      }
    }

    if (rejected.length === dto.posts.length && dto.posts.length > 0) {
      throw new UnprocessableEntityException({
        message: 'No post matched a configured source',
        rejected,
      });
    }

    // Only unanalysed posts are queued, so replaying a batch costs nothing.
    const pending = await this.prisma.socialPost.findMany({
      where: {
        campaignId: dto.campaignId,
        analyzedAt: null,
        externalId: { in: dto.posts.map((post) => post.externalId) },
      },
      select: { id: true },
    });

    for (let i = 0; i < pending.length; i += ANALYZE_CHUNK_SIZE) {
      await this.queue.publish({
        campaignId: dto.campaignId,
        postIds: pending
          .slice(i, i + ANALYZE_CHUNK_SIZE)
          .map((post) => post.id),
      });
    }

    return { ingested, updated, queued: pending.length, rejected };
  }

  async listSources(user: JwtPayload, campaignId: string) {
    await this.assertCampaignAccess(user.sub, campaignId);
    return this.prisma.socialSource.findMany({
      where: { campaignId },
      orderBy: [{ platform: 'asc' }, { displayName: 'asc' }],
    });
  }

  async createSource(user: JwtPayload, dto: CreateSocialSourceDto) {
    await this.assertCampaignAccess(user.sub, dto.campaignId);
    return this.prisma.socialSource.create({
      data: {
        campaignId: dto.campaignId,
        platform: dto.platform,
        handle: dto.handle,
        displayName: dto.displayName,
        config: (dto.config ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  async updateSource(user: JwtPayload, id: string, dto: UpdateSocialSourceDto) {
    const source = await this.prisma.socialSource.findUnique({ where: { id } });
    if (!source) throw new NotFoundException('Social source not found');
    await this.assertCampaignAccess(user.sub, source.campaignId);

    return this.prisma.socialSource.update({
      where: { id },
      data: {
        ...(dto.displayName !== undefined && { displayName: dto.displayName }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.config !== undefined && {
          config: dto.config as Prisma.InputJsonValue,
        }),
      },
    });
  }

  async listPosts(user: JwtPayload, query: ListSocialPostsQueryDto) {
    await this.assertCampaignAccess(user.sub, query.campaignId);

    return this.prisma.socialPost.findMany({
      where: {
        campaignId: query.campaignId,
        ...(query.sentiment && { sentiment: query.sentiment }),
        ...((query.from || query.to) && {
          postedAt: {
            ...(query.from && { gte: new Date(query.from) }),
            ...(query.to && { lte: new Date(query.to) }),
          },
        }),
      },
      orderBy: { postedAt: 'desc' },
      take: Math.min(query.limit ?? 50, 200),
    });
  }

  async getSummary(user: JwtPayload, campaignId: string) {
    await this.assertCampaignAccess(user.sub, campaignId);

    const latest = await this.prisma.sentimentSnapshot.findFirst({
      where: { campaignId, scopeType: ScopeType.CAMPAIGN, scopeId: campaignId },
      orderBy: { windowEnd: 'desc' },
    });

    const [totalPosts, analyzedPosts, sources] = await Promise.all([
      this.prisma.socialPost.count({ where: { campaignId } }),
      this.prisma.socialPost.count({
        where: { campaignId, analyzedAt: { not: null } },
      }),
      this.prisma.socialSource.count({ where: { campaignId, isActive: true } }),
    ]);

    return {
      latestWindow: latest,
      totalPosts,
      analyzedPosts,
      activeSources: sources,
    };
  }
}

/** Re-exported so the controller's Swagger enum stays in step with the DTO. */
export { SocialPlatform };
