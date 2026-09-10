import { createHash } from 'node:crypto';

export interface IrevPuRecord {
  _id: string;
  name?: string;
  code?: string;
  pu_code?: string;
  pu_code_string?: string;
  document?: {
    url?: string;
    /** Live CDN mirror when the legacy `url` host is parked. */
    backup_url?: string;
    document_url?: string;
    updated_at?: string;
    status?: number;
  } | null;
}

export function normalizeGeoName(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/['’]/g, '')
    .replace(/\s+/g, ' ');
}

export function inecCodeToDash(code: string): string {
  return code.trim().replace(/\//g, '-');
}

export function inecCodeToSlash(code: string): string {
  return code.trim().replace(/-/g, '/');
}

export function inecCodeCompact(code: string): string {
  return code.replace(/[-/]/g, '').toLowerCase();
}

export function matchIrevPu(puCode: string, irevPu: IrevPuRecord): boolean {
  const compact = inecCodeCompact(puCode);
  if (!compact) return false;

  const candidates = [
    irevPu.pu_code,
    irevPu.pu_code_string,
    irevPu.code,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  return candidates.some((candidate) => inecCodeCompact(candidate) === compact);
}

export function findIrevPuByCode(pus: IrevPuRecord[], puCode: string): IrevPuRecord | null {
  return pus.find((pu) => matchIrevPu(puCode, pu)) ?? null;
}

export function irevDocumentUrl(pu: IrevPuRecord): string | null {
  const doc = pu.document;
  if (!doc) return null;

  const candidates = [doc.document_url, doc.backup_url, doc.url].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!isStaleIrevDocumentUrl(trimmed)) return trimmed;
  }

  return candidates[0]?.trim() ?? null;
}

export function irevDocumentUploadedAt(pu: IrevPuRecord): Date | null {
  const raw = pu.document?.updated_at;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function irevDocumentHash(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  return createHash('sha256').update(trimmed).digest('hex');
}

/** Hosts that no longer serve scans (parked domain / HTML landing pages). */
const STALE_IREV_DOCUMENT_HOSTS = ['docs.inecelectionresults.net'];

export function isStaleIrevDocumentUrl(url: string | null | undefined): boolean {
  const trimmed = url?.trim();
  if (!trimmed) return false;
  try {
    const host = new URL(trimmed).hostname.toLowerCase();
    return STALE_IREV_DOCUMENT_HOSTS.some((stale) => host === stale || host.endsWith(`.${stale}`));
  } catch {
    return false;
  }
}

/** URLs we can realistically OCR today (live CDN scans; not dead legacy PDF hosts). */
export function isOcrEligibleDocumentUrl(url: string | null | undefined): boolean {
  const trimmed = url?.trim();
  if (!trimmed || isStaleIrevDocumentUrl(trimmed)) return false;

  const lower = trimmed.toLowerCase();
  if (lower.includes('incportals.com')) return true;
  if (lower.includes('digitaloceanspaces.com')) return true;

  return /\.(jpe?g|png|webp|pdf)(\?|$)/i.test(lower);
}

export type IrevCatalogRow = {
  pollingUnitId: string;
  irevPuId: string;
  documentUrl: string | null;
  documentHash: string | null;
  uploadedAt: Date | null;
};

export function catalogRowsForWard(
  localPus: Array<{ id: string; code: string }>,
  irevPus: IrevPuRecord[],
): IrevCatalogRow[] {
  const rows: IrevCatalogRow[] = [];
  for (const local of localPus) {
    const irevPu = findIrevPuByCode(irevPus, local.code);
    if (!irevPu) continue;
    const documentUrl = irevDocumentUrl(irevPu);
    rows.push({
      pollingUnitId: local.id,
      irevPuId: irevPu._id,
      documentUrl,
      documentHash: irevDocumentHash(documentUrl),
      uploadedAt: irevDocumentUploadedAt(irevPu),
    });
  }
  return rows;
}
