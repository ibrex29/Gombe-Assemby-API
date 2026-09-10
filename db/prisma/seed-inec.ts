import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PrismaClient } from '../src/generated/client';

/** Map INEC portal LGA names to our seed/database names. */
const INEC_LGA_NAME_MAP: Record<string, string> = {
  BIRNIWA: 'Biriniwa',
  'KIRIKA SAMMA': 'Kiri Kasama',
  'SULE-TANKARKAR': 'Sule Tankarkar',
};

export function normalizeInecLgaName(name: string): string {
  const mapped = INEC_LGA_NAME_MAP[name.toUpperCase()];
  if (mapped) return mapped;

  return name
    .split(/[\s-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

export interface InecPollingUnit {
  code: string;
  name: string;
  remark: string;
}

export interface InecWard {
  name: string;
  inecCode: string;
  registrationAreaCode: string;
  pollingUnits: InecPollingUnit[];
}

export interface InecLgaSeedFile {
  lga: { name: string; inecCode: string; delimiterPrefix: string };
  wards: InecWard[];
  summary?: { wardCount: number; pollingUnitCount: number };
}

export interface InecSeedResult {
  wardsByName: Record<string, { id: string; name: string; registrationAreaCode: string }>;
  pollingUnitsByCode: Record<string, { id: string; code: string; name: string; wardId: string }>;
}

export function loadInecLgaFile(filePath: string): InecLgaSeedFile {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as InecLgaSeedFile;
}

export async function cleanupPlaceholderGeoForLga(prisma: PrismaClient, lgaId: string): Promise<void> {
  await prisma.pollingUnit.deleteMany({
    where: {
      ward: { lgaId },
      OR: [{ code: { startsWith: 'JI-' } }, { code: { contains: '-RA-' } }],
    },
  });

  await prisma.ward.deleteMany({
    where: {
      lgaId,
      OR: [
        { registrationAreaCode: { startsWith: 'JI-' } },
        { name: { contains: ' Ward ' } },
      ],
    },
  });
}

export async function seedInecLgaFromFile(
  prisma: PrismaClient,
  lgaId: string,
  filePath: string,
  options: { cleanupPlaceholders?: boolean } = {},
): Promise<InecSeedResult> {
  if (options.cleanupPlaceholders) {
    await cleanupPlaceholderGeoForLga(prisma, lgaId);
  }

  const data = loadInecLgaFile(filePath);
  const wardsByName: InecSeedResult['wardsByName'] = {};
  const pollingUnitsByCode: InecSeedResult['pollingUnitsByCode'] = {};

  console.log(
    `  INEC seed: ${data.lga.name} — ${data.wards.length} wards, ${data.summary?.pollingUnitCount ?? '?'} PUs`,
  );

  for (const ward of data.wards) {
    const wardRecord = await prisma.ward.upsert({
      where: { name_lgaId: { name: ward.name, lgaId } },
      update: { registrationAreaCode: ward.registrationAreaCode },
      create: {
        name: ward.name,
        registrationAreaCode: ward.registrationAreaCode,
        lgaId,
      },
    });

    wardsByName[ward.name] = {
      id: wardRecord.id,
      name: wardRecord.name,
      registrationAreaCode: ward.registrationAreaCode,
    };

    for (const pu of ward.pollingUnits) {
      const puRecord = await prisma.pollingUnit.upsert({
        where: { code: pu.code },
        update: {
          name: pu.name,
          wardId: wardRecord.id,
          notes: pu.remark,
          status: 'ACTIVE',
        },
        create: {
          code: pu.code,
          name: pu.name,
          wardId: wardRecord.id,
          notes: pu.remark,
          status: 'ACTIVE',
        },
      });

      pollingUnitsByCode[pu.code] = {
        id: puRecord.id,
        code: puRecord.code,
        name: puRecord.name,
        wardId: wardRecord.id,
      };
    }
  }

  return { wardsByName, pollingUnitsByCode };
}

export async function seedJigawaInecFromDirectory(
  prisma: PrismaClient,
  seedDataDir: string,
  lgasByName: Record<string, { id: string; name: string }>,
): Promise<Record<string, InecSeedResult>> {
  const files = readdirSync(seedDataDir)
    .filter((file) => file.startsWith('jigawa-') && file.endsWith('-inec.json'))
    .sort();

  const results: Record<string, InecSeedResult> = {};
  let totalWards = 0;
  let totalPus = 0;

  console.log(`Seeding ${files.length} Jigawa LGAs from INEC data...`);

  for (const file of files) {
    const filePath = resolve(seedDataDir, file);
    const data = loadInecLgaFile(filePath);
    const lgaName = normalizeInecLgaName(data.lga.name);
    const lga = lgasByName[lgaName];

    if (!lga) {
      throw new Error(`No database LGA found for INEC LGA "${data.lga.name}" (${lgaName})`);
    }

    results[lgaName] = await seedInecLgaFromFile(prisma, lga.id, filePath, {
      cleanupPlaceholders: true,
    });

    totalWards += data.summary?.wardCount ?? data.wards.length;
    totalPus += data.summary?.pollingUnitCount ?? 0;
  }

  console.log(`  Jigawa INEC total: ${files.length} LGAs, ${totalWards} wards, ${totalPus} PUs`);
  return results;
}
