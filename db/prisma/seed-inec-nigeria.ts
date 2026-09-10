import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '../src/generated/client';
import {
  NIGERIA_STATES,
  NIGERIA_STATE_CENTROIDS,
  type NigeriaStateMeta,
} from './nigeria-states';
import { normalizeInecLgaName, type InecSeedResult } from './seed-inec';
import { applyGombeInecAlignment } from './gombe-inec-alignment';

const JAYCODIST_BASE =
  'https://raw.githubusercontent.com/JayCodist/inec-polling-units-scraper/main/results';

interface JayCodistPu {
  delimitation?: string;
  name: string;
  remark?: string;
  ward: string;
  units: string;
}

interface JayCodistWard {
  name: string;
  abbreviation?: string;
  pollingUnits: JayCodistPu[];
}

interface JayCodistLga {
  name: string;
  abbreviation: string;
  wards: JayCodistWard[];
}

interface JayCodistStateFile {
  state: { code: string; name: string; lgas: JayCodistLga[] };
}

function delimitationToCode(delimitation: string): string {
  return delimitation.replace(/\//g, '-');
}

function puLimitPerWard(): number | null {
  if (process.env.SEED_FULL_INEC === 'true') return null;
  const raw = process.env.SEED_PU_LIMIT_PER_WARD ?? '4';
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

function detailStateCodes(): Set<string> | null {
  if (process.env.SEED_FULL_INEC === 'true') return null;
  const raw = process.env.SEED_DETAIL_STATES ?? 'FC,LA,KN';
  return new Set(
    raw
      .split(',')
      .map((code) => code.trim().toUpperCase())
      .filter(Boolean),
  );
}

function newId() {
  return `c${Date.now().toString(36)}${randomBytes(9).toString('hex')}`;
}

function hash32(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function offsetPoint(
  lng: number,
  lat: number,
  key: string,
  spread: number,
): { longitude: number; latitude: number } {
  const a = hash32(key);
  const b = hash32(`${key}:b`);
  return {
    longitude: lng + ((a % 10_000) / 10_000 - 0.5) * spread,
    latitude: lat + ((b % 10_000) / 10_000 - 0.5) * spread * 0.75,
  };
}

async function loadStateFile(meta: NigeriaStateMeta, cacheDir: string): Promise<JayCodistStateFile> {
  const cachePath = resolve(cacheDir, `${meta.slug}.json`);
  if (existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, 'utf-8')) as JayCodistStateFile;
  }

  const url = `${JAYCODIST_BASE}/${meta.slug}.json`;
  console.log(`  fetching ${meta.name} INEC file…`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  const payload = (await response.json()) as JayCodistStateFile;
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(payload));
  return payload;
}

async function flushCreateMany<T extends Record<string, unknown>>(
  rows: T[],
  insert: (batch: T[]) => Promise<unknown>,
  batchSize = 1500,
) {
  for (let i = 0; i < rows.length; i += batchSize) {
    await insert(rows.slice(i, i + batchSize));
  }
}

export interface NigeriaInecSeed {
  states: Record<string, { id: string; name: string; code: string; zone: string }>;
  sample: {
    stateId: string;
    lgaId: string;
    lgaName: string;
    wardId: string;
    wardName: string;
    puId: string;
    puCode: string;
    pu2Id?: string;
  };
}

export async function seedNigeriaInecFromJayCodist(
  prisma: PrismaClient,
  cacheDir: string,
): Promise<NigeriaInecSeed> {
  const limit = puLimitPerWard();
  const detailCodes = detailStateCodes();
  console.log(
    detailCodes
      ? `Seeding Nigeria INEC geography — all states/LGAs; wards/PUs for ${[...detailCodes].join(', ')} (SEED_FULL_INEC=true for every PU)…`
      : 'Seeding Nigeria INEC geography (full polling-unit register from INEC via JayCodist)…',
  );

  const states: NigeriaInecSeed['states'] = {};
  let sample: NigeriaInecSeed['sample'] | null = null;
  let totalLgas = 0;
  let totalWards = 0;
  let totalPus = 0;

  for (const meta of NIGERIA_STATES) {
    const centroid = NIGERIA_STATE_CENTROIDS[meta.code] ?? [8, 9.5];
    const state = await prisma.state.upsert({
      where: { code: meta.code },
      update: { name: meta.name, zone: meta.zone },
      create: { name: meta.name, code: meta.code, zone: meta.zone },
    });
    states[meta.code] = {
      id: state.id,
      name: state.name,
      code: state.code,
      zone: meta.zone,
    };

    const districtRecords = [];
    for (const name of meta.districts) {
      const district = await prisma.senatorialDistrict.upsert({
        where: { name_stateId: { name, stateId: state.id } },
        update: {},
        create: { name, stateId: state.id },
      });
      districtRecords.push(district);
    }

    const payload = await loadStateFile(meta, cacheDir);
  const alignedPayload = meta.code === 'GO' ? applyGombeInecAlignment(payload) : payload;
  const lgas = alignedPayload.state?.lgas ?? [];
    const seedUnits = !detailCodes || detailCodes.has(meta.code);
    console.log(
      `  ${meta.name}: ${lgas.length} LGAs${seedUnits ? (limit ? ` (up to ${limit} PUs/ward)` : ' (full PUs)') : ' (LGAs only)'}`,
    );

    const wardRows: Array<{
      id: string;
      name: string;
      registrationAreaCode: string;
      lgaId: string;
      latitude: number;
      longitude: number;
      createdAt: Date;
      updatedAt: Date;
    }> = [];
    const puRows: Array<{
      id: string;
      code: string;
      name: string;
      wardId: string;
      latitude: number;
      longitude: number;
      notes: string | null;
      status: 'ACTIVE';
      createdAt: Date;
      updatedAt: Date;
    }> = [];
    const now = new Date();

    for (const [lgaIndex, rawLga] of lgas.entries()) {
      const lgaName = normalizeInecLgaName(rawLga.name);
      const district = districtRecords[lgaIndex % districtRecords.length];
      const lga = await prisma.lGA.upsert({
        where: { name_stateId: { name: lgaName, stateId: state.id } },
        update: { senatorialDistrictId: district?.id },
        create: {
          name: lgaName,
          stateId: state.id,
          senatorialDistrictId: district?.id,
        },
      });
      totalLgas += 1;
      if (!seedUnits) continue;

      const lgaPoint = offsetPoint(centroid[0], centroid[1], `${meta.code}:${lgaName}`, 1.35);

      for (const [wardIndex, rawWard] of (rawLga.wards ?? []).entries()) {
        const wardName = (rawWard.name || 'UNNAMED').trim();
        const firstPu = rawWard.pollingUnits?.[0];
        const wardCode = firstPu?.ward ?? rawWard.abbreviation ?? '01';
        const registrationAreaCode = `${meta.inecCode}-${rawLga.abbreviation}-${wardCode}`;
        const wardPoint = offsetPoint(
          lgaPoint.longitude,
          lgaPoint.latitude,
          `${lga.id}:${wardName}`,
          0.18,
        );
        const wardId = newId();
        wardRows.push({
          id: wardId,
          name: wardName,
          registrationAreaCode,
          lgaId: lga.id,
          latitude: wardPoint.latitude,
          longitude: wardPoint.longitude,
          createdAt: now,
          updatedAt: now,
        });

        const pus = (rawWard.pollingUnits ?? []).filter(
          (pu) => pu.name && (pu.delimitation || pu.units),
        );
        const selected = limit ? pus.slice(0, limit) : pus;

        for (const [puIndex, pu] of selected.entries()) {
          const code = pu.delimitation
            ? delimitationToCode(pu.delimitation)
            : `${meta.inecCode}-${rawLga.abbreviation}-${pu.ward}-${pu.units}`;
          const puPoint = offsetPoint(
            wardPoint.longitude,
            wardPoint.latitude,
            code,
            0.045,
          );
          puRows.push({
            id: newId(),
            code,
            name: pu.name,
            wardId,
            latitude: puPoint.latitude,
            longitude: puPoint.longitude,
            notes: pu.remark ?? null,
            status: 'ACTIVE',
            createdAt: now,
            updatedAt: now,
          });

          if (
            !sample &&
            meta.code === 'FC' &&
            wardIndex === 0 &&
            puIndex === 0 &&
            /abaji|municipal|amac|abuja/i.test(lgaName)
          ) {
            sample = {
              stateId: state.id,
              lgaId: lga.id,
              lgaName,
              wardId,
              wardName,
              puId: puRows[puRows.length - 1].id,
              puCode: code,
            };
          }
        }
      }
    }

    if (wardRows.length) {
      await flushCreateMany(wardRows, (batch) =>
        prisma.ward.createMany({ data: batch, skipDuplicates: true }),
      );
      const existingWards = await prisma.ward.findMany({
        where: { lga: { stateId: state.id } },
        select: { id: true, name: true, lgaId: true },
      });
      const wardIdByKey = new Map(existingWards.map((w) => [`${w.lgaId}:${w.name}`, w.id]));
      const plannedById = new Map(wardRows.map((ward) => [ward.id, ward]));
      const resolvedPus = puRows.map((pu) => {
        const planned = plannedById.get(pu.wardId);
        const realId = planned
          ? wardIdByKey.get(`${planned.lgaId}:${planned.name}`) ?? pu.wardId
          : pu.wardId;
        return { ...pu, wardId: realId };
      });
      await flushCreateMany(resolvedPus, (batch) =>
        prisma.pollingUnit.createMany({ data: batch, skipDuplicates: true }),
      );
      totalWards += wardRows.length;
      totalPus += resolvedPus.length;

      if (sample && meta.code === 'FC') {
        const live = await prisma.pollingUnit.findUnique({ where: { code: sample.puCode } });
        if (live) {
          sample.puId = live.id;
          sample.wardId = live.wardId;
        }
      }
    }
  }

  const missingCoords = await prisma.pollingUnit.findMany({
    where: { OR: [{ latitude: null }, { longitude: null }] },
    select: {
      id: true,
      code: true,
      ward: {
        select: {
          id: true,
          name: true,
          lga: { select: { name: true, state: { select: { code: true } } } },
        },
      },
    },
  });
  if (missingCoords.length) {
    console.log(`  backfilling coordinates for ${missingCoords.length} existing PUs…`);
    for (const pu of missingCoords) {
      const code = pu.ward.lga.state.code;
      const centroid = NIGERIA_STATE_CENTROIDS[code] ?? [8, 9.5];
      const lgaPoint = offsetPoint(centroid[0], centroid[1], `${code}:${pu.ward.lga.name}`, 1.35);
      const wardPoint = offsetPoint(
        lgaPoint.longitude,
        lgaPoint.latitude,
        `${pu.ward.id}:${pu.ward.name}`,
        0.18,
      );
      const puPoint = offsetPoint(wardPoint.longitude, wardPoint.latitude, pu.code, 0.045);
      await prisma.pollingUnit.update({
        where: { id: pu.id },
        data: { latitude: puPoint.latitude, longitude: puPoint.longitude },
      });
      await prisma.ward.update({
        where: { id: pu.ward.id },
        data: { latitude: wardPoint.latitude, longitude: wardPoint.longitude },
      });
    }
  }

  if (!sample) {
    const preferred =
      process.env.SEED_DETAIL_STATES?.split(',')[0]?.trim().toUpperCase() || 'FC';
    const codes = [preferred, 'FC', 'GO', 'LA'].filter(
      (code, index, all) => code && all.indexOf(code) === index,
    );
    let fallback: Awaited<ReturnType<typeof prisma.pollingUnit.findFirst>> = null;
    for (const code of codes) {
      fallback = await prisma.pollingUnit.findFirst({
        where: { ward: { lga: { state: { code } } } },
        include: { ward: { include: { lga: true } } },
        orderBy: { code: 'asc' },
      });
      if (fallback) break;
    }
    if (!fallback) {
      throw new Error('National INEC seed did not produce a sample polling unit');
    }
    sample = {
      stateId: fallback.ward.lga.stateId,
      lgaId: fallback.ward.lgaId,
      lgaName: fallback.ward.lga.name,
      wardId: fallback.wardId,
      wardName: fallback.ward.name,
      puId: fallback.id,
      puCode: fallback.code,
    };
  }

  const [wardCount, puCount] = await Promise.all([
    prisma.ward.count(),
    prisma.pollingUnit.count(),
  ]);
  console.log(
    `  Nigeria INEC total: ${NIGERIA_STATES.length} states, ${totalLgas} LGAs processed, ${wardCount} wards, ${puCount} PUs in database`,
  );
  void totalWards;
  void totalPus;

  return { states, sample };
}

/** Lightweight typed re-export for callers that still want InecSeedResult-shaped maps. */
export type { InecSeedResult };
