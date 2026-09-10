import { Injectable, Logger } from '@nestjs/common';
import { inecStateIdForCode } from './irev-inec-state-codes';
import type { IrevPuRecord } from './irev-mapper';
import { normalizeGeoName } from './irev-mapper';

type IrevApiEnvelope<T> = {
  success?: boolean;
  data?: T;
};

export type IrevResultStats = {
  totalPollingUnits: number;
  documentsUploaded: number;
  uploadPercent: number;
  lastUploadAt: string | null;
  raw?: Record<string, unknown>;
};

export type IrevResultStatsResponse = {
  stats: IrevResultStats | null;
  error: string | null;
  apiBaseUrl: string | null;
};

type IrevWardRow = {
  _id: string;
  name?: string;
  ward_id?: number;
};

const FALLBACK_API_BASES = [
  'https://dolphin-app-sleqh.ondigitalocean.app/api/v1',
  'https://lv001-r.inecelectionresults.ng/api/v1',
  'https://lv001-g.inecelectionresults.ng/api/v1',
];

@Injectable()
export class IrevClient {
  private readonly logger = new Logger(IrevClient.name);
  private resolvedApiBase: { value: string; expiresAt: number } | null = null;

  isEnabled(): boolean {
    return process.env.IREV_ENABLED === 'true';
  }

  /** Explicit override from env, if set. */
  configuredBaseUrl(): string | null {
    const raw = process.env.IREV_BASE_URL?.trim();
    return raw ? raw.replace(/\/$/, '') : null;
  }

  baseUrl(): string {
    return this.configuredBaseUrl() ?? FALLBACK_API_BASES[0];
  }

  portalBaseUrl(): string {
    return process.env.IREV_PORTAL_URL?.replace(/\/$/, '') ?? 'https://www.inecelectionresults.ng';
  }

  defaultElectionId(): string | null {
    return process.env.IREV_ELECTION_ID?.trim() || null;
  }

  electionPortalUrl(electionId: string, stateInecId?: number): string {
    const base = `${this.portalBaseUrl()}/elections/${encodeURIComponent(electionId)}`;
    return stateInecId != null ? `${base}?state=${stateInecId}` : base;
  }

  async getResultStats(
    electionId: string,
    options?: { stateInecId?: number },
  ): Promise<IrevResultStatsResponse> {
    const query =
      options?.stateInecId != null
        ? `?state=${encodeURIComponent(String(options.stateInecId))}`
        : '';
    const path = `/elections/${encodeURIComponent(electionId)}/result/stats${query}`;
    const bases = await this.apiBaseCandidates();
    const errors: string[] = [];

    for (const base of bases) {
      const url = `${base}${path}`;
      const envelope = await this.getJson<IrevApiEnvelope<Record<string, unknown>>>(url);
      if (!envelope) {
        errors.push(`${base}: request failed`);
        continue;
      }
      if (!envelope.data || typeof envelope.data !== 'object') {
        errors.push(`${base}: unexpected response shape`);
        continue;
      }

      const data = envelope.data;
      const totalPollingUnits = pickNumber(data, ['pus', 'total_pus', 'totalPUs', 'expected']);
      const documentsUploaded = pickNumber(data, [
        'documents',
        'uploaded',
        'submitted',
        'total_submitted',
        'totalSubmitted',
      ]);
      if (totalPollingUnits == null || documentsUploaded == null) {
        errors.push(`${base}: missing pus/documents fields`);
        continue;
      }

      this.rememberWorkingBase(base);
      const uploadPercent =
        totalPollingUnits > 0 ? Math.round((documentsUploaded / totalPollingUnits) * 10000) / 100 : 0;
      const lastUploadRaw =
        pickString(data, ['last_upload_time', 'lastUploadTime', 'last_upload_at']) ??
        pickNestedString(data, ['latest', 'updated_at']) ??
        pickNestedString(data, ['latest', 'document', 'updated_at']);
      const lastUploadAt = lastUploadRaw ? safeIso(lastUploadRaw) : null;

      return {
        apiBaseUrl: base,
        error: null,
        stats: {
          totalPollingUnits,
          documentsUploaded,
          uploadPercent,
          lastUploadAt,
          raw: data,
        },
      };
    }

    return {
      stats: null,
      apiBaseUrl: bases[0] ?? null,
      error:
        errors.length > 0
          ? `Could not reach INEC stats API (${errors.join('; ')})`
          : 'Could not reach INEC stats API',
    };
  }

  async getWardPollingUnits(electionId: string, irevWardId: string): Promise<IrevPuRecord[]> {
    const path = `/elections/${encodeURIComponent(electionId)}/pus?ward=${encodeURIComponent(irevWardId)}`;
    const envelope = await this.getJsonFromBases<unknown>(path);
    if (Array.isArray(envelope)) return envelope as IrevPuRecord[];
    if (!envelope || typeof envelope !== 'object') return [];
    const data = (envelope as { data?: unknown }).data;
    if (Array.isArray(data)) return data as IrevPuRecord[];
    if (data && typeof data === 'object') {
      const row = data as Record<string, unknown>;
      if (Array.isArray(row.pus)) return row.pus as IrevPuRecord[];
      if (Array.isArray(row.polling_units)) return row.polling_units as IrevPuRecord[];
    }
    return [];
  }

  async resolveWardMapping(input: {
    electionId: string;
    stateCode: string;
    lgaName: string;
    wardName: string;
  }): Promise<{
    irevWardId: string;
    irevLgaId: string;
    irevStateId: string;
    lgaWards: Array<{ _id: string; name?: string }>;
  } | null> {
    const stateNumeric = inecStateIdForCode(input.stateCode);
    if (stateNumeric == null) return null;

    const lgaPath = `/elections/${encodeURIComponent(input.electionId)}/lga/state/${stateNumeric}`;
    const lgaEnvelope = await this.getJsonFromBases<
      IrevApiEnvelope<
        Array<{
          _id: string;
          name?: string;
          lga?: { _id?: string; name?: string };
          wards?: IrevWardRow[];
        }>
      >
    >(lgaPath);
    const lgas = Array.isArray(lgaEnvelope?.data) ? lgaEnvelope.data : [];
    const targetLga = normalizeGeoName(input.lgaName);
    const irevLga = lgas.find((row) => {
      const lgaName = row.lga?.name ?? row.name ?? '';
      return normalizeGeoName(lgaName) === targetLga;
    });
    if (!irevLga) return null;

    const irevLgaId = irevLga.lga?._id ?? irevLga._id;
    if (!irevLgaId) return null;

    let wards = Array.isArray(irevLga.wards) ? irevLga.wards : [];
    if (wards.length === 0) {
      const wardPath = `/elections/${encodeURIComponent(input.electionId)}/lga/${encodeURIComponent(irevLgaId)}`;
      const wardEnvelope = await this.getJsonFromBases<IrevApiEnvelope<{ wards?: IrevWardRow[] }>>(wardPath);
      wards = Array.isArray(wardEnvelope?.data?.wards) ? wardEnvelope.data.wards : [];
    }

    const targetWard = normalizeGeoName(input.wardName);
    const irevWard = wards.find((row) => normalizeGeoName(row.name ?? '') === targetWard);
    if (!irevWard?._id) return null;

    return {
      irevWardId: irevWard._id,
      irevLgaId,
      irevStateId: String(stateNumeric),
      lgaWards: wards.map((row) => ({ _id: row._id, name: row.name })),
    };
  }

  private async getJsonFromBases<T>(path: string): Promise<T | null> {
    const bases = await this.apiBaseCandidates();
    for (const base of bases) {
      const result = await this.getJson<T>(`${base}${path}`);
      if (result != null) {
        this.rememberWorkingBase(base);
        return result;
      }
    }
    return null;
  }

  private async apiBaseCandidates(): Promise<string[]> {
    const configured = this.configuredBaseUrl();
    if (configured) return unique([configured, ...FALLBACK_API_BASES]);

    if (this.resolvedApiBase && this.resolvedApiBase.expiresAt > Date.now()) {
      return unique([this.resolvedApiBase.value, ...FALLBACK_API_BASES]);
    }

    const discovered = await this.discoverApiBaseFromPortal();
    if (discovered) {
      this.resolvedApiBase = { value: discovered, expiresAt: Date.now() + 86_400_000 };
      return unique([discovered, ...FALLBACK_API_BASES]);
    }

    return [...FALLBACK_API_BASES];
  }

  private rememberWorkingBase(base: string) {
    this.resolvedApiBase = { value: base, expiresAt: Date.now() + 86_400_000 };
  }

  private async discoverApiBaseFromPortal(): Promise<string | null> {
    try {
      const portal = this.portalBaseUrl();
      const html = await this.fetchText(`${portal}/`);
      if (!html) return null;

      const mainScript = html.match(/main\.[a-f0-9]+\.js/i)?.[0];
      if (!mainScript) return null;

      const js = await this.fetchText(`${portal}/${mainScript}`);
      if (!js) return null;

      const endpointMatch = js.match(
        /getEndpoint\(\)\{return"(https:\/\/[^"]+\/api\/v1)"/i,
      );
      if (endpointMatch?.[1]) return endpointMatch[1];

      const hostedMatch = js.match(/https:\/\/[a-z0-9-]+\.ondigitalocean\.app\/api\/v1/i);
      if (hostedMatch?.[0]) return hostedMatch[0];

      const legacyMatch = js.match(/https:\/\/lv\d{3}-[a-z]\.inecelectionresults\.ng\/api\/v1/i);
      return legacyMatch?.[0] ?? null;
    } catch (error) {
      this.logger.warn({ err: error }, 'Failed to discover INEC API base from portal');
      return null;
    }
  }

  private async fetchText(url: string): Promise<string | null> {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'text/html,text/javascript,*/*' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return null;
      return await response.text();
    } catch {
      return null;
    }
  }

  private async getJson<T>(url: string): Promise<T | null> {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(25_000),
      });
      if (!response.ok) {
        this.logger.warn({ url, status: response.status }, 'IReV API request failed');
        return null;
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        this.logger.warn({ url, contentType }, 'IReV API returned non-JSON response');
        return null;
      }
      return (await response.json()) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cause =
        error instanceof Error && error.cause instanceof Error
          ? error.cause.message
          : error instanceof Error && typeof error.cause === 'string'
            ? error.cause
            : null;
      this.logger.warn({ err: message, cause, url }, 'IReV API request error');
      return null;
    }
  }
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function pickNumber(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function pickNestedString(row: Record<string, unknown>, path: string[]): string | null {
  let current: unknown = row;
  for (const key of path) {
    if (!current || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current.trim() ? current.trim() : null;
}

function pickString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function safeIso(raw: string): string | null {
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
