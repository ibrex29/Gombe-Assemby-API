import { createPgAdapter, PrismaClient } from '@electromon/db';
import {
  formatShaValidateReport,
  GOMBE_STATE_CODE,
  validateGombeShaRoster,
} from '../gombe-sha-constituencies';

async function loadRegisterWards() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return [];
  const { adapter, pool } = createPgAdapter(connectionString);
  const prisma = new PrismaClient({ adapter });
  try {
    const wards = await prisma.ward.findMany({
      where: { lga: { state: { code: GOMBE_STATE_CODE } } },
      select: { name: true, lga: { select: { name: true } } },
    });
    return wards.map((ward) => ({ lga: ward.lga.name, name: ward.name }));
  } catch {
    return [];
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

async function main() {
  const allowPartial =
    process.argv.includes('--allow-partial') ||
    process.env.PANTAMIYYA_SHA_REQUIRE_COMPLETE !== 'true';
  const registerWards = await loadRegisterWards();
  const report = validateGombeShaRoster(registerWards, undefined, { allowPartial });
  console.log(formatShaValidateReport(report));
  if (!report.ok) process.exit(1);
}

void main();
