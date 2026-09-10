/**
 * Production bootstrap seed for A4A · National APC (Nigeria 2027).
 *
 * Safe for production:
 *  - Full Nigeria INEC geography (~177k polling units)
 *  - National campaign + director (and optional officers via env)
 *  - Does NOT seed collation results, incidents, support groups, or demo fixtures
 *
 * Required env:
 *   DATABASE_URL
 *   SEED_ADMIN_PASSWORD          (min 12 chars; no demo defaults)
 *
 * Optional env:
 *   SEED_CAMPAIGN_NAME           default: A4A · Arewa for Asiwaju
 *   SEED_CAMPAIGN_SLUG           default: apc-nigeria-2027
 *   SEED_ADMIN_EMAIL             default: director@electromon.ng
 *   SEED_ADMIN_PHONE             default: +2348000000001
 *   SEED_ADMIN_FIRST_NAME        default: Campaign
 *   SEED_ADMIN_LAST_NAME         default: Director
 *   SEED_NATIONAL_OFFICER_EMAIL  if set, creates NATIONAL_COLLATION_OFFICER
 *   SEED_NATIONAL_OFFICER_PHONE  required when SEED_NATIONAL_OFFICER_EMAIL is set
 *   SEED_CANDIDATE_EMAIL         if set, creates CANDIDATE membership
 *   SEED_CANDIDATE_PHONE         required when SEED_CANDIDATE_EMAIL is set
 *   SEED_DEMO_FCT_ACCOUNTS=true  also create FCT PU/ward/LGA demo logins (for UAT only)
 *
 * Run:
 *   pnpm --dir db seed:production:national
 *   # or from electromon-api-national root:
 *   pnpm db:seed:production:national
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
import { seedNigeriaInecFromJayCodist } from './seed-inec-nigeria';
import { NIGERIAN_REGISTERED_PARTIES } from '../../shared/src/parties';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

config({ path: resolve(__dirname, '../.env') });
config({ path: resolve(__dirname, '../../../.env') });

const CLIENT_PARTY_CODE = 'APC';
const TRACKED_PARTIES = NIGERIAN_REGISTERED_PARTIES as unknown as Prisma.InputJsonValue;

function env(name: string, fallback?: string) {
  const value = process.env[name]?.trim();
  if (value) return value;
  return fallback;
}

function truthy(name: string) {
  const value = env(name)?.toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

function requireProductionPassword() {
  const password = env('SEED_ADMIN_PASSWORD');
  if (!password) {
    throw new Error(
      'SEED_ADMIN_PASSWORD is required for production national seed (min 12 characters).',
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

async function clearCampaignOperationalData(prisma: PrismaClient, campaignId: string) {
  await prisma.collationActionLog.deleteMany({ where: { campaignId } });
  await prisma.collationResult.deleteMany({ where: { campaignId } });
  await prisma.fieldReport.deleteMany({ where: { campaignId } });
  await prisma.commitment.deleteMany({ where: { campaignId } });
  await prisma.supportGroup.deleteMany({ where: { campaignId } });
  await prisma.volunteer.deleteMany({ where: { campaignId } });
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const adminPassword = requireProductionPassword();
  const campaignName = env('SEED_CAMPAIGN_NAME', 'A4A · Arewa for Asiwaju')!;
  const campaignSlug = env('SEED_CAMPAIGN_SLUG', 'apc-nigeria-2027')!;
  const adminEmail = env('SEED_ADMIN_EMAIL', 'director@electromon.ng')!;
  const adminPhone = normalizePhone(env('SEED_ADMIN_PHONE', '+2348000000001')!);
  const adminFirst = env('SEED_ADMIN_FIRST_NAME', 'Campaign')!;
  const adminLast = env('SEED_ADMIN_LAST_NAME', 'Director')!;

  console.log('A4A national production seed — full geography + accounts (no demo results)…');

  process.env.SEED_FULL_INEC = 'true';
  const cacheDir = resolve(__dirname, 'seed-data/cache');

  const { adapter, pool } = createPgAdapter(connectionString);
  const prisma = new PrismaClient({ adapter });

  try {
    const inec = await seedNigeriaInecFromJayCodist(prisma, cacheDir);
    const fct = inec.states.FC;
    if (!fct) throw new Error('FCT was not seeded');

    const campaign = await prisma.campaign.upsert({
      where: { slug: campaignSlug },
      update: {
        name: campaignName,
        stateId: fct.id,
        isNational: true,
        clientPartyCode: CLIENT_PARTY_CODE,
        trackedParties: TRACKED_PARTIES,
        isActive: true,
      },
      create: {
        name: campaignName,
        slug: campaignSlug,
        stateId: fct.id,
        isNational: true,
        clientPartyCode: CLIENT_PARTY_CODE,
        trackedParties: TRACKED_PARTIES,
        isActive: true,
      },
    });

    console.log('  Clearing prior collation/incident/demo data for this campaign…');
    await clearCampaignOperationalData(prisma, campaign.id);

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
        firstName: env('SEED_CANDIDATE_FIRST_NAME', 'Asiwaju')!,
        lastName: env('SEED_CANDIDATE_LAST_NAME', 'Campaign')!,
        passwordHash,
        campaignId: campaign.id,
        role: CampaignRole.CANDIDATE,
        scopeType: ScopeType.CAMPAIGN,
        scopeId: campaign.id,
      });
      createdAccounts.push({ role: 'CANDIDATE', email: candidate.email, phone: candidatePhone });
    }

    const nationalEmail = env('SEED_NATIONAL_OFFICER_EMAIL');
    if (nationalEmail) {
      const nationalPhoneRaw = env('SEED_NATIONAL_OFFICER_PHONE');
      if (!nationalPhoneRaw) {
        throw new Error(
          'SEED_NATIONAL_OFFICER_PHONE is required when SEED_NATIONAL_OFFICER_EMAIL is set.',
        );
      }
      const nationalPhone = normalizePhone(nationalPhoneRaw);
      const nationalOfficer = await upsertOfficer(prisma, {
        email: nationalEmail,
        phoneNumber: nationalPhone,
        firstName: env('SEED_NATIONAL_OFFICER_FIRST_NAME', 'National')!,
        lastName: env('SEED_NATIONAL_OFFICER_LAST_NAME', 'Coordinator')!,
        passwordHash,
        campaignId: campaign.id,
        role: CampaignRole.NATIONAL_COLLATION_OFFICER,
        scopeType: ScopeType.NATIONAL,
        scopeId: 'NGA',
      });
      createdAccounts.push({
        role: 'NATIONAL_COLLATION_OFFICER',
        email: nationalOfficer.email,
        phone: nationalPhone,
      });
    }

    if (truthy('SEED_DEMO_FCT_ACCOUNTS')) {
      const demoPhoneBase = env('SEED_DEMO_FCT_PHONE_BASE', '+234800000000')!;
      const demoAccounts = [
        {
          email: 'pu.agent@electromon.ng',
          phone: `${demoPhoneBase}2`,
          firstName: 'Polling unit',
          lastName: 'Agent',
          role: CampaignRole.POLLING_AGENT,
          scopeType: ScopeType.POLLING_UNIT,
          scopeId: inec.sample.puId,
        },
        {
          email: 'ward.coordinator@electromon.ng',
          phone: `${demoPhoneBase}3`,
          firstName: 'Ward',
          lastName: 'Coordinator',
          role: CampaignRole.WARD_RA_OFFICER,
          scopeType: ScopeType.WARD,
          scopeId: inec.sample.wardId,
        },
        {
          email: 'lga.coordinator@electromon.ng',
          phone: `${demoPhoneBase}4`,
          firstName: 'LGA',
          lastName: 'Coordinator',
          role: CampaignRole.LGA_COLLATION_OFFICER,
          scopeType: ScopeType.LGA,
          scopeId: inec.sample.lgaId,
        },
        {
          email: 'state.fc@electromon.ng',
          phone: `${demoPhoneBase}5`,
          firstName: 'FCT',
          lastName: 'Coordinator',
          role: CampaignRole.STATE_COLLATION_OFFICER,
          scopeType: ScopeType.STATE,
          scopeId: fct.id,
        },
      ] as const;

      for (const demo of demoAccounts) {
        const user = await upsertOfficer(prisma, {
          email: demo.email,
          phoneNumber: normalizePhone(demo.phone),
          firstName: demo.firstName,
          lastName: demo.lastName,
          passwordHash,
          campaignId: campaign.id,
          role: demo.role,
          scopeType: demo.scopeType,
          scopeId: demo.scopeId,
        });
        createdAccounts.push({ role: demo.role, email: user.email, phone: normalizePhone(demo.phone) });
      }
      console.log(`  FCT demo accounts enabled (${inec.sample.puCode} · ${inec.sample.lgaName})`);
    }

    const [wardCount, puCount] = await Promise.all([
      prisma.ward.count(),
      prisma.pollingUnit.count(),
    ]);

    console.log('A4A national production seed complete.');
    console.log(`  Campaign: ${campaign.name} (${campaign.slug})`);
    console.log(`  Client party: ${CLIENT_PARTY_CODE}`);
    console.log(`  Geography: ${wardCount} wards · ${puCount} polling units`);
    console.log('  Accounts:');
    for (const account of createdAccounts) {
      console.log(`    - ${account.role}: ${account.email} / ${account.phone}`);
    }
    console.log('  Password: (from SEED_ADMIN_PASSWORD)');
    console.log('  No collation results, incidents, or support-group fixtures were seeded.');
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
