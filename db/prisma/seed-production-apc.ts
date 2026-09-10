/**
 * Production bootstrap seed for APC / Dan-Modi (Jigawa).
 *
 * Safe for production:
 *  - Loads full INEC geography (27 LGAs · wards · PUs)
 *  - Creates the APC campaign + director (and optional officers)
 *  - Does NOT invent collation results, incidents, or demo fixtures
 *
 * Required env:
 *   DATABASE_URL
 *   SEED_ADMIN_PASSWORD          (min 12 chars; no demo defaults)
 *
 * Optional env:
 *   SEED_CAMPAIGN_NAME           default: Dan-Modi · Jigawa 2027
 *   SEED_CAMPAIGN_SLUG           default: dan-modi-jigawa-2027
 *   SEED_ADMIN_EMAIL             default: director@danmodi.ng
 *   SEED_ADMIN_PHONE             default: +2348000000001
 *   SEED_ADMIN_FIRST_NAME        default: Campaign
 *   SEED_ADMIN_LAST_NAME         default: Director
 *   SEED_STATE_OFFICER_EMAIL     if set, creates STATE_COLLATION_OFFICER
 *   SEED_STATE_OFFICER_PHONE     required when SEED_STATE_OFFICER_EMAIL is set
 *   SEED_STATE_OFFICER_FIRST_NAME
 *   SEED_STATE_OFFICER_LAST_NAME
 *   SEED_CANDIDATE_EMAIL         if set, creates CANDIDATE membership
 *   SEED_CANDIDATE_PHONE         required when SEED_CANDIDATE_EMAIL is set
 *   SEED_CANDIDATE_FIRST_NAME
 *   SEED_CANDIDATE_LAST_NAME
 *
 * Run:
 *   pnpm --dir db seed:production:apc
 *   # or from electromon-api:
 *   pnpm db:seed:production:apc
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
} from '../src/generated/client';
import { createPgAdapter } from '../src/client';
import { seedJigawaInecFromDirectory } from './seed-inec';
import { NIGERIAN_REGISTERED_PARTIES } from '../../shared/src/parties';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

config({ path: resolve(__dirname, '../.env') });
config({ path: resolve(__dirname, '../../../.env') });

const CLIENT_PARTY_CODE = 'APC';
const TRACKED_PARTIES = NIGERIAN_REGISTERED_PARTIES as unknown as Prisma.InputJsonValue;

const JIGAWA_LGAS: Array<{ name: string; district: string }> = [
  { name: 'Auyo', district: 'Jigawa North East' },
  { name: 'Babura', district: 'Jigawa North West' },
  { name: 'Biriniwa', district: 'Jigawa North East' },
  { name: 'Birnin Kudu', district: 'Jigawa South West' },
  { name: 'Buji', district: 'Jigawa South East' },
  { name: 'Dutse', district: 'Jigawa South West' },
  { name: 'Gagarawa', district: 'Jigawa North East' },
  { name: 'Garki', district: 'Jigawa South East' },
  { name: 'Gumel', district: 'Jigawa North West' },
  { name: 'Guri', district: 'Jigawa North East' },
  { name: 'Gwaram', district: 'Jigawa South East' },
  { name: 'Gwiwa', district: 'Jigawa North West' },
  { name: 'Hadejia', district: 'Jigawa North East' },
  { name: 'Jahun', district: 'Jigawa South West' },
  { name: 'Kafin Hausa', district: 'Jigawa North East' },
  { name: 'Kaugama', district: 'Jigawa North West' },
  { name: 'Kazaure', district: 'Jigawa North West' },
  { name: 'Kiri Kasama', district: 'Jigawa North East' },
  { name: 'Kiyawa', district: 'Jigawa South West' },
  { name: 'Maigatari', district: 'Jigawa North West' },
  { name: 'Malam Madori', district: 'Jigawa North East' },
  { name: 'Miga', district: 'Jigawa South West' },
  { name: 'Ringim', district: 'Jigawa South East' },
  { name: 'Roni', district: 'Jigawa North West' },
  { name: 'Sule Tankarkar', district: 'Jigawa North West' },
  { name: 'Taura', district: 'Jigawa South East' },
  { name: 'Yankwashi', district: 'Jigawa North West' },
];

const DISTRICTS = [
  'Jigawa North West',
  'Jigawa North East',
  'Jigawa South West',
  'Jigawa South East',
] as const;

function env(name: string, fallback?: string) {
  const value = process.env[name]?.trim();
  if (value) return value;
  return fallback;
}

function requireProductionPassword() {
  const password = env('SEED_ADMIN_PASSWORD');
  if (!password) {
    throw new Error(
      'SEED_ADMIN_PASSWORD is required for production APC seed (min 12 characters).',
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
    'danmodi123!',
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
  const campaignName = env('SEED_CAMPAIGN_NAME', 'Dan-Modi · Jigawa 2027')!;
  const campaignSlug = env('SEED_CAMPAIGN_SLUG', 'dan-modi-jigawa-2027')!;
  const adminEmail = env('SEED_ADMIN_EMAIL', 'director@danmodi.ng')!;
  const adminPhone = normalizePhone(env('SEED_ADMIN_PHONE', '+2348000000001')!);
  const adminFirst = env('SEED_ADMIN_FIRST_NAME', 'Campaign')!;
  const adminLast = env('SEED_ADMIN_LAST_NAME', 'Director')!;

  console.log('APC production seed — geography + campaign bootstrap (no demo results)...');

  const { adapter, pool } = createPgAdapter(connectionString);
  const prisma = new PrismaClient({ adapter });

  try {
    await prisma.state.upsert({
      where: { code: 'JI' },
      update: { name: 'Jigawa' },
      create: { name: 'Jigawa', code: 'JI' },
    });
    const jigawa = await prisma.state.findUniqueOrThrow({ where: { code: 'JI' } });

    const districtRecords = [];
    for (const name of DISTRICTS) {
      const district = await prisma.senatorialDistrict.upsert({
        where: { name_stateId: { name, stateId: jigawa.id } },
        update: {},
        create: { name, stateId: jigawa.id },
      });
      districtRecords.push(district);
    }

    for (const lga of JIGAWA_LGAS) {
      const district = districtRecords.find((d) => d.name === lga.district);
      await prisma.lGA.upsert({
        where: { name_stateId: { name: lga.name, stateId: jigawa.id } },
        update: { senatorialDistrictId: district?.id },
        create: {
          name: lga.name,
          stateId: jigawa.id,
          senatorialDistrictId: district?.id,
        },
      });
    }

    const allLgas = await prisma.lGA.findMany({
      where: { stateId: jigawa.id },
      orderBy: { name: 'asc' },
    });
    const lgasByName = Object.fromEntries(allLgas.map((lga) => [lga.name, lga]));
    const seedDataDir = resolve(__dirname, 'seed-data');
    const inec = await seedJigawaInecFromDirectory(prisma, seedDataDir, lgasByName);

    const campaign = await prisma.campaign.upsert({
      where: { slug: campaignSlug },
      update: {
        name: campaignName,
        clientPartyCode: CLIENT_PARTY_CODE,
        trackedParties: TRACKED_PARTIES,
        isActive: true,
        stateId: jigawa.id,
      },
      create: {
        name: campaignName,
        slug: campaignSlug,
        stateId: jigawa.id,
        clientPartyCode: CLIENT_PARTY_CODE,
        trackedParties: TRACKED_PARTIES,
        isActive: true,
      },
    });

    const passwordHash = await bcrypt.hash(adminPassword, 12);

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

    const createdAccounts: Array<{ role: string; email: string; phone: string }> = [
      { role: 'CAMPAIGN_DIRECTOR', email: director.email, phone: adminPhone },
    ];

    const candidateEmail = env('SEED_CANDIDATE_EMAIL');
    if (candidateEmail) {
      const candidatePhoneRaw = env('SEED_CANDIDATE_PHONE');
      if (!candidatePhoneRaw) {
        throw new Error('SEED_CANDIDATE_PHONE is required when SEED_CANDIDATE_EMAIL is set.');
      }
      const candidatePhone = normalizePhone(candidatePhoneRaw);
      if (candidatePhone === adminPhone) {
        throw new Error('SEED_CANDIDATE_PHONE must be different from SEED_ADMIN_PHONE.');
      }
      const candidate = await upsertOfficer(prisma, {
        email: candidateEmail,
        phoneNumber: candidatePhone,
        firstName: env('SEED_CANDIDATE_FIRST_NAME', 'Dan')!,
        lastName: env('SEED_CANDIDATE_LAST_NAME', 'Modi')!,
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
      if (stateOfficerPhone === adminPhone) {
        throw new Error('SEED_STATE_OFFICER_PHONE must be different from SEED_ADMIN_PHONE.');
      }
      const stateOfficer = await upsertOfficer(prisma, {
        email: stateOfficerEmail,
        phoneNumber: stateOfficerPhone,
        firstName: env('SEED_STATE_OFFICER_FIRST_NAME', 'State')!,
        lastName: env('SEED_STATE_OFFICER_LAST_NAME', 'Collation')!,
        passwordHash,
        campaignId: campaign.id,
        role: CampaignRole.STATE_COLLATION_OFFICER,
        scopeType: ScopeType.STATE,
        scopeId: jigawa.id,
      });
      createdAccounts.push({
        role: 'STATE_COLLATION_OFFICER',
        email: stateOfficer.email,
        phone: stateOfficerPhone,
      });
    }

    const wardCount = Object.values(inec).reduce((sum, lga) => sum + Object.keys(lga.wardsByName).length, 0);
    const puCount = Object.values(inec).reduce(
      (sum, lga) => sum + Object.keys(lga.pollingUnitsByCode).length,
      0,
    );

    console.log('APC production seed complete.');
    console.log(`  Campaign: ${campaign.name} (${campaign.slug})`);
    console.log(`  Client party: ${CLIENT_PARTY_CODE}`);
    console.log(`  Geography: ${allLgas.length} LGAs · ${wardCount} wards · ${puCount} PUs`);
    console.log('  Accounts:');
    for (const account of createdAccounts) {
      console.log(`    - ${account.role}: ${account.email} / ${account.phone}`);
    }
    console.log('  Password: (from SEED_ADMIN_PASSWORD)');
    console.log('  Note: no collation results or incident fixtures were seeded.');
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
