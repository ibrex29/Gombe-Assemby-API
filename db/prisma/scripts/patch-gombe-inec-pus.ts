/**
 * Align live Gombe polling units with INEC delimitations.
 *
 * Run:
 *   pnpm --dir db patch:inec:gombe
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '../../src/generated/client';
import { createPgAdapter } from '../../src/client';
import { GOMBE_INEC_REMOVE_CODES, GOMBE_INEC_UPSERT } from '../gombe-inec-alignment';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

config({ path: resolve(__dirname, '../../.env') });
config({ path: resolve(__dirname, '../../../.env') });

function newId() {
  return `c${Date.now().toString(36)}${randomBytes(9).toString('hex')}`;
}

async function findWard(prisma: PrismaClient, lgaName: string, wardName: string) {
  return prisma.ward.findFirst({
    where: {
      name: { equals: wardName, mode: 'insensitive' },
      lga: {
        name: { equals: lgaName, mode: 'insensitive' },
        state: { code: 'GO' },
      },
    },
    select: { id: true, name: true },
  });
}

async function main() {
  const cs = process.env.DATABASE_URL!.replace(/\?schema=.*/, '');
  const { adapter, pool } = createPgAdapter(cs);
  const prisma = new PrismaClient({ adapter });

  try {
    let removed = 0;
    let upserted = 0;

    for (const code of GOMBE_INEC_REMOVE_CODES) {
      const deleted = await prisma.pollingUnit.deleteMany({ where: { code } });
      removed += deleted.count;
      if (deleted.count) console.log(`  removed ${code}`);
    }

    for (const fix of GOMBE_INEC_UPSERT) {
      const ward = await findWard(prisma, fix.lga, fix.ward);
      if (!ward) {
        throw new Error(`Ward not found: ${fix.lga} / ${fix.ward}`);
      }

      await prisma.pollingUnit.upsert({
        where: { code: fix.code },
        update: { name: fix.name, wardId: ward.id, status: 'ACTIVE' },
        create: {
          id: newId(),
          code: fix.code,
          name: fix.name,
          wardId: ward.id,
          status: 'ACTIVE',
        },
      });
      upserted += 1;
      console.log(`  upserted ${fix.code} → ${fix.lga}/${fix.ward}`);
    }

    const total = await prisma.pollingUnit.count({
      where: { ward: { lga: { state: { code: 'GO' } } } },
    });
    console.log(`Done. Removed ${removed}, upserted ${upserted}. Gombe PUs: ${total}`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
