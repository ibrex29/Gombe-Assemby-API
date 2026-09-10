import { config } from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '../src/generated/client';
import { createPgAdapter } from '../src/client';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
config({ path: resolve(__dirname, '../.env') });
config({ path: resolve(__dirname, '../../.env') });

async function main() {
  const cs = process.env.DATABASE_URL!.replace(/\?schema=.*/, '');
  const { adapter, pool } = createPgAdapter(cs);
  const prisma = new PrismaClient({ adapter });
  try {
    const campaign = await prisma.campaign.findFirst({ where: { slug: 'apc-nigeria-2027' } });
    if (!campaign) throw new Error('campaign not found');

    const deletedLogs = await prisma.collationActionLog.deleteMany({ where: { campaignId: campaign.id } });
    const deletedResults = await prisma.collationResult.deleteMany({ where: { campaignId: campaign.id } });
    console.log(`Cleared ${deletedResults.count} collation results and ${deletedLogs.count} action logs.`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
