import { SocialPlatform } from '@electromon/shared';

/**
 * Seam for platform fetchers (Facebook Graph, etc.).
 *
 * Nothing implements this yet, and nothing needs to: the supported integration
 * path is an external process that POSTs to /ai/social/ingest with the service
 * token, which requires no knowledge of this codebase. This interface exists for
 * the alternative — running a fetcher in-process — so that choice does not
 * require redesigning the module. See docs/AI-SOCIAL.md.
 */
export interface RawSocialPost {
  externalId: string;
  authorHandle?: string;
  text: string;
  lang?: string;
  postedAt: Date;
  permalink?: string;
  mediaUrls?: string[];
  raw?: Record<string, unknown>;
}

export interface SocialFetcherSource {
  id: string;
  campaignId: string;
  handle: string;
  config: unknown;
}

export interface SocialFetcher {
  readonly platform: SocialPlatform;
  /** @param since latest fetchedAt for this source, or null on first run. */
  fetchNewPosts(
    source: SocialFetcherSource,
    since: Date | null,
  ): Promise<RawSocialPost[]>;
}

/** Multi-provider injection token for registered fetchers. */
export const SOCIAL_FETCHERS = Symbol('SOCIAL_FETCHERS');
