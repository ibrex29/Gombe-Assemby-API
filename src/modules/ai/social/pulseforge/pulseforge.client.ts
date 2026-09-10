import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Read client for the Pulseforge intelligence API.
 *
 * Pulseforge issues us a read-only key, so this is a pull rather than the push
 * the ingest endpoint was originally designed for. Both remain valid: the
 * ingest endpoint stays for any source that would rather post to us.
 *
 * Written the same way as the OpenRouter client — hand-rolled fetch, explicit
 * timeout, and graceful degradation when the key is unset — so an unconfigured
 * environment simply reports no social data rather than failing a sweep.
 */

const DEFAULT_BASE_URL = 'https://pulseforge.vercel.app/api/v1';
const REQUEST_TIMEOUT_MS = 20_000;

/** One row of `/signals/sentiment`, whichever grouping was asked for. */
export interface PulseforgeSentimentRow {
  state?: string;
  lga?: string;
  posts: number;
  meanSentiment: number;
  distribution?: {
    positive?: number;
    neutral?: number;
    negative?: number;
  };
  emotions?: Record<string, number>;
}

export interface PulseforgePost {
  id: string;
  postId: string;
  platform: string;
  text: string;
  /** Now a real permalink — upstream used to fill this with placeholders. */
  url: string | null;
  timestamp: string;
  geo: { state?: string | null; lga?: string | null } | null;
  sentiment: number | null;
  language: string | null;
  keywords: string[] | null;
  isPolitical: boolean | null;
  topic: string | null;
  author: {
    username?: string | null;
    displayName?: string | null;
    verified?: boolean | null;
  } | null;
  engagement: Record<string, number> | null;
}

export class PulseforgeError extends Error {
  constructor(
    message: string,
    /** Upstream HTTP status, when the request actually reached Pulseforge. */
    readonly status?: number,
  ) {
    super(message);
  }

  /**
   * The key was refused.
   *
   * Worth its own flag: a rejected key is an operator problem with a specific
   * fix (replace it), and it must never be reported as "upstream is down" —
   * those two lead people to look in completely different places.
   */
  get keyRejected(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

@Injectable()
export class PulseforgeClient {
  private readonly logger = new Logger(PulseforgeClient.name);

  constructor(private config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('PULSEFORGE_API_KEY'));
  }

  private baseUrl(): string {
    const configured = this.config.get<string>('PULSEFORGE_BASE_URL')?.trim();
    return (configured || DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  private async get<T>(
    path: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    const key = this.config.get<string>('PULSEFORGE_API_KEY');
    if (!key) {
      throw new PulseforgeError('Pulseforge is not configured');
    }

    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') query.set(name, String(value));
    }
    const suffix = query.toString() ? `?${query.toString()}` : '';

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl()}${path}${suffix}`, {
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new PulseforgeError(
        `Pulseforge request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new PulseforgeError(
          'Pulseforge rejected the API key. Replace PULSEFORGE_API_KEY with a current key.',
          response.status,
        );
      }
      throw new PulseforgeError(
        `Pulseforge returned ${response.status} for ${path}`,
        response.status,
      );
    }

    // Every documented response wraps its payload in `data`.
    const body = (await response.json()) as { data?: unknown };
    return body.data as T;
  }

  /** Health, used to tell "not configured" apart from "configured but down". */
  async health(): Promise<{ status: string; latencyMs?: number }> {
    return this.get<{ status: string; latencyMs?: number }>('/meta/health');
  }

  /**
   * Sentiment aggregated by state or LGA.
   *
   * `distribution` is the field that matters: it maps straight onto the
   * positive/neutral/negative counts a SentimentSnapshot stores, so no mean has
   * to be reverse-engineered into a share.
   */
  async sentimentBy(
    groupBy: 'state' | 'lga',
    range?: { from?: string; to?: string },
  ): Promise<PulseforgeSentimentRow[]> {
    const rows = await this.get<PulseforgeSentimentRow[]>(
      '/signals/sentiment',
      { groupBy, from: range?.from, to: range?.to },
    );
    return Array.isArray(rows) ? rows : [];
  }

  /** Recent posts, newest first. Cursor-paginated upstream. */
  async posts(params: {
    state?: string;
    lga?: string;
    limit?: number;
    cursor?: string;
    from?: string;
  }): Promise<PulseforgePost[]> {
    const rows = await this.get<PulseforgePost[]>('/posts', {
      state: params.state,
      lga: params.lga,
      limit: params.limit ?? 50,
      cursor: params.cursor,
      from: params.from,
    });
    return Array.isArray(rows) ? rows : [];
  }

  /** Daily 0-100 opinion index, optionally for one state. */
  async opinion(state?: string): Promise<{
    latest: { date: string; index: number } | null;
    change: number | null;
    series: Array<{ date: string; index: number }>;
  }> {
    const data = await this.get<{
      latest?: { date: string; index: number };
      change?: number;
      series?: Array<{ date: string; index: number }>;
    }>('/indicators/opinion', { state });
    return {
      latest: data?.latest ?? null,
      change: typeof data?.change === 'number' ? data.change : null,
      series: (data?.series ?? []).map((point) => ({
        date: point.date,
        index: point.index,
      })),
    };
  }

  /** Accounts with the most reach, optionally within one state. */
  async authors(params: { state?: string; limit?: number }): Promise<
    Array<{
      authorId: string;
      username: string;
      displayName: string | null;
      platform: string;
      verified: boolean;
      followersCount: number;
      geo: { state?: string | null; lga?: string | null } | null;
    }>
  > {
    const rows = await this.get<
      Array<{
        authorId: string;
        username: string;
        displayName?: string | null;
        platform: string;
        verified?: boolean;
        followersCount?: number;
        geo?: { state?: string | null; lga?: string | null } | null;
      }>
    >('/authors', {
      state: params.state,
      sortBy: 'followersCount',
      limit: params.limit ?? 8,
    });
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      authorId: row.authorId,
      username: row.username,
      displayName: row.displayName ?? null,
      platform: row.platform,
      verified: Boolean(row.verified),
      followersCount: row.followersCount ?? 0,
      geo: row.geo ?? null,
    }));
  }

  /**
   * The influence graph.
   *
   * Centrality is the point: an account with 9,700 followers and 0.92
   * centrality moves more than one with a million and no bridges, and
   * follower-sorting alone never surfaces it.
   */
  async network(params: { state?: string; limit?: number }): Promise<
    Array<{
      authorId: string;
      username: string;
      platform: string;
      followersCount: number;
      centrality: number;
      community: number | null;
      state: string | null;
      lga: string | null;
    }>
  > {
    const data = await this.get<{
      nodes?: Array<{
        author?: {
          authorId?: string;
          username?: string;
          platform?: string;
          followersCount?: number;
          state?: string | null;
          lga?: string | null;
        };
        centrality?: number;
        community?: number;
      }>;
    }>('/network', { state: params.state, limit: params.limit ?? 12 });

    return (data?.nodes ?? [])
      .filter((node) => node.author?.authorId)
      .map((node) => ({
        authorId: node.author!.authorId!,
        username: node.author!.username ?? '',
        platform: node.author!.platform ?? '',
        followersCount: node.author!.followersCount ?? 0,
        centrality: node.centrality ?? 0,
        community: node.community ?? null,
        state: node.author!.state ?? null,
        lga: node.author!.lga ?? null,
      }));
  }

  /** Story clusters. National only — the upstream ignores a state filter. */
  async narratives(limit = 8): Promise<
    Array<{
      narrative: string;
      topic: string | null;
      volume: number;
      growthRate: number;
      shareOfVoice: number;
      updatedAt: string;
    }>
  > {
    const rows = await this.get<
      Array<{
        narrative: string;
        topic?: string | null;
        volume?: number;
        growthRate?: number;
        shareOfVoice?: number;
        updatedAt?: string;
      }>
    >('/narratives', { limit });
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      narrative: row.narrative,
      topic: row.topic ?? null,
      volume: row.volume ?? 0,
      growthRate: row.growthRate ?? 0,
      shareOfVoice: row.shareOfVoice ?? 0,
      updatedAt: row.updatedAt ?? new Date(0).toISOString(),
    }));
  }

  /** Pulseforge's own detections. Context for us, never a scoring input. */
  async alerts(limit = 25): Promise<
    Array<{
      id: string;
      title: string;
      severity: string;
      status: string;
      score: number;
      createdAt: string;
    }>
  > {
    const rows = await this.get<
      Array<{
        id: string;
        title: string;
        severity?: string;
        status?: string;
        score?: number;
        createdAt?: string;
      }>
    >('/alerts', { limit });
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      id: row.id,
      title: row.title,
      severity: row.severity ?? 'low',
      status: row.status ?? 'open',
      score: row.score ?? 0,
      createdAt: row.createdAt ?? new Date(0).toISOString(),
    }));
  }

  /** Tracked people, parties and organisations. */
  async entities(params: { type?: string; q?: string; limit?: number }): Promise<
    Array<{
      id: string;
      name: string;
      type: string;
      mentionCount: number;
      stanceCount: number;
    }>
  > {
    const rows = await this.get<
      Array<{
        id: string;
        name: string;
        type: string;
        mentionCount?: number;
        stanceCount?: number;
      }>
    >('/entities', { type: params.type, q: params.q, limit: params.limit ?? 30 });
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      mentionCount: row.mentionCount ?? 0,
      stanceCount: row.stanceCount ?? 0,
    }));
  }

  /** Pro / anti / neutral toward one entity. */
  async stance(entityId: string): Promise<{
    entity: string;
    type: string;
    total: number;
    pro: number;
    anti: number;
    neutral: number;
    netStance: number;
    polarization: number;
  } | null> {
    const rows = await this.get<
      Array<{
        entity: string;
        type: string;
        total?: number;
        pro?: number;
        anti?: number;
        neutral?: number;
        netStance?: number;
        polarization?: number;
      }>
    >('/signals/stance', { entityId });
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) return null;
    return {
      entity: row.entity,
      type: row.type,
      total: row.total ?? 0,
      pro: row.pro ?? 0,
      anti: row.anti ?? 0,
      neutral: row.neutral ?? 0,
      netStance: row.netStance ?? 0,
      polarization: row.polarization ?? 0,
    };
  }
}
