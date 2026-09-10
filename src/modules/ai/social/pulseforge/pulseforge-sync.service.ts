import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ScopeType } from '@electromon/shared';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import {
  PulseforgeClient,
  PulseforgeError,
  type PulseforgeSentimentRow,
} from './pulseforge.client';

/**
 * Pulls Pulseforge sentiment into SentimentSnapshot rows.
 *
 * The point of storing per-scope rather than one national figure is that the
 * risk engine scores places, not countries: a negativity spike in one LGA
 * should move that LGA's score and leave its neighbours alone.
 *
 * Coverage is expected to be partial and to change. Places Pulseforge has no
 * posts for simply get no snapshot, which the engine reports as "not measured"
 * rather than as calm. Nothing here is keyed to a particular state.
 */

export const PULSEFORGE_ENGINE = 'pulseforge-v1';

/** Names differ in punctuation and spacing between the two systems. */
function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SyncOutcome {
  states: { matched: number; unmatched: string[] };
  lgas: { matched: number; unmatched: string[] };
  campaign: boolean;
}

@Injectable()
export class PulseforgeSyncService {
  private readonly logger = new Logger(PulseforgeSyncService.name);

  constructor(
    private prisma: PrismaService,
    private client: PulseforgeClient,
  ) {}

  isConfigured(): boolean {
    return this.client.isConfigured();
  }

  /**
   * One sync pass for a campaign.
   *
   * @param windowHours how far back the upstream figures are taken to cover;
   *        only used to stamp the snapshot window, since Pulseforge aggregates
   *        server-side.
   */
  async sync(campaignId: string, windowHours = 24): Promise<SyncOutcome> {
    if (!this.client.isConfigured()) {
      throw new PulseforgeError('Pulseforge is not configured');
    }

    const windowEnd = new Date();
    // Snapped to the hour so repeated syncs update one row per scope per hour.
    // A moving windowStart made the upsert key unique every run, so each sync
    // inserted a fresh snapshot and the table grew without bound.
    const windowStart = new Date(windowEnd.getTime() - windowHours * 3_600_000);
    windowStart.setUTCMinutes(0, 0, 0);

    const [stateRows, lgaRows] = await Promise.all([
      this.client.sentimentBy('state'),
      this.client.sentimentBy('lga'),
    ]);

    const states = await this.syncStates(
      campaignId,
      stateRows,
      windowStart,
      windowEnd,
    );
    const lgas = await this.syncLgas(
      campaignId,
      lgaRows,
      windowStart,
      windowEnd,
    );
    const campaign = await this.syncCampaign(
      campaignId,
      stateRows,
      windowStart,
      windowEnd,
    );

    this.logger.log(
      `Pulseforge sync: ${states.matched} states, ${lgas.matched} LGAs` +
        (states.unmatched.length + lgas.unmatched.length > 0
          ? ` (${states.unmatched.length + lgas.unmatched.length} names unmatched)`
          : ''),
    );

    return { states, lgas, campaign };
  }

  private counts(row: PulseforgeSentimentRow) {
    const positive = Math.max(0, Math.round(row.distribution?.positive ?? 0));
    const neutral = Math.max(0, Math.round(row.distribution?.neutral ?? 0));
    const negative = Math.max(0, Math.round(row.distribution?.negative ?? 0));
    const classified = positive + neutral + negative;
    const total = Math.max(Math.round(row.posts ?? 0), classified);
    return {
      positive,
      neutral,
      negative,
      // Anything the upstream counted but did not classify is unknown, never
      // quietly folded into neutral — the engine treats the two differently.
      unknown: Math.max(0, total - classified),
      total,
    };
  }

  private async syncStates(
    campaignId: string,
    rows: PulseforgeSentimentRow[],
    windowStart: Date,
    windowEnd: Date,
  ) {
    const states = await this.prisma.state.findMany({
      select: { id: true, name: true },
    });
    const byName = new Map(states.map((s) => [normalise(s.name), s.id]));

    let matched = 0;
    const unmatched: string[] = [];

    for (const row of rows) {
      if (!row.state) continue;
      const id = byName.get(normalise(row.state));
      if (!id) {
        // "National" is a Pulseforge rollup, not a state; it feeds the campaign
        // scope below rather than being reported as an unmatched name.
        if (normalise(row.state) !== 'national') unmatched.push(row.state);
        continue;
      }
      await this.upsert(
        campaignId,
        ScopeType.STATE,
        id,
        row,
        windowStart,
        windowEnd,
      );
      matched += 1;
    }
    return { matched, unmatched };
  }

  private async syncLgas(
    campaignId: string,
    rows: PulseforgeSentimentRow[],
    windowStart: Date,
    windowEnd: Date,
  ) {
    const lgas = await this.prisma.lGA.findMany({
      select: { id: true, name: true, state: { select: { name: true } } },
    });

    // LGA names repeat across states, so the state-qualified key is the real
    // one; the bare name is a fallback for rows that arrive without a state.
    const byQualified = new Map<string, string>();
    const byBare = new Map<string, string | null>();
    for (const lga of lgas) {
      byQualified.set(
        `${normalise(lga.state.name)}|${normalise(lga.name)}`,
        lga.id,
      );
      const bare = normalise(lga.name);
      byBare.set(bare, byBare.has(bare) ? null : lga.id);
    }

    let matched = 0;
    const unmatched: string[] = [];

    for (const row of rows) {
      if (!row.lga) continue;
      const qualified = row.state
        ? byQualified.get(`${normalise(row.state)}|${normalise(row.lga)}`)
        : undefined;
      // A bare name that exists in more than one state resolves to null and is
      // reported unmatched rather than assigned to whichever came first.
      const id = qualified ?? byBare.get(normalise(row.lga)) ?? undefined;
      if (!id) {
        unmatched.push(row.state ? `${row.lga} (${row.state})` : row.lga);
        continue;
      }
      await this.upsert(
        campaignId,
        ScopeType.LGA,
        id,
        row,
        windowStart,
        windowEnd,
      );
      matched += 1;
    }
    return { matched, unmatched };
  }

  /**
   * A campaign-wide roll-up, summed from the state rows.
   *
   * This is what a scope with no local reading falls back to, and what the
   * board shows as the national mood.
   */
  private async syncCampaign(
    campaignId: string,
    rows: PulseforgeSentimentRow[],
    windowStart: Date,
    windowEnd: Date,
  ): Promise<boolean> {
    if (rows.length === 0) return false;

    const totals = rows.reduce(
      (acc, row) => {
        const c = this.counts(row);
        acc.positive += c.positive;
        acc.neutral += c.neutral;
        acc.negative += c.negative;
        acc.unknown += c.unknown;
        acc.total += c.total;
        return acc;
      },
      { positive: 0, neutral: 0, negative: 0, unknown: 0, total: 0 },
    );

    await this.write(
      campaignId,
      ScopeType.CAMPAIGN,
      campaignId,
      totals,
      windowStart,
      windowEnd,
    );
    return true;
  }

  private async upsert(
    campaignId: string,
    scopeType: ScopeType,
    scopeId: string,
    row: PulseforgeSentimentRow,
    windowStart: Date,
    windowEnd: Date,
  ) {
    await this.write(
      campaignId,
      scopeType,
      scopeId,
      this.counts(row),
      windowStart,
      windowEnd,
      row.meanSentiment,
      row.emotions,
    );
  }

  private async write(
    campaignId: string,
    scopeType: ScopeType,
    scopeId: string,
    counts: {
      positive: number;
      neutral: number;
      negative: number;
      unknown: number;
      total: number;
    },
    windowStart: Date,
    windowEnd: Date,
    avgScore?: number,
    emotions?: Record<string, number>,
  ) {
    const data = {
      postCount: counts.total,
      positiveCount: counts.positive,
      neutralCount: counts.neutral,
      negativeCount: counts.negative,
      mixedCount: 0,
      unknownCount: counts.unknown,
      avgScore: typeof avgScore === 'number' ? avgScore : null,
      topTopics: emotions ? { emotions } : undefined,
      engineVersion: PULSEFORGE_ENGINE,
      windowEnd,
    };

    await this.prisma.sentimentSnapshot.upsert({
      where: {
        campaignId_scopeType_scopeId_windowStart: {
          campaignId,
          scopeType,
          scopeId,
          windowStart,
        },
      },
      create: { campaignId, scopeType, scopeId, windowStart, ...data },
      update: data,
    });
  }

  /* ---------------------------------------------------------------------- *
   * Read side — what the Social Listening board asks for.
   * ---------------------------------------------------------------------- */

  /**
   * Everything the mood board needs, in one call.
   *
   * Coverage is reported explicitly rather than implied by absence: a board
   * showing 19 states and silently omitting 18 would read as "the country is
   * calm" when it means "we have no posts from there".
   */

  /**
   * Whether the key is not just present but accepted.
   *
   * `isConfigured` only says a key string exists. The health endpoint is
   * unauthenticated, so it answers 200 even for a revoked key — which is how
   * the board came to report "connected" while every real call was 401ing.
   * This asks an endpoint that actually checks the credential.
   */
  private credentialChecked = 0;
  private credentialOk: boolean | null = null;

  async keyAccepted(): Promise<boolean | null> {
    if (!this.client.isConfigured()) return false;
    const now = Date.now();
    if (this.credentialOk !== null && now - this.credentialChecked < 60_000) {
      return this.credentialOk;
    }
    try {
      await this.client.sentimentBy('state');
      this.credentialOk = true;
    } catch (error) {
      this.credentialOk =
        error instanceof PulseforgeError && error.keyRejected ? false : null;
    }
    this.credentialChecked = now;
    return this.credentialOk;
  }

  async mood(campaignId: string) {
    const configured = this.client.isConfigured();
    const keyAccepted = await this.keyAccepted();

    const [campaignRow, stateRows, states] = await Promise.all([
      this.prisma.sentimentSnapshot.findFirst({
        where: {
          campaignId,
          scopeType: ScopeType.CAMPAIGN,
          scopeId: campaignId,
        },
        orderBy: { windowEnd: 'desc' },
      }),
      this.prisma.sentimentSnapshot.findMany({
        where: { campaignId, scopeType: ScopeType.STATE },
        orderBy: { windowEnd: 'desc' },
      }),
      this.prisma.state.findMany({ select: { id: true, name: true, code: true } }),
    ]);

    const nameById = new Map(states.map((s) => [s.id, s]));

    // Newest first, so the first row per scope is the current one.
    const latestByScope = new Map<string, (typeof stateRows)[number]>();
    for (const row of stateRows) {
      if (!latestByScope.has(row.scopeId)) latestByScope.set(row.scopeId, row);
    }

    const share = (row: { postCount: number; unknownCount: number; negativeCount: number }) => {
      const classified = row.postCount - row.unknownCount;
      return classified > 0 ? row.negativeCount / classified : null;
    };

    const rows = [...latestByScope.values()]
      .map((row) => {
        const state = nameById.get(row.scopeId);
        return {
          scopeId: row.scopeId,
          name: state?.name ?? row.scopeId,
          stateCode: state?.code ?? null,
          posts: row.postCount,
          classified: row.postCount - row.unknownCount,
          positive: row.positiveCount,
          neutral: row.neutralCount,
          negative: row.negativeCount,
          negativeShare: share(row),
          avgScore: row.avgScore,
          emotions:
            (row.topTopics as { emotions?: Record<string, number> } | null)
              ?.emotions ?? null,
          windowEnd: row.windowEnd,
        };
      })
      .sort((a, b) => (b.negativeShare ?? -1) - (a.negativeShare ?? -1));

    return {
      configured,
      /** null when we could not tell — upstream unreachable, not key refused. */
      keyAccepted,
      lastSyncedAt: campaignRow?.windowEnd ?? null,
      engine: campaignRow?.engineVersion ?? null,
      coverage: { measured: rows.length, total: states.length },
      national: campaignRow
        ? {
            posts: campaignRow.postCount,
            classified: campaignRow.postCount - campaignRow.unknownCount,
            positive: campaignRow.positiveCount,
            neutral: campaignRow.neutralCount,
            negative: campaignRow.negativeCount,
            negativeShare: share(campaignRow),
          }
        : null,
      rows,
    };
  }

  /**
   * Recent posts, proxied live from Pulseforge.
   *
   * Not stored on our side: they are their corpus, they hold the full thread
   * and author history, and copying it would leave us serving a stale mirror.
   * The board deep-links back for anything beyond the excerpt.
   */
  async feed(params: { state?: string; lga?: string; limit?: number }) {
    if (!this.client.isConfigured()) return { configured: false, posts: [] };

    /**
     * A key that is present but refused is still "no feed", not a server fault.
     *
     * Unlike mood, this reads Pulseforge live, so an upstream 401 arrived here
     * as an unhandled throw and the board answered 500. The panel then showed
     * "No posts yet", which reads as "nobody is posting" rather than "we cannot
     * authenticate" — the one distinction the client's keyRejected flag exists
     * to preserve.
     */
    let posts: Awaited<ReturnType<typeof this.client.posts>>;
    try {
      posts = await this.client.posts({
        state: params.state,
        lga: params.lga,
        limit: Math.min(Math.max(params.limit ?? 40, 1), 100),
      });
    } catch (error) {
      if (error instanceof PulseforgeError) {
        this.logger.warn(
          { err: error, keyRejected: error.keyRejected },
          'Pulseforge feed unavailable',
        );
        return { configured: false, posts: [] };
      }
      throw error;
    }

    return {
      configured: true,
      posts: posts.map((post) => ({
        id: post.id,
        platform: post.platform,
        text: post.text,
        url: post.url,
        timestamp: post.timestamp,
        state: post.geo?.state ?? null,
        lga: post.geo?.lga ?? null,
        sentiment: post.sentiment,
        author: post.author?.displayName ?? post.author?.username ?? null,
        verified: post.author?.verified ?? false,
        topic: post.topic,
        isPolitical: post.isPolitical ?? false,
      })),
    };
  }

  /* ---------------------------------------------------------------------- *
   * The state view, and the national panels that sit above it.
   * ---------------------------------------------------------------------- */

  /** Accept either a two-letter code or the state's name. */
  private async resolveState(codeOrName: string) {
    const value = codeOrName.trim();
    return this.prisma.state.findFirst({
      where: {
        OR: [
          { code: { equals: value, mode: 'insensitive' } },
          { name: { equals: value, mode: 'insensitive' } },
        ],
      },
      select: { id: true, name: true, code: true },
    });
  }

  /**
   * One state's mood, and every LGA in it that has a reading.
   *
   * A state Pulseforge has no posts for still gets a real answer rather than a
   * 404 — "no posts from Rivers yet" is information, and an error page would
   * imply something is broken.
   */
  async stateMood(campaignId: string, codeOrName: string) {
    const state = await this.resolveState(codeOrName);
    if (!state) throw new NotFoundException('No such state');

    const [stateSnapshot, lgas, lgaSnapshots] = await Promise.all([
      this.prisma.sentimentSnapshot.findFirst({
        where: { campaignId, scopeType: ScopeType.STATE, scopeId: state.id },
        orderBy: { windowEnd: 'desc' },
      }),
      this.prisma.lGA.findMany({
        where: { stateId: state.id },
        select: { id: true, name: true },
      }),
      this.prisma.sentimentSnapshot.findMany({
        where: {
          campaignId,
          scopeType: ScopeType.LGA,
          scopeId: {
            in: (
              await this.prisma.lGA.findMany({
                where: { stateId: state.id },
                select: { id: true },
              })
            ).map((row) => row.id),
          },
        },
        orderBy: { windowEnd: 'desc' },
      }),
    ]);

    const latest = new Map<string, (typeof lgaSnapshots)[number]>();
    for (const row of lgaSnapshots) {
      if (!latest.has(row.scopeId)) latest.set(row.scopeId, row);
    }

    const shape = (row: {
      postCount: number;
      unknownCount: number;
      positiveCount: number;
      neutralCount: number;
      negativeCount: number;
      avgScore: number | null;
      topTopics: unknown;
      windowEnd: Date;
    }) => {
      const classified = row.postCount - row.unknownCount;
      return {
        posts: row.postCount,
        classified,
        positive: row.positiveCount,
        neutral: row.neutralCount,
        negative: row.negativeCount,
        negativeShare: classified > 0 ? row.negativeCount / classified : null,
        avgScore: row.avgScore,
        emotions:
          (row.topTopics as { emotions?: Record<string, number> } | null)
            ?.emotions ?? null,
        windowEnd: row.windowEnd,
      };
    };

    const lgaRows = lgas
      .map((lga) => {
        const snapshot = latest.get(lga.id);
        return snapshot
          ? { lgaId: lga.id, name: lga.name, ...shape(snapshot) }
          : null;
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => (b.negativeShare ?? -1) - (a.negativeShare ?? -1));

    return {
      configured: this.client.isConfigured(),
      state,
      summary: stateSnapshot ? shape(stateSnapshot) : null,
      lgas: lgaRows,
      coverage: { measuredLgas: lgaRows.length, totalLgas: lgas.length },
      lastSyncedAt: stateSnapshot?.windowEnd ?? null,
    };
  }

  /** Daily opinion index, national or for one state. */
  async opinion(codeOrName?: string) {
    if (!this.client.isConfigured()) return { configured: false, series: [] };
    let stateName: string | undefined;
    if (codeOrName) {
      const state = await this.resolveState(codeOrName);
      if (!state) throw new NotFoundException('No such state');
      stateName = state.name;
    }
    const data = await this.client.opinion(stateName);
    return { configured: true, ...data };
  }

  /**
   * Who is loudest, and who actually carries a message.
   *
   * Reach and influence are different questions: an amplifier is an account
   * with high centrality in the graph, which is often not the one with the most
   * followers. Both lists are returned rather than merged so the distinction
   * survives to the screen.
   */
  async voices(codeOrName?: string) {
    if (!this.client.isConfigured()) {
      return { configured: false, top: [], amplifiers: [] };
    }
    let stateName: string | undefined;
    if (codeOrName) {
      const state = await this.resolveState(codeOrName);
      if (!state) throw new NotFoundException('No such state');
      stateName = state.name;
    }

    const [authors, nodes] = await Promise.all([
      this.client.authors({ state: stateName, limit: 8 }),
      this.client.network({ state: stateName, limit: 12 }),
    ]);

    const AMPLIFIER_CENTRALITY = 0.6;
    const SMALL_ACCOUNT_FOLLOWERS = 50_000;

    return {
      configured: true,
      top: authors.map((author) => ({
        authorId: author.authorId,
        name: author.displayName || author.username,
        handle: author.username,
        platform: author.platform,
        verified: author.verified,
        followers: author.followersCount,
        lga: author.geo?.lga ?? null,
      })),
      amplifiers: nodes
        .filter((node) => node.centrality >= AMPLIFIER_CENTRALITY)
        .sort((a, b) => b.centrality - a.centrality)
        .map((node) => ({
          authorId: node.authorId,
          name: node.username,
          platform: node.platform,
          followers: node.followersCount,
          centrality: node.centrality,
          lga: node.lga,
          // The interesting case: small account, outsized reach.
          smallButCentral: node.followersCount < SMALL_ACCOUNT_FOLLOWERS,
        })),
    };
  }

  /** Story clusters. National only; the upstream ignores a state filter. */
  async narratives(limit = 8) {
    if (!this.client.isConfigured()) return { configured: false, rows: [] };
    const rows = await this.client.narratives(limit);
    return {
      configured: true,
      scope: 'NATIONAL' as const,
      rows: rows.sort((a, b) => b.growthRate - a.growthRate),
    };
  }

  /**
   * Pulseforge's own detections, above the noise floor.
   *
   * Deliberately never fed into the risk score: these are a third party's
   * opinion, and the score's whole claim is that it is arithmetic we can
   * defend line by line.
   */
  async alerts() {
    if (!this.client.isConfigured()) return { configured: false, rows: [] };
    const rows = await this.client.alerts(50);
    return {
      configured: true,
      provenance: 'Raised by Pulseforge detection — context, not part of any score.',
      rows: rows
        .filter((row) => row.severity !== 'low' && row.status !== 'resolved')
        .slice(0, 6),
    };
  }

  /**
   * Stance toward the figures Pulseforge tracks.
   *
   * Net stance and polarization say different things: broadly disliked is a low
   * net with low polarization, divisive is a middling net with high
   * polarization. The same red bar would hide that difference.
   */
  async stances(limit = 8) {
    if (!this.client.isConfigured()) return { configured: false, rows: [] };

    const entities = await this.client.entities({ type: 'PERSON', limit: 30 });
    const ranked = entities
      .filter((entity) => entity.stanceCount > 0)
      .sort((a, b) => b.stanceCount - a.stanceCount)
      .slice(0, limit);

    const rows = [];
    for (const entity of ranked) {
      const stance = await this.client.stance(entity.id);
      if (!stance) continue;
      rows.push({
        entityId: entity.id,
        name: stance.entity,
        type: stance.type,
        total: stance.total,
        pro: stance.pro,
        anti: stance.anti,
        neutral: stance.neutral,
        netStance: stance.netStance,
        polarization: stance.polarization,
        reading:
          stance.polarization >= 0.6
            ? ('DIVISIVE' as const)
            : stance.netStance <= -0.2
              ? ('BROADLY_NEGATIVE' as const)
              : stance.netStance >= 0.2
                ? ('BROADLY_POSITIVE' as const)
                : ('MIXED' as const),
      });
    }
    return { configured: true, rows };
  }

  /** Stance toward one named figure, resolving the name upstream. */
  async stanceFor(who: string) {
    if (!this.client.isConfigured()) return { configured: false };
    const matches = await this.client.entities({ q: who, limit: 8 });
    if (matches.length === 0) return { configured: true, found: false };
    if (matches.length > 1) {
      const exact = matches.filter(
        (entity) => entity.name.toLowerCase() === who.trim().toLowerCase(),
      );
      if (exact.length !== 1) {
        // Ambiguity is returned rather than guessed, the same rule the contact
        // lookup follows.
        return {
          configured: true,
          found: false,
          ambiguous: matches.map((entity) => ({
            name: entity.name,
            type: entity.type,
          })),
        };
      }
      matches.splice(0, matches.length, exact[0]);
    }
    const stance = await this.client.stance(matches[0].id);
    return stance
      ? { configured: true, found: true, ...stance }
      : { configured: true, found: false };
  }
}
