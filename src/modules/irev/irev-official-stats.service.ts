import { Injectable } from '@nestjs/common';
import { IrevClient, type IrevResultStats } from './irev.client';
import { inecStateIdForCode } from './irev-inec-state-codes';

export type StatePortalEstimate = {
  documentsUploaded: number;
  totalPollingUnits: number;
  uploadPercent: number;
  inecOnly: number;
  campaignOnly: number;
  publicationGapPercent: number;
  estimateMode: 'national-prorata';
};

export type IrevSubmissionRace = {
  scope: 'national' | 'state';
  scopeLabel: string;
  portalUrl: string;
  official: {
    available: boolean;
    documentsUploaded: number;
    totalPollingUnits: number;
    uploadPercent: number;
    lastUploadAt: string | null;
    fetchedAt: string;
    unavailableReason?: string | null;
    apiBaseUrl?: string | null;
  };
  campaign: {
    submitted: number;
    totalPollingUnits: number;
    submitPercent: number;
  };
  comparison: {
    inecAhead: number;
    campaignAhead: number;
    uploadGapPercent: number;
    bothReported: number;
  };
};

type CacheEntry = {
  expiresAt: number;
  value: IrevResultStats | null;
  error: string | null;
  apiBaseUrl: string | null;
};

@Injectable()
export class IrevOfficialStatsService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs = Number.parseInt(process.env.IREV_STATS_CACHE_MS ?? '300000', 10) || 300_000;

  constructor(private client: IrevClient) {}

  async buildSubmissionRace(input: {
    electionId: string | null;
    scopeLabel: string;
    campaignSubmitted: number;
    campaignTotalPollingUnits: number;
  }): Promise<IrevSubmissionRace | null> {
    if (!this.client.isEnabled() || !input.electionId) return null;

    const fetched = await this.fetchStats(input.electionId, null);
    const official = fetched.stats;
    const campaignSubmitPercent = pct(input.campaignSubmitted, input.campaignTotalPollingUnits);

    const inecAhead = Math.max(0, (official?.documentsUploaded ?? 0) - input.campaignSubmitted);
    const campaignAhead = Math.max(0, input.campaignSubmitted - (official?.documentsUploaded ?? 0));
    const bothReported = official
      ? Math.min(official.documentsUploaded, input.campaignSubmitted)
      : 0;

    return {
      scope: 'national',
      scopeLabel: input.scopeLabel,
      portalUrl: this.client.electionPortalUrl(input.electionId),
      official: official
        ? {
            available: true,
            documentsUploaded: official.documentsUploaded,
            totalPollingUnits: official.totalPollingUnits,
            uploadPercent: official.uploadPercent,
            lastUploadAt: official.lastUploadAt,
            fetchedAt: new Date().toISOString(),
            apiBaseUrl: fetched.apiBaseUrl,
          }
        : {
            available: false,
            documentsUploaded: 0,
            totalPollingUnits: 0,
            uploadPercent: 0,
            lastUploadAt: null,
            fetchedAt: new Date().toISOString(),
            unavailableReason: fetched.error,
            apiBaseUrl: fetched.apiBaseUrl,
          },
      campaign: {
        submitted: input.campaignSubmitted,
        totalPollingUnits: input.campaignTotalPollingUnits,
        submitPercent: campaignSubmitPercent,
      },
      comparison: {
        inecAhead,
        campaignAhead,
        uploadGapPercent: Math.round((official?.uploadPercent ?? 0) - campaignSubmitPercent),
        bothReported,
      },
    };
  }

  buildStateSubmissionRace(input: {
    electionId: string;
    stateCode: string;
    stateName: string;
    campaignSubmitted: number;
    totalPollingUnits: number;
    officialPortal: StatePortalEstimate;
    nationalRace: IrevSubmissionRace | null;
  }): IrevSubmissionRace | null {
    if (!this.client.isEnabled()) return null;

    const stateInecId = inecStateIdForCode(input.stateCode);
    const portal = input.officialPortal;
    const campaignSubmitPercent = pct(input.campaignSubmitted, input.totalPollingUnits);
    const bothReported = Math.min(portal.documentsUploaded, input.campaignSubmitted);

    return {
      scope: 'state',
      scopeLabel: input.stateName,
      portalUrl: this.client.electionPortalUrl(input.electionId, stateInecId ?? undefined),
      official: {
        available: true,
        documentsUploaded: portal.documentsUploaded,
        totalPollingUnits: portal.totalPollingUnits,
        uploadPercent: portal.uploadPercent,
        lastUploadAt: input.nationalRace?.official.lastUploadAt ?? null,
        fetchedAt: new Date().toISOString(),
        apiBaseUrl: input.nationalRace?.official.apiBaseUrl ?? null,
      },
      campaign: {
        submitted: input.campaignSubmitted,
        totalPollingUnits: input.totalPollingUnits,
        submitPercent: campaignSubmitPercent,
      },
      comparison: {
        inecAhead: portal.inecOnly,
        campaignAhead: portal.campaignOnly,
        uploadGapPercent: Math.round(portal.uploadPercent - campaignSubmitPercent),
        bothReported,
      },
    };
  }

  async getStateOfficialStats(
    electionId: string,
    stateInecId: number,
    options?: { cacheOnly?: boolean },
  ) {
    const cacheKey = `${electionId}:${stateInecId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return this.formatCachedStateStats(cached);
    }
    if (options?.cacheOnly) {
      return {
        available: false as const,
        unavailableReason: 'Portal stats not warmed yet',
        apiBaseUrl: cached?.apiBaseUrl ?? null,
      };
    }

    const fetched = await this.fetchStats(electionId, stateInecId);
    const official = fetched.stats;
    if (!official) {
      return {
        available: false as const,
        unavailableReason: fetched.error,
        apiBaseUrl: fetched.apiBaseUrl,
      };
    }
    return {
      available: true as const,
      documentsUploaded: official.documentsUploaded,
      totalPollingUnits: official.totalPollingUnits,
      uploadPercent: official.uploadPercent,
      lastUploadAt: official.lastUploadAt,
      apiBaseUrl: fetched.apiBaseUrl,
    };
  }

  private formatCachedStateStats(cached: CacheEntry) {
    if (!cached.value) {
      return {
        available: false as const,
        unavailableReason: cached.error,
        apiBaseUrl: cached.apiBaseUrl,
      };
    }
    return {
      available: true as const,
      documentsUploaded: cached.value.documentsUploaded,
      totalPollingUnits: cached.value.totalPollingUnits,
      uploadPercent: cached.value.uploadPercent,
      lastUploadAt: cached.value.lastUploadAt,
      apiBaseUrl: cached.apiBaseUrl,
    };
  }

  enrichStateGridWithPortalEstimates<
    T extends {
      stateId: string;
      totalPollingUnits: number;
      campaignSubmitted: number;
      inecPublished: number;
      inecOnly: number;
      campaignOnly: number;
    },
  >(stateGrid: T[], submissionRace: IrevSubmissionRace | null): Array<T & { officialPortal: StatePortalEstimate | null }> {
    const national = submissionRace?.official;
    if (!national?.available || national.totalPollingUnits <= 0) {
      return stateGrid.map((row) => ({ ...row, officialPortal: null }));
    }

    return stateGrid.map((row) => {
      const share = row.totalPollingUnits / national.totalPollingUnits;
      const documentsUploaded = Math.round(national.documentsUploaded * share);
      const uploadPercent =
        row.totalPollingUnits > 0
          ? Math.round((documentsUploaded / row.totalPollingUnits) * 10000) / 100
          : 0;
      const inecOnly = Math.max(0, documentsUploaded - row.campaignSubmitted);
      const campaignOnly = Math.max(0, row.campaignSubmitted - documentsUploaded);
      const publicationGapPercent =
        row.totalPollingUnits > 0
          ? Math.round(((inecOnly + campaignOnly) / row.totalPollingUnits) * 100)
          : 0;

      return {
        ...row,
        officialPortal: {
          documentsUploaded,
          totalPollingUnits: row.totalPollingUnits,
          uploadPercent,
          inecOnly,
          campaignOnly,
          publicationGapPercent,
          estimateMode: 'national-prorata' as const,
        },
      };
    });
  }

  private async fetchStats(electionId: string, stateInecId: number | null) {
    const cacheKey = `${electionId}:${stateInecId ?? 'national'}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return {
        stats: cached.value,
        error: cached.error,
        apiBaseUrl: cached.apiBaseUrl,
      };
    }

    const response = await this.client.getResultStats(electionId, {
      stateInecId: stateInecId ?? undefined,
    });
    this.cache.set(cacheKey, {
      value: response.stats,
      error: response.error,
      apiBaseUrl: response.apiBaseUrl,
      expiresAt: Date.now() + (response.stats ? this.ttlMs : 30_000),
    });
    return response;
  }
}

function pct(part: number, whole: number) {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 10000) / 100;
}
