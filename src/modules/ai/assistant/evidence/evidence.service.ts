import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@electromon/db';
import { CollationLevel, FieldReportType, JwtPayload } from '@electromon/shared';
import { PrismaService } from '../../../../common/prisma/prisma.service';

/** Photos per request. Enough to review a cluster, small enough to render. */
const MAX_PHOTOS = 12;

export type EvidenceKind = 'incident' | 'ec8a';

export interface EvidencePhoto {
  /** Stable index the model cites in prose ("photo 2"). */
  ref: number;
  kind: EvidenceKind;
  url: string;
  caption: string;
  takenAt: string | null;
}

/** What the model is shown — deliberately without URLs. */
export interface EvidenceDigest {
  ref: number;
  kind: EvidenceKind;
  caption: string;
  takenAt: string | null;
}

export interface EvidenceLookup {
  kind: EvidenceKind;
  /** Free-text place filter: state, LGA, ward name, or a polling unit code. */
  place?: string;
  /** Incidents only — restrict to a severity. */
  severity?: string;
  limit?: number;
}

/**
 * Reads photo evidence for the assistant.
 *
 * Photo columns are deliberately outside the SQL allowlist, so this goes through
 * Prisma as the application role instead, with campaign scoping applied
 * explicitly on every query.
 *
 * The model never receives URLs — only captions and a `ref`. The URLs travel
 * separately to the client as structured attachments, so a fabricated link
 * cannot reach the user.
 */
@Injectable()
export class EvidenceService {
  constructor(private prisma: PrismaService) {}

  async findPhotos(user: JwtPayload, lookup: EvidenceLookup): Promise<EvidencePhoto[]> {
    if (!user.campaignId) {
      throw new ForbiddenException('Campaign membership required');
    }
    const limit = Math.min(Math.max(lookup.limit ?? 6, 1), MAX_PHOTOS);

    return lookup.kind === 'ec8a'
      ? this.findEc8aPhotos(user.campaignId, lookup, limit)
      : this.findIncidentPhotos(user.campaignId, lookup, limit);
  }

  /**
   * Resolves a place name to the narrowest geography that matches it exactly.
   *
   * A plain "contains" search is too loose at national scale: "Kano" also matches
   * a polling unit called KANO PLAY GROUND in Benue, so an answer about Kano
   * State quietly includes units from elsewhere. An exact state or LGA name wins;
   * only when nothing matches exactly do we fall back to a fuzzy search.
   */
  private async resolvePlace(
    place: string,
  ): Promise<{ stateId?: string; lgaId?: string } | null> {
    const [state, lga] = await Promise.all([
      this.prisma.state.findFirst({
        where: { name: { equals: place, mode: 'insensitive' } },
        select: { id: true },
      }),
      this.prisma.lGA.findFirst({
        where: { name: { equals: place, mode: 'insensitive' } },
        select: { id: true },
      }),
    ]);
    if (lga) return { lgaId: lga.id };
    if (state) return { stateId: state.id };
    return null;
  }

  private async findIncidentPhotos(
    campaignId: string,
    lookup: EvidenceLookup,
    limit: number,
  ): Promise<EvidencePhoto[]> {
    const where: Prisma.FieldReportWhereInput = {
      campaignId,
      type: { in: [FieldReportType.INCIDENT, FieldReportType.SECURITY_CONCERN] },
      // Prisma cannot filter "array is non-empty" directly; isEmpty:false does it.
      photoUrls: { isEmpty: false },
    };
    if (lookup.severity) {
      where.incidentSeverity = lookup.severity as Prisma.FieldReportWhereInput['incidentSeverity'];
    }

    const place = lookup.place?.trim();
    if (place) {
      const exact = await this.resolvePlace(place);
      if (exact?.lgaId) {
        where.OR = [
          { ward: { lgaId: exact.lgaId } },
          { pollingUnit: { ward: { lgaId: exact.lgaId } } },
        ];
        return this.runIncidentQuery(where, limit);
      }
      if (exact?.stateId) {
        where.OR = [
          { ward: { lga: { stateId: exact.stateId } } },
          { pollingUnit: { ward: { lga: { stateId: exact.stateId } } } },
        ];
        return this.runIncidentQuery(where, limit);
      }

      const like = { contains: place, mode: 'insensitive' as const };
      where.OR = [
        { ward: { name: like } },
        { ward: { lga: { name: like } } },
        { ward: { lga: { state: { name: like } } } },
        { pollingUnit: { name: like } },
        { pollingUnit: { code: { contains: place, mode: 'insensitive' } } },
        { pollingUnit: { ward: { name: like } } },
        { pollingUnit: { ward: { lga: { name: like } } } },
        { pollingUnit: { ward: { lga: { state: { name: like } } } } },
      ];
    }

    return this.runIncidentQuery(where, limit);
  }

  private async runIncidentQuery(
    where: Prisma.FieldReportWhereInput,
    limit: number,
  ): Promise<EvidencePhoto[]> {
    const reports = await this.prisma.fieldReport.findMany({
      where,
      orderBy: [{ isUrgent: 'desc' }, { createdAt: 'desc' }],
      take: limit,
      select: {
        title: true,
        incidentType: true,
        incidentSeverity: true,
        createdAt: true,
        photoUrls: true,
        ward: { select: { name: true, lga: { select: { name: true } } } },
        pollingUnit: {
          select: {
            code: true,
            name: true,
            ward: { select: { name: true, lga: { select: { name: true } } } },
          },
        },
      },
    });

    const photos: EvidencePhoto[] = [];
    for (const report of reports) {
      const lga = report.ward?.lga?.name ?? report.pollingUnit?.ward?.lga?.name;
      const ward = report.ward?.name ?? report.pollingUnit?.ward?.name;
      const unit = report.pollingUnit ? `${report.pollingUnit.code} ${report.pollingUnit.name}` : null;
      const where = [unit, ward && `${ward} ward`, lga && `${lga} LGA`].filter(Boolean).join(', ');

      const label = [
        report.incidentSeverity,
        report.incidentType?.replace(/_/g, ' ').toLowerCase(),
      ]
        .filter(Boolean)
        .join(' · ');

      for (const url of report.photoUrls) {
        if (photos.length >= limit) break;
        photos.push({
          ref: photos.length + 1,
          kind: 'incident',
          url,
          caption: [report.title, label, where].filter(Boolean).join(' — '),
          takenAt: report.createdAt.toISOString(),
        });
      }
      if (photos.length >= limit) break;
    }
    return photos;
  }

  private async findEc8aPhotos(
    campaignId: string,
    lookup: EvidenceLookup,
    limit: number,
  ): Promise<EvidencePhoto[]> {
    const where: Prisma.CollationResultWhereInput = {
      campaignId,
      level: CollationLevel.POLLING_UNIT,
      ec8aPhotoUrls: { isEmpty: false },
    };

    // scopeId is an untyped string with no relation, so a place filter has to be
    // resolved to polling-unit ids first.
    const place = lookup.place?.trim();
    if (place) {
      const like = { contains: place, mode: 'insensitive' as const };
      const exact = await this.resolvePlace(place);
      const unitWhere: Prisma.PollingUnitWhereInput = exact?.lgaId
        ? { ward: { lgaId: exact.lgaId } }
        : exact?.stateId
          ? { ward: { lga: { stateId: exact.stateId } } }
          : {
              OR: [
                { name: like },
                { code: { contains: place, mode: 'insensitive' } },
                { ward: { name: like } },
                { ward: { lga: { name: like } } },
                { ward: { lga: { state: { name: like } } } },
              ],
            };

      const units = await this.prisma.pollingUnit.findMany({
        where: unitWhere,
        select: { id: true },
        take: 500,
      });
      where.scopeId = { in: units.map((unit) => unit.id) };
    }

    const results = await this.prisma.collationResult.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: {
        scopeId: true,
        status: true,
        submittedAt: true,
        updatedAt: true,
        ec8aPhotoUrls: true,
      },
    });

    const units = await this.prisma.pollingUnit.findMany({
      where: { id: { in: results.map((result) => result.scopeId) } },
      select: {
        id: true,
        code: true,
        name: true,
        ward: { select: { name: true, lga: { select: { name: true } } } },
      },
    });
    const unitById = new Map(units.map((unit) => [unit.id, unit]));

    const photos: EvidencePhoto[] = [];
    for (const result of results) {
      const unit = unitById.get(result.scopeId);
      const where = unit
        ? `${unit.code} ${unit.name}, ${unit.ward.name} ward, ${unit.ward.lga.name} LGA`
        : result.scopeId;

      for (const url of result.ec8aPhotoUrls) {
        if (photos.length >= limit) break;
        photos.push({
          ref: photos.length + 1,
          kind: 'ec8a',
          url,
          caption: `EC8A — ${where} (${result.status})`,
          takenAt: (result.submittedAt ?? result.updatedAt).toISOString(),
        });
      }
      if (photos.length >= limit) break;
    }
    return photos;
  }
}

/** Strips URLs before the model sees the result. */
export function toEvidenceDigest(photos: EvidencePhoto[]): EvidenceDigest[] {
  return photos.map(({ ref, kind, caption, takenAt }) => ({ ref, kind, caption, takenAt }));
}
