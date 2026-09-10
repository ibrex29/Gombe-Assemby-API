import { ContestType, createPgAdapter, PrismaClient } from '@electromon/db';
import {
  constituencyPersistFields,
  formatShaValidateReport,
  GOMBE_SHA_CONSTITUENCIES,
  GOMBE_STATE_CODE,
  lgaMatchesSeat,
  validateGombeShaRoster,
  wardMatchesName,
} from '../gombe-sha-constituencies';

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const allowPartial =
    process.argv.includes('--allow-partial') ||
    process.env.PANTAMIYYA_SHA_REQUIRE_COMPLETE !== 'true';

  const { adapter, pool } = createPgAdapter(connectionString);
  const prisma = new PrismaClient({ adapter });

  try {
    const state = await prisma.state.findFirst({
      where: { code: { equals: GOMBE_STATE_CODE, mode: 'insensitive' } },
    });
    if (!state) throw new Error('Gombe is not in the electoral register');

    const lgas = await prisma.lGA.findMany({
      where: { stateId: state.id },
      include: { wards: true },
    });
    const registerWards = lgas.flatMap((lga) =>
      lga.wards.map((ward) => ({ lga: lga.name, name: ward.name })),
    );
    const report = validateGombeShaRoster(registerWards, undefined, { allowPartial });
    console.log(formatShaValidateReport(report));
    if (!report.ok) {
      throw new Error(report.errors.join('; '));
    }

    const seats = [];
    for (const seat of GOMBE_SHA_CONSTITUENCIES) {
      const lga = lgas.find((row) => lgaMatchesSeat(row.name, seat));
      const fields = constituencyPersistFields(seat, lga?.id ?? null);
      const row = await prisma.stateAssemblyConstituency.upsert({
        where: { code_stateId: { code: seat.code, stateId: state.id } },
        update: fields,
        create: {
          stateId: state.id,
          code: seat.code,
          ...fields,
        },
      });
      seats.push({ seat, row, lga });
    }

    let assigned = 0;
    for (const { seat, row, lga } of seats) {
      if (!lga || seat.wards.length === 0) continue;
      for (const wardName of seat.wards) {
        const ward = lga.wards.find((item) => wardMatchesName(item.name, wardName));
        if (!ward) continue;
        await prisma.ward.update({
          where: { id: ward.id },
          data: { constituencyId: row.id },
        });
        assigned += 1;
      }
    }

    const campaigns = await prisma.campaign.findMany({
      where: { stateId: state.id, isActive: true },
      select: { id: true },
    });
    for (const campaign of campaigns) {
      await prisma.contest.upsert({
        where: { campaignId_type: { campaignId: campaign.id, type: ContestType.ASSEMBLY } },
        update: { slug: 'assembly', label: 'State House of Assembly' },
        create: {
          campaignId: campaign.id,
          type: ContestType.ASSEMBLY,
          slug: 'assembly',
          label: 'State House of Assembly',
          isDefault: false,
          irevElectionLabel: 'Gombe State House of Assembly Election',
        },
      });
    }

    console.log(`\nApplied ${seats.length} seats · assigned ${assigned} ward(s)`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

void main();
