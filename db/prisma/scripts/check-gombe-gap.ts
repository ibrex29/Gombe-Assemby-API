import { config } from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '../../src/generated/client';
import { createPgAdapter } from '../../src/client';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
config({ path: resolve(__dirname, '../../.env') });
config({ path: resolve(__dirname, '../../../.env') });

async function main() {
  const cs = process.env.DATABASE_URL!.replace(/\?schema=.*/, '');
  const { adapter, pool } = createPgAdapter(cs);
  const prisma = new PrismaClient({ adapter });

  const goFilter = { pollingUnit: { ward: { lga: { state: { code: 'GO' } } } } };
  const statuses = ['FETCHED', 'OCR_READY', 'OCR_FAILED'] as const;

  const total = await prisma.pollingUnit.count({ where: { ward: { lga: { state: { code: 'GO' } } } } });
  const published = await prisma.irevPuSnapshot.count({
    where: { ...goFilter, status: { in: [...statuses] }, documentUrl: { not: null } },
  });

  const fixedCodes = [
    '15-04-10-025', '15-07-03-032', '15-10-10-012', '15-10-10-013', '15-10-10-014',
    '15-10-10-015', '15-10-10-016', '15-10-10-017',
  ];

  const fixed = await prisma.pollingUnit.findMany({
    where: { code: { in: fixedCodes } },
    select: { code: true, irevSnapshots: { select: { status: true, documentUrl: true } } },
  });

  console.log(JSON.stringify({ total, published, fixed }, null, 2));

  await prisma.$disconnect();
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
