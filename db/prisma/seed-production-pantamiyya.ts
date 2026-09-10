/**
 * Production bootstrap seed for Pantamiyya · Gombe Governorship.
 *
 * Safe for production:
 *  - All Nigeria states/LGAs; full Gombe wards + polling units (~2,988 PUs)
 *  - Gombe state campaign (not national)
 *  - Does NOT seed collation results, incidents, or demo fixtures
 *
 * Required env:
 *   DATABASE_URL
 *   SEED_ADMIN_PASSWORD          (min 12 chars)
 *
 * Optional env:
 *   SEED_DETAIL_STATES           default: GO
 *   SEED_CAMPAIGN_NAME           default: Pantamiyya · Gombe Governorship
 *   SEED_CAMPAIGN_SLUG           default: pantamiyya-gombe-governorship
 *   SEED_ADMIN_EMAIL             default: director@pantamiyya.ng
 *   SEED_ADMIN_PHONE             default: +2348000000101
 *   SEED_STATE_OFFICER_EMAIL     if set, creates STATE_COLLATION_OFFICER for Gombe
 *   SEED_STATE_OFFICER_PHONE     required when SEED_STATE_OFFICER_EMAIL is set
 *   SEED_CANDIDATE_EMAIL         if set, creates CANDIDATE membership
 *   SEED_CANDIDATE_PHONE         required when SEED_CANDIDATE_EMAIL is set
 *
 * Run:
 *   pnpm --dir db seed:production:pantamiyya
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bcrypt from 'bcrypt';
import {
  PrismaClient,
  Prisma,
  CampaignRole,
  ScopeType,
  ContestType,
} from '../src/generated/client';
import { createPgAdapter } from '../src/client';
import { seedNigeriaInecFromJayCodist } from './seed-inec-nigeria';
import { NIGERIAN_REGISTERED_PARTIES } from '../../shared/src/parties';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

config({ path: resolve(__dirname, '../.env') });
config({ path: resolve(__dirname, '../../../.env') });

const CLIENT_PARTY_CODE = 'PDP';

const TRACKED_PARTIES = [
  ...NIGERIAN_REGISTERED_PARTIES.filter((p) => p.code === CLIENT_PARTY_CODE),
  ...NIGERIAN_REGISTERED_PARTIES.filter((p) => p.code !== CLIENT_PARTY_CODE),
] as unknown as Prisma.InputJsonValue;
const STATE_CODE = 'GO';

function env(name: string, fallback?: string) {
  const value = process.env[name]?.trim();
  if (value) return value;
  return fallback;
}

function requireProductionPassword() {
  const password = env('SEED_ADMIN_PASSWORD');
  if (!password) {
    throw new Error(
      'SEED_ADMIN_PASSWORD is required for Pantamiyya production seed (min 12 characters).',
    );
  }
  if (password.length < 12) {
    throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters.');
  }
  const blocked = new Set([
    'ChangeMe123!',
    '1234567890',
    'password',
    'Password123!',
    'admin123456',
  ]);
  if (blocked.has(password)) {
    throw new Error('SEED_ADMIN_PASSWORD looks like a demo/default value — choose a strong secret.');
  }
  return password;
}

function normalizePhone(raw: string) {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('234') && digits.length >= 13) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 11) return `+234${digits.slice(1)}`;
  if (digits.length === 10) return `+234${digits}`;
  if (raw.startsWith('+')) return raw;
  return `+${digits}`;
}

async function upsertOfficer(
  prisma: PrismaClient,
  input: {
    email: string;
    phoneNumber: string;
    firstName: string;
    lastName: string;
    passwordHash: string;
    campaignId: string;
    role: CampaignRole;
    scopeType: ScopeType;
    scopeId: string;
  },
) {
  const user = await prisma.user.upsert({
    where: { email: input.email },
    update: {
      phoneNumber: input.phoneNumber,
      passwordHash: input.passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      isActive: true,
    },
    create: {
      email: input.email,
      phoneNumber: input.phoneNumber,
      passwordHash: input.passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      isActive: true,
    },
  });

  await prisma.campaignMembership.upsert({
    where: { userId_campaignId: { userId: user.id, campaignId: input.campaignId } },
    update: {
      role: input.role,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      isActive: true,
    },
    create: {
      userId: user.id,
      campaignId: input.campaignId,
      role: input.role,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      isActive: true,
    },
  });

  return user;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const adminPassword = requireProductionPassword();
  const campaignName = env('SEED_CAMPAIGN_NAME', 'Pantamiyya · Gombe Governorship')!;
  const campaignSlug = env('SEED_CAMPAIGN_SLUG', 'pantamiyya-gombe-governorship')!;
  const adminEmail = env('SEED_ADMIN_EMAIL', 'director@pantamiyya.ng')!;
  const adminPhone = normalizePhone(env('SEED_ADMIN_PHONE', '+2348000000101')!);
  const adminFirst = env('SEED_ADMIN_FIRST_NAME', 'Campaign')!;
  const adminLast = env('SEED_ADMIN_LAST_NAME', 'Director')!;

  process.env.SEED_DETAIL_STATES = env('SEED_DETAIL_STATES', STATE_CODE)!;
  process.env.SEED_PU_LIMIT_PER_WARD = '9999';
  delete process.env.SEED_FULL_INEC;

  console.log(
    `Pantamiyya production seed — Nigeria register + full ${STATE_CODE} PUs + governorship campaign…`,
  );

  const cacheDir = resolve(__dirname, 'seed-data/cache');
  const { adapter, pool } = createPgAdapter(connectionString);
  const prisma = new PrismaClient({ adapter });

  try {
    const inec = await seedNigeriaInecFromJayCodist(prisma, cacheDir);
    const gombe = inec.states[STATE_CODE];
    if (!gombe) throw new Error(`Gombe (${STATE_CODE}) was not seeded`);

    const campaign = await prisma.campaign.upsert({
      where: { slug: campaignSlug },
      update: {
        name: campaignName,
        stateId: gombe.id,
        isNational: false,
        clientPartyCode: CLIENT_PARTY_CODE,
        trackedParties: TRACKED_PARTIES,
        isActive: true,
      },
      create: {
        name: campaignName,
        slug: campaignSlug,
        stateId: gombe.id,
        isNational: false,
        clientPartyCode: CLIENT_PARTY_CODE,
        trackedParties: TRACKED_PARTIES,
        isActive: true,
      },
    });

    await prisma.contest.upsert({
      where: { campaignId_type: { campaignId: campaign.id, type: ContestType.GOVERNORSHIP } },
      update: {
        slug: 'governorship',
        label: 'Governorship',
        isDefault: true,
        irevElectionId: env('IREV_ELECTION_ID', '6407d9bfce35006e92156f2e'),
        irevElectionLabel: env('IREV_ELECTION_LABEL', 'Gombe Governorship Election'),
      },
      create: {
        campaignId: campaign.id,
        type: ContestType.GOVERNORSHIP,
        slug: 'governorship',
        label: 'Governorship',
        isDefault: true,
        irevElectionId: env('IREV_ELECTION_ID', '6407d9bfce35006e92156f2e'),
        irevElectionLabel: env('IREV_ELECTION_LABEL', 'Gombe Governorship Election'),
      },
    });
    await prisma.contest.upsert({
      where: { campaignId_type: { campaignId: campaign.id, type: ContestType.ASSEMBLY } },
      update: {
        slug: 'assembly',
        label: 'State House of Assembly',
        irevElectionId: env('IREV_ASSEMBLY_ELECTION_ID') ?? null,
        irevElectionLabel: env(
          'IREV_ASSEMBLY_ELECTION_LABEL',
          'Gombe State House of Assembly Election',
        ),
      },
      create: {
        campaignId: campaign.id,
        type: ContestType.ASSEMBLY,
        slug: 'assembly',
        label: 'State House of Assembly',
        isDefault: false,
        irevElectionId: env('IREV_ASSEMBLY_ELECTION_ID') ?? null,
        irevElectionLabel: env(
          'IREV_ASSEMBLY_ELECTION_LABEL',
          'Gombe State House of Assembly Election',
        ),
      },
    });

    const passwordHash = await bcrypt.hash(adminPassword, 12);
    const createdAccounts: Array<{ role: string; email: string; phone: string }> = [];

    const director = await upsertOfficer(prisma, {
      email: adminEmail,
      phoneNumber: adminPhone,
      firstName: adminFirst,
      lastName: adminLast,
      passwordHash,
      campaignId: campaign.id,
      role: CampaignRole.CAMPAIGN_DIRECTOR,
      scopeType: ScopeType.CAMPAIGN,
      scopeId: campaign.id,
    });
    createdAccounts.push({
      role: 'CAMPAIGN_DIRECTOR',
      email: director.email,
      phone: adminPhone,
    });

    const candidateEmail = env('SEED_CANDIDATE_EMAIL');
    if (candidateEmail) {
      const candidatePhoneRaw = env('SEED_CANDIDATE_PHONE');
      if (!candidatePhoneRaw) {
        throw new Error('SEED_CANDIDATE_PHONE is required when SEED_CANDIDATE_EMAIL is set.');
      }
      const candidatePhone = normalizePhone(candidatePhoneRaw);
      const candidate = await upsertOfficer(prisma, {
        email: candidateEmail,
        phoneNumber: candidatePhone,
        firstName: env('SEED_CANDIDATE_FIRST_NAME', 'Governorship')!,
        lastName: env('SEED_CANDIDATE_LAST_NAME', 'Candidate')!,
        passwordHash,
        campaignId: campaign.id,
        role: CampaignRole.CANDIDATE,
        scopeType: ScopeType.CAMPAIGN,
        scopeId: campaign.id,
      });
      createdAccounts.push({
        role: 'CANDIDATE',
        email: candidate.email,
        phone: candidatePhone,
      });
    }

    const stateOfficerEmail = env('SEED_STATE_OFFICER_EMAIL');
    if (stateOfficerEmail) {
      const stateOfficerPhoneRaw = env('SEED_STATE_OFFICER_PHONE');
      if (!stateOfficerPhoneRaw) {
        throw new Error('SEED_STATE_OFFICER_PHONE is required when SEED_STATE_OFFICER_EMAIL is set.');
      }
      const stateOfficerPhone = normalizePhone(stateOfficerPhoneRaw);
      const stateOfficer = await upsertOfficer(prisma, {
        email: stateOfficerEmail,
        phoneNumber: stateOfficerPhone,
        firstName: env('SEED_STATE_OFFICER_FIRST_NAME', 'Gombe')!,
        lastName: env('SEED_STATE_OFFICER_LAST_NAME', 'Collation')!,
        passwordHash,
        campaignId: campaign.id,
        role: CampaignRole.STATE_COLLATION_OFFICER,
        scopeType: ScopeType.STATE,
        scopeId: gombe.id,
      });
      createdAccounts.push({
        role: 'STATE_COLLATION_OFFICER',
        email: stateOfficer.email,
        phone: stateOfficerPhone,
      });
    }

    const gombeLgas = await prisma.lGA.count({ where: { stateId: gombe.id } });
    const gombeWards = await prisma.ward.count({
      where: { lga: { stateId: gombe.id } },
    });
    const gombePus = await prisma.pollingUnit.count({
      where: { ward: { lga: { stateId: gombe.id } } },
    });

    console.log('Pantamiyya production seed complete.');
    console.log(`  Campaign: ${campaign.name} (${campaign.slug})`);
    console.log(`  Client party: ${CLIENT_PARTY_CODE}`);
    console.log(`  Gombe geography: ${gombeLgas} LGAs · ${gombeWards} wards · ${gombePus} PUs`);
    console.log('  Accounts:');
    for (const account of createdAccounts) {
      console.log(`    - ${account.role}: ${account.email} / ${account.phone}`);
    }
    console.log('  Password: (from SEED_ADMIN_PASSWORD)');
    console.log('  Contests: governorship (default) + assembly');
    console.log('  SHA seats: run `pnpm --dir db sha:apply` after editing gombe-sha-constituencies.ts');
    console.log('  No collation results or IReV snapshots were seeded — run IReV catalog after deploy.');
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
