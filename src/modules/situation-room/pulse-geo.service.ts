import { Injectable, Logger } from '@nestjs/common';
import {
  ElectionDayPhase,
  RivalMobilization,
  WhoLooksAhead,
  hasOpened,
  isPulseSilent,
} from '@electromon/shared';
import { Prisma } from '@electromon/db';
import { PrismaService } from '../../common/prisma/prisma.service';

export type PulseMapFields = {
  phase: ElectionDayPhase | null;
  silent: boolean;
  silentCount: number;
  pulseTotal: number;
  rivalHeavyCount: number;
  rivalMobilization: RivalMobilization | null;
  whoLooksAhead: WhoLooksAhead | null;
  hasObserved: boolean;
};

const pulseSelect = {
  pollingUnitId: true,
  phase: true,
  lastPulseAt: true,
  rivalMobilization: true,
  whoLooksAhead: true,
  observedPartyResults: true,
  pollingUnit: { select: { wardId: true, ward: { select: { lgaId: true, lga: { select: { stateId: true } } } } } },
} as const;

function maxMobilization(values: Array<RivalMobilization | null | undefined>): RivalMobilization | null {
  if (values.includes(RivalMobilization.HEAVY)) return RivalMobilization.HEAVY;
  if (values.includes(RivalMobilization.LIGHT)) return RivalMobilization.LIGHT;
  if (values.includes(RivalMobilization.NONE)) return RivalMobilization.NONE;
  return null;
}

function majorityAhead(values: Array<WhoLooksAhead | null | undefined>): WhoLooksAhead | null {
  const counts = { US: 0, RIVAL: 0, UNCLEAR: 0 };
  for (const value of values) {
    if (value) counts[value] += 1;
  }
  if (counts.US === 0 && counts.RIVAL === 0 && counts.UNCLEAR === 0) return null;
  if (counts.US > counts.RIVAL && counts.US >= counts.UNCLEAR) return WhoLooksAhead.US;
  if (counts.RIVAL > counts.US && counts.RIVAL >= counts.UNCLEAR) return WhoLooksAhead.RIVAL;
  return WhoLooksAhead.UNCLEAR;
}

function dominantPhase(values: Array<ElectionDayPhase | null | undefined>): ElectionDayPhase | null {
  const counts = new Map<ElectionDayPhase, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: ElectionDayPhase | null = null;
  let bestCount = 0;
  for (const [phase, count] of counts) {
    if (count > bestCount) {
      best = phase;
      bestCount = count;
    }
  }
  return best;
}

function isMissingPulseRelation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { code?: string; message?: string };
  const message = err.message ?? '';
  return (
    err.code === 'P2021' ||
    err.code === 'P2010' ||
    message.includes('polling_unit_pulses')
  );
}

@Injectable()
export class PulseGeoService {
  private readonly logger = new Logger(PulseGeoService.name);

  constructor(private prisma: PrismaService) {}

  private async withPulseTable<T>(fallback: T, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (isMissingPulseRelation(error)) {
        this.logger.warn(
          'Pulse tables are missing. Situation map will omit process/rival fields until `pnpm db:migrate:deploy` is applied.',
        );
        return fallback;
      }
      throw error;
    }
  }

  async fieldsByPollingUnit(
    campaignId: string,
    pollingUnitIds: string[],
    now = new Date(),
  ): Promise<Map<string, PulseMapFields>> {
    const map = new Map<string, PulseMapFields>();
    if (!pollingUnitIds.length) return map;
    return this.withPulseTable(map, async () => {
      const pulses = await this.prisma.pollingUnitPulse.findMany({
        where: { campaignId, pollingUnitId: { in: pollingUnitIds } },
        select: pulseSelect,
      });
      const byId = new Map(pulses.map((row) => [row.pollingUnitId, row]));
      for (const id of pollingUnitIds) {
        const row = byId.get(id);
        const silent = isPulseSilent({ phase: row?.phase, lastPulseAt: row?.lastPulseAt, now });
        map.set(id, {
          phase: (row?.phase as ElectionDayPhase | undefined) ?? null,
          silent,
          silentCount: silent ? 1 : 0,
          pulseTotal: 1,
          rivalHeavyCount: row?.rivalMobilization === RivalMobilization.HEAVY ? 1 : 0,
          rivalMobilization: (row?.rivalMobilization as RivalMobilization | null) ?? null,
          whoLooksAhead: (row?.whoLooksAhead as WhoLooksAhead | null) ?? null,
          hasObserved: row?.observedPartyResults != null,
        });
      }
      return map;
    });
  }

  async fieldsByWard(
    campaignId: string,
    wardIds: string[],
    now = new Date(),
  ): Promise<Map<string, PulseMapFields>> {
    const map = new Map<string, PulseMapFields>();
    if (!wardIds.length) return map;
    const pus = await this.prisma.pollingUnit.findMany({
      where: { wardId: { in: wardIds } },
      select: { id: true, wardId: true },
    });
    const puFields = await this.fieldsByPollingUnit(
      campaignId,
      pus.map((pu) => pu.id),
      now,
    );
    const grouped = new Map<string, PulseMapFields[]>();
    for (const pu of pus) {
      const list = grouped.get(pu.wardId) ?? [];
      list.push(puFields.get(pu.id) ?? emptyFields());
      grouped.set(pu.wardId, list);
    }
    for (const wardId of wardIds) {
      map.set(wardId, rollupFields(grouped.get(wardId) ?? []));
    }
    return map;
  }

  async fieldsByLga(
    campaignId: string,
    lgaIds: string[],
    now = new Date(),
  ): Promise<Map<string, PulseMapFields>> {
    const map = new Map<string, PulseMapFields>();
    if (!lgaIds.length) return map;
    return this.withPulseTable(map, async () => {
      const rows = await this.aggregateSql(campaignId, 'lga', lgaIds, now);
      for (const row of rows) map.set(row.id, this.fromSql(row));
      for (const id of lgaIds) {
        if (!map.has(id)) map.set(id, emptyFields());
      }
      return map;
    });
  }

  async fieldsByState(
    campaignId: string,
    stateIds: string[],
    now = new Date(),
  ): Promise<Map<string, PulseMapFields>> {
    const map = new Map<string, PulseMapFields>();
    if (!stateIds.length) return map;
    return this.withPulseTable(map, async () => {
      const rows = await this.aggregateSql(campaignId, 'state', stateIds, now);
      for (const row of rows) map.set(row.id, this.fromSql(row));
      for (const id of stateIds) {
        if (!map.has(id)) map.set(id, emptyFields());
      }
      return map;
    });
  }

  private fromSql(row: SqlPulseRow): PulseMapFields {
    const who =
      row.aheadUs > row.aheadRival && row.aheadUs >= row.aheadUnclear
        ? WhoLooksAhead.US
        : row.aheadRival > row.aheadUs && row.aheadRival >= row.aheadUnclear
          ? WhoLooksAhead.RIVAL
          : row.aheadUs + row.aheadRival + row.aheadUnclear > 0
            ? WhoLooksAhead.UNCLEAR
            : null;
    const total = row.totalPus ?? 0;
    return {
      phase: (row.phase as ElectionDayPhase | null) ?? null,
      silent: total > 0 && row.silent >= total,
      silentCount: row.silent,
      pulseTotal: total,
      rivalHeavyCount: row.rivalHeavy,
      rivalMobilization:
        row.rivalHeavy > 0
          ? RivalMobilization.HEAVY
          : row.rivalLight > 0
            ? RivalMobilization.LIGHT
            : null,
      whoLooksAhead: who,
      hasObserved: row.observed > 0,
    };
  }

  private async aggregateSql(
    campaignId: string,
    grain: 'lga' | 'state',
    ids: string[],
    now: Date,
  ): Promise<SqlPulseRow[]> {
    const cutoff = new Date(now.getTime() - 45 * 60 * 1000);
    if (grain === 'state') {
      return this.prisma.$queryRaw<SqlPulseRow[]>`
        SELECT l."stateId" AS id,
          COUNT(p.id)::int AS "totalPus",
          COUNT(*) FILTER (
            WHERE pulse.id IS NULL
               OR (pulse.phase <> 'CLOSED'::"ElectionDayPhase" AND pulse."lastPulseAt" < ${cutoff})
          )::int AS silent,
          COUNT(*) FILTER (WHERE pulse."rivalMobilization" = 'HEAVY'::"RivalMobilization")::int AS "rivalHeavy",
          COUNT(*) FILTER (WHERE pulse."rivalMobilization" = 'LIGHT'::"RivalMobilization")::int AS "rivalLight",
          COUNT(*) FILTER (WHERE pulse."observedPartyResults" IS NOT NULL)::int AS observed,
          COUNT(*) FILTER (WHERE pulse."whoLooksAhead" = 'US'::"WhoLooksAhead")::int AS "aheadUs",
          COUNT(*) FILTER (WHERE pulse."whoLooksAhead" = 'RIVAL'::"WhoLooksAhead")::int AS "aheadRival",
          COUNT(*) FILTER (WHERE pulse."whoLooksAhead" = 'UNCLEAR'::"WhoLooksAhead")::int AS "aheadUnclear",
          MODE() WITHIN GROUP (ORDER BY pulse.phase) AS phase
        FROM polling_units p
        INNER JOIN wards w ON w.id = p."wardId"
        INNER JOIN lgas l ON l.id = w."lgaId"
        LEFT JOIN polling_unit_pulses pulse
          ON pulse."pollingUnitId" = p.id AND pulse."campaignId" = ${campaignId}
        WHERE l."stateId" IN (${Prisma.join(ids)})
        GROUP BY l."stateId"
      `;
    }
    return this.prisma.$queryRaw<SqlPulseRow[]>`
      SELECT l.id AS id,
        COUNT(p.id)::int AS "totalPus",
        COUNT(*) FILTER (
          WHERE pulse.id IS NULL
             OR (pulse.phase <> 'CLOSED'::"ElectionDayPhase" AND pulse."lastPulseAt" < ${cutoff})
        )::int AS silent,
        COUNT(*) FILTER (WHERE pulse."rivalMobilization" = 'HEAVY'::"RivalMobilization")::int AS "rivalHeavy",
        COUNT(*) FILTER (WHERE pulse."rivalMobilization" = 'LIGHT'::"RivalMobilization")::int AS "rivalLight",
        COUNT(*) FILTER (WHERE pulse."observedPartyResults" IS NOT NULL)::int AS observed,
        COUNT(*) FILTER (WHERE pulse."whoLooksAhead" = 'US'::"WhoLooksAhead")::int AS "aheadUs",
        COUNT(*) FILTER (WHERE pulse."whoLooksAhead" = 'RIVAL'::"WhoLooksAhead")::int AS "aheadRival",
        COUNT(*) FILTER (WHERE pulse."whoLooksAhead" = 'UNCLEAR'::"WhoLooksAhead")::int AS "aheadUnclear",
        MODE() WITHIN GROUP (ORDER BY pulse.phase) AS phase
      FROM polling_units p
      INNER JOIN wards w ON w.id = p."wardId"
      INNER JOIN lgas l ON l.id = w."lgaId"
      LEFT JOIN polling_unit_pulses pulse
        ON pulse."pollingUnitId" = p.id AND pulse."campaignId" = ${campaignId}
      WHERE l.id IN (${Prisma.join(ids)})
      GROUP BY l.id
    `;
  }
}

type SqlPulseRow = {
  id: string;
  totalPus: number;
  silent: number;
  rivalHeavy: number;
  rivalLight: number;
  observed: number;
  aheadUs: number;
  aheadRival: number;
  aheadUnclear: number;
  phase: string | null;
};

function emptyFields(): PulseMapFields {
  return {
    phase: null,
    silent: true,
    silentCount: 0,
    pulseTotal: 0,
    rivalHeavyCount: 0,
    rivalMobilization: null,
    whoLooksAhead: null,
    hasObserved: false,
  };
}

function rollupFields(rows: PulseMapFields[]): PulseMapFields {
  if (!rows.length) return emptyFields();
  const pulseTotal = rows.reduce((sum, row) => sum + (row.pulseTotal || 1), 0);
  const silentCount = rows.reduce((sum, row) => sum + row.silentCount, 0);
  const rivalHeavyCount = rows.reduce((sum, row) => sum + (row.rivalHeavyCount ?? 0), 0);
  return {
    phase: dominantPhase(rows.map((row) => row.phase)),
    silent: pulseTotal > 0 && silentCount >= pulseTotal,
    silentCount,
    pulseTotal,
    rivalHeavyCount,
    rivalMobilization: maxMobilization(rows.map((row) => row.rivalMobilization)),
    whoLooksAhead: majorityAhead(rows.map((row) => row.whoLooksAhead)),
    hasObserved: rows.some((row) => row.hasObserved),
  };
}

export function attachPulseFields<T extends { id: string }>(
  rows: T[],
  fields: Map<string, PulseMapFields>,
): Array<T & PulseMapFields> {
  return rows.map((row) => {
    const pulse = fields.get(row.id) ?? emptyFields();
    return { ...row, ...pulse };
  });
}

export { hasOpened };
