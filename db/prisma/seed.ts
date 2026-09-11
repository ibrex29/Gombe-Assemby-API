import { config } from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PrismaClient,
  Prisma,
  CampaignRole,
  ScopeType,
  SupportGroupCategory,
  VerificationStatus,
  CommitmentStatus,
  SituationStatus,
  ContestType,
} from '../src/generated/client';
import { createPgAdapter } from '../src/client';
import { seedNigeriaInecFromJayCodist } from './seed-inec-nigeria';
import { seedNationalSummaries, seedLgaCollationTree, seedCompetitiveLgaTrees, type SeedOutcome } from './seed-collation';
import { seedMatureNationalDemo } from './seed-mature-demo';
import * as bcrypt from 'bcrypt';
import { NIGERIAN_REGISTERED_PARTIES } from '../../shared/src/parties';
import { NIGERIA_STATES } from './nigeria-states';

const TRACKED_PARTIES = NIGERIAN_REGISTERED_PARTIES as unknown as Prisma.InputJsonValue;
const CLIENT_PARTY_CODE = 'APC';
const PARTY_CODES = NIGERIAN_REGISTERED_PARTIES.map((party) => party.code);

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

config({ path: resolve(__dirname, '../.env') });
config({ path: resolve(__dirname, '../../../.env') });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

const { adapter, pool } = createPgAdapter(connectionString);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('Seeding A4A national database (ballot party: APC)…');

  const cacheDir = resolve(__dirname, 'seed-data/cache');
  const inec = await seedNigeriaInecFromJayCodist(prisma, cacheDir);
  const fct = inec.states.FC;
  if (!fct) throw new Error('FCT was not seeded');

  const campaign = await prisma.campaign.upsert({
    where: { slug: 'apc-nigeria-2027' },
    update: {
      name: 'A4A · Arewa for Asiwaju',
      stateId: fct.id,
      isNational: true,
      clientPartyCode: CLIENT_PARTY_CODE,
      trackedParties: TRACKED_PARTIES,
    },
    create: {
      name: 'A4A · Arewa for Asiwaju',
      slug: 'apc-nigeria-2027',
      stateId: fct.id,
      isNational: true,
      clientPartyCode: CLIENT_PARTY_CODE,
      trackedParties: TRACKED_PARTIES,
    },
  });

  const governorship = await prisma.contest.upsert({
    where: { campaignId_type: { campaignId: campaign.id, type: ContestType.GOVERNORSHIP } },
    update: {
      slug: 'governorship',
      label: 'Governorship',
      isDefault: true,
      irevElectionId: process.env.IREV_ELECTION_ID?.trim() || '6407d9bfce35006e92156f2e',
      irevElectionLabel: process.env.IREV_ELECTION_LABEL?.trim() || 'Gombe Governorship Election',
    },
    create: {
      campaignId: campaign.id,
      type: ContestType.GOVERNORSHIP,
      slug: 'governorship',
      label: 'Governorship',
      isDefault: true,
      irevElectionId: process.env.IREV_ELECTION_ID?.trim() || '6407d9bfce35006e92156f2e',
      irevElectionLabel: process.env.IREV_ELECTION_LABEL?.trim() || 'Gombe Governorship Election',
    },
  });
  await prisma.contest.upsert({
    where: { campaignId_type: { campaignId: campaign.id, type: ContestType.ASSEMBLY } },
    update: {
      slug: 'assembly',
      label: 'State House of Assembly',
      irevElectionId: process.env.IREV_ASSEMBLY_ELECTION_ID?.trim() || null,
      irevElectionLabel:
        process.env.IREV_ASSEMBLY_ELECTION_LABEL?.trim() || 'Gombe State House of Assembly Election',
    },
    create: {
      campaignId: campaign.id,
      type: ContestType.ASSEMBLY,
      slug: 'assembly',
      label: 'State House of Assembly',
      isDefault: false,
      irevElectionId: process.env.IREV_ASSEMBLY_ELECTION_ID?.trim() || null,
      irevElectionLabel:
        process.env.IREV_ASSEMBLY_ELECTION_LABEL?.trim() || 'Gombe State House of Assembly Election',
    },
  });

  const adminPasswordHash = await bcrypt.hash('1234567890', 12);
  const passwordHash = await bcrypt.hash('ChangeMe123!', 12);

  const director = await prisma.user.upsert({
    where: { email: 'director@electromon.ng' },
    update: {
      phoneNumber: '+2348000000001',
      passwordHash: adminPasswordHash,
      firstName: 'Campaign',
      lastName: 'Director',
      isActive: true,
    },
    create: {
      email: 'director@electromon.ng',
      phoneNumber: '+2348000000001',
      passwordHash: adminPasswordHash,
      firstName: 'Campaign',
      lastName: 'Director',
      isActive: true,
    },
  });

  await prisma.campaignMembership.upsert({
    where: { userId_campaignId: { userId: director.id, campaignId: campaign.id } },
    update: { role: CampaignRole.CAMPAIGN_DIRECTOR, scopeType: ScopeType.CAMPAIGN, scopeId: campaign.id },
    create: {
      userId: director.id,
      campaignId: campaign.id,
      role: CampaignRole.CAMPAIGN_DIRECTOR,
      scopeType: ScopeType.CAMPAIGN,
      scopeId: campaign.id,
    },
  });

  await prisma.pollingUnit.update({
    where: { id: inec.sample.puId },
    data: { strengthAssessment: 'STRONG' },
  });
  if (inec.sample.pu2Id) {
    await prisma.pollingUnit.update({
      where: { id: inec.sample.pu2Id },
      data: {
        strengthAssessment: 'SWING',
        status: 'NEEDS_ATTENTION',
        notes: 'Competitive unit — watch opposition activity',
      },
    });
  }

  async function upsertAccount(opts: {
    email: string;
    aliases?: string[];
    phoneNumber: string;
    firstName: string;
    lastName: string;
    role: CampaignRole;
    scopeType: ScopeType;
    scopeId: string;
  }): Promise<string> {
    const emails = [opts.email, ...(opts.aliases ?? [])];
    const existing = await prisma.user.findFirst({
      where: {
        OR: [{ email: { in: emails } }, { phoneNumber: opts.phoneNumber }],
      },
    });

    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: {
            email: opts.email,
            phoneNumber: opts.phoneNumber,
            passwordHash,
            firstName: opts.firstName,
            lastName: opts.lastName,
            isActive: true,
          },
        })
      : await prisma.user.create({
          data: {
            email: opts.email,
            phoneNumber: opts.phoneNumber,
            passwordHash,
            firstName: opts.firstName,
            lastName: opts.lastName,
            isActive: true,
          },
        });

    await prisma.campaignMembership.upsert({
      where: { userId_campaignId: { userId: user.id, campaignId: campaign.id } },
      update: { role: opts.role, scopeType: opts.scopeType, scopeId: opts.scopeId, isActive: true },
      create: {
        userId: user.id,
        campaignId: campaign.id,
        role: opts.role,
        scopeType: opts.scopeType,
        scopeId: opts.scopeId,
        isActive: true,
      },
    });

    return user.id;
  }

  const seededOfficers: Record<string, string> = {};

  seededOfficers['pu.agent@electromon.ng'] = await upsertAccount({
    email: 'pu.agent@electromon.ng',
    phoneNumber: '+2348000000002',
    firstName: 'Polling unit',
    lastName: 'Agent',
    role: CampaignRole.POLLING_AGENT,
    scopeType: ScopeType.POLLING_UNIT,
    scopeId: inec.sample.puId,
  });

  seededOfficers['ward.coordinator@electromon.ng'] = await upsertAccount({
    email: 'ward.coordinator@electromon.ng',
    aliases: ['ward.officer@electromon.ng'],
    phoneNumber: '+2348000000003',
    firstName: 'Ward',
    lastName: 'Coordinator',
    role: CampaignRole.WARD_RA_OFFICER,
    scopeType: ScopeType.WARD,
    scopeId: inec.sample.wardId,
  });

  seededOfficers['lga.coordinator@electromon.ng'] = await upsertAccount({
    email: 'lga.coordinator@electromon.ng',
    aliases: ['lga.officer@electromon.ng'],
    phoneNumber: '+2348000000004',
    firstName: 'LGA',
    lastName: 'Coordinator',
    role: CampaignRole.LGA_COLLATION_OFFICER,
    scopeType: ScopeType.LGA,
    scopeId: inec.sample.lgaId,
  });

  seededOfficers['national.coordinator@electromon.ng'] = await upsertAccount({
    email: 'national.coordinator@electromon.ng',
    aliases: ['national.officer@electromon.ng'],
    phoneNumber: '+2348000000006',
    firstName: 'National',
    lastName: 'Coordinator',
    role: CampaignRole.NATIONAL_COLLATION_OFFICER,
    scopeType: ScopeType.NATIONAL,
    scopeId: 'NGA',
  });

  const stateCoordinatorPhones: Array<{ code: string; name: string; phone: string; email: string }> =
    [];
  for (const meta of NIGERIA_STATES) {
    const seeded = inec.states[meta.code];
    if (!seeded) throw new Error(`Missing seeded state ${meta.code}`);
    const email = `state.${meta.code.toLowerCase()}@electromon.ng`;
    const phone =
      meta.code === 'FC' ? '+2348000000005' : `+23481${meta.inecCode}000001`;
    const aliases = meta.code === 'FC' ? ['state.officer@electromon.ng'] : undefined;
    await upsertAccount({
      email,
      aliases,
      phoneNumber: phone,
      firstName: meta.name,
      lastName: `${meta.code} Coordinator`,
      role: CampaignRole.STATE_COLLATION_OFFICER,
      scopeType: ScopeType.STATE,
      scopeId: seeded.id,
    });
    stateCoordinatorPhones.push({ code: meta.code, name: meta.name, phone, email });
  }

  const stateOutcomes = NIGERIA_STATES.map((meta) => {
    const seeded = inec.states[meta.code];
    if (!seeded) throw new Error(`Missing seeded state ${meta.code}`);
    return {
      stateId: seeded.id,
      name: meta.name,
      outcome: meta.outcome as SeedOutcome,
    };
  });

  console.log('Seeding national + state + LGA collation rollups (APC heatmap)…');
  const outcomeSummary = await seedNationalSummaries(
    prisma,
    campaign.id,
    governorship.id,
    PARTY_CODES,
    stateOutcomes,
  );
  console.log(
    `  State heatmap → win: ${outcomeSummary.win}, loss: ${outcomeSummary.loss}, tie: ${outcomeSummary.tie}, pending: ${outcomeSummary.pending}`,
  );
  console.log(`  Campaign party: ${CLIENT_PARTY_CODE} · Tracking: ${PARTY_CODES.join(', ')}`);

  console.log('Seeding mature demo — PU coverage, win/loss/tie mix, incidents…');
  const mature = await seedMatureNationalDemo(prisma, campaign.id, governorship.id, PARTY_CODES, {
    directorId: director.id,
    puOfficerId: seededOfficers['pu.agent@electromon.ng'],
    wardOfficerId: seededOfficers['ward.coordinator@electromon.ng'],
    lgaOfficerId: seededOfficers['lga.coordinator@electromon.ng'],
    reporterIds: [
      director.id,
      seededOfficers['national.coordinator@electromon.ng'],
    ],
  });
  console.log(
    `  Showcase states → ${mature.seededLgas} LGAs, ${mature.seededWards} wards, ${mature.seededPus} PUs, ${mature.seededIncidents} incidents`,
  );

  console.log(`Seeding FCT demo LGA workflow (${inec.sample.lgaName})…`);
  await seedLgaCollationTree(prisma, campaign.id, governorship.id, inec.sample.lgaId, PARTY_CODES, {
    puOfficerId: seededOfficers['pu.agent@electromon.ng'],
    wardOfficerId: seededOfficers['ward.coordinator@electromon.ng'],
    lgaOfficerId: seededOfficers['lga.coordinator@electromon.ng'],
  });

  const jigawa = inec.states.JI;
  if (jigawa) {
    const hadejia = await prisma.lGA.findFirst({
      where: { stateId: jigawa.id, name: { equals: 'Hadejia', mode: 'insensitive' } },
      select: { id: true, name: true },
    });
    if (hadejia) {
      console.log('Seeding Jigawa Hadejia deep collation tree…');
      await seedLgaCollationTree(prisma, campaign.id, governorship.id, hadejia.id, PARTY_CODES, {
        puOfficerId: seededOfficers['pu.agent@electromon.ng'],
        wardOfficerId: seededOfficers['ward.coordinator@electromon.ng'],
        lgaOfficerId: seededOfficers['lga.coordinator@electromon.ng'],
      });
      await seedCompetitiveLgaTrees(prisma, campaign.id, governorship.id, jigawa.id, PARTY_CODES, {
        puOfficerId: seededOfficers['pu.agent@electromon.ng'],
        wardOfficerId: seededOfficers['ward.coordinator@electromon.ng'],
        lgaOfficerId: seededOfficers['lga.coordinator@electromon.ng'],
      });
    }
  }

  const sampleGroups = [
    {
      name: 'APC National Youth Forum',
      category: SupportGroupCategory.YOUTH,
      leaderName: 'Ibrahim Musa',
      leaderPhone: '+2348012345678',
      leaderEmail: 'ibrahim@example.com',
      memberCount: 4200,
      lgaId: inec.sample.lgaId,
      areaOfOperation: 'Nationwide',
      verificationStatus: VerificationStatus.ACTIVE,
    },
    {
      name: 'APC Women Network',
      category: SupportGroupCategory.WOMEN,
      leaderName: 'Fatima Abdullahi',
      leaderPhone: '+2348098765432',
      memberCount: 3100,
      lgaId: inec.sample.lgaId,
      areaOfOperation: 'FCT and North Central',
      verificationStatus: VerificationStatus.VERIFIED,
    },
    {
      name: 'Progressives Farmers Cooperative',
      category: SupportGroupCategory.FARMERS,
      leaderName: 'Usman Garba',
      leaderPhone: '+2348076543210',
      memberCount: 1800,
      areaOfOperation: 'Nationwide',
      verificationStatus: VerificationStatus.PENDING,
    },
  ];

  for (const group of sampleGroups) {
    const existing = await prisma.supportGroup.findFirst({
      where: { campaignId: campaign.id, name: group.name },
    });
    if (!existing) {
      await prisma.supportGroup.create({
        data: { campaignId: campaign.id, ...group },
      });
    }
  }

  const youthForum = await prisma.supportGroup.findFirstOrThrow({
    where: { campaignId: campaign.id, name: 'APC National Youth Forum' },
  });
  const womenAlliance = await prisma.supportGroup.findFirstOrThrow({
    where: { campaignId: campaign.id, name: 'APC Women Network' },
  });

  const sampleCommitments = [
    {
      supportGroupId: youthForum.id,
      title: 'Mobilize 50,000 youth voters nationwide',
      description: 'Digital and ground outreach before INEC registration deadline',
      targetValue: 50000,
      currentValue: 12800,
      deadline: new Date('2026-12-31'),
      status: CommitmentStatus.ACTIVE,
    },
    {
      supportGroupId: womenAlliance.id,
      title: 'Organize 370 ward-level women rallies',
      description: 'One rally per LGA across Nigeria',
      targetValue: 370,
      currentValue: 42,
      deadline: new Date('2027-01-31'),
      status: CommitmentStatus.DRAFT,
    },
  ];

  for (const commitment of sampleCommitments) {
    const existing = await prisma.commitment.findFirst({
      where: { campaignId: campaign.id, title: commitment.title },
    });
    if (!existing) {
      await prisma.commitment.create({
        data: { campaignId: campaign.id, ...commitment },
      });
    }
  }

  const sampleVolunteers = [
    {
      firstName: 'Amina',
      lastName: 'Yusuf',
      phoneNumber: '+2348011111001',
      email: 'amina.yusuf@example.com',
      wardId: inec.sample.wardId,
      role: 'CANVASSER',
      performanceScore: 72,
      isVerified: true,
    },
    {
      firstName: 'Musa',
      lastName: 'Bello',
      phoneNumber: '+2348011111002',
      wardId: inec.sample.wardId,
      role: 'POLLING_AGENT',
      performanceScore: 45,
      isVerified: false,
    },
    {
      firstName: 'Halima',
      lastName: 'Danladi',
      phoneNumber: '+2348011111003',
      email: 'halima@example.com',
      role: 'MOBILIZER',
      performanceScore: 88,
      isVerified: true,
    },
  ];

  for (const volunteer of sampleVolunteers) {
    const existing = await prisma.volunteer.findFirst({
      where: { campaignId: campaign.id, phoneNumber: volunteer.phoneNumber },
    });
    if (!existing) {
      await prisma.volunteer.create({
        data: { campaignId: campaign.id, ...volunteer },
      });
    }
  }

  const pollingAgent = await prisma.volunteer.findFirst({
    where: { campaignId: campaign.id, phoneNumber: '+2348011111002' },
  });
  if (pollingAgent) {
    await prisma.pollingUnit.update({
      where: { id: inec.sample.puId },
      data: { assignedAgentId: pollingAgent.id },
    });
  }

  const demoPuIds = new Set(
    [inec.sample.puId, inec.sample.pu2Id].filter((id): id is string => Boolean(id)),
  );

  const situationSamples = [
    {
      pollingUnitId: inec.sample.puId,
      reportedById: director.id,
      status: SituationStatus.REPORTING,
      phase: 'COUNTING',
      notes: 'Voting underway. Strong APC turnout observed.',
      isUrgent: false,
    },
  ];
  for (const sample of situationSamples) {
    const existing = await prisma.situationUpdate.findFirst({
      where: { pollingUnitId: sample.pollingUnitId, notes: sample.notes },
    });
    if (!existing) await prisma.situationUpdate.create({ data: sample });
  }

  // Demo PU accounts start with no seeded incidents — agents file their own on election day.
  await prisma.fieldReport.deleteMany({
    where: {
      campaignId: campaign.id,
      OR: [
        { pollingUnitId: { in: [...demoPuIds] } },
        { title: { startsWith: 'FCT ·' } },
        { description: { contains: 'Seeded hotspot incident' } },
        { title: { contains: 'Opposition supporters near' } },
        { title: { contains: 'Strong turnout in' } },
      ],
    },
  });

  console.log(`  Open incidents seeded: ${mature.seededIncidents}`);
  console.log('Seed complete.');
  console.log('  Campaign:', campaign.name);
  console.log('  Map layers to explore after seed:');
  console.log('    Results  — national win/loss/tie; Nasarawa + Zamfara pending (grey)');
  console.log('    Coverage — high: Lagos/FCT; partial: Kano/Sokoto; low: Rivers/Kaduna');
  console.log('    Incidents — Lagos, Kano, Rivers, Borno, Benue hotspots');
  console.log('  Director password: 1234567890  (+2348000000001)');
  console.log('  Password for other seeded accounts: ChangeMe123!');
  console.log('');
  console.log('  FCT hierarchy (phone login):');
  console.log('    Director:              +2348000000001  director@electromon.ng');
  console.log(
    `    Polling unit agent:    +2348000000002  pu.agent@electromon.ng  (${inec.sample.puCode} · ${inec.sample.wardName})`,
  );
  console.log(
    `    Ward coordinator:      +2348000000003  ward.coordinator@electromon.ng  (${inec.sample.wardName})`,
  );
  console.log(
    `    LGA coordinator:       +2348000000004  lga.coordinator@electromon.ng  (${inec.sample.lgaName})`,
  );
  console.log('    State coordinator:     +2348000000005  state.fc@electromon.ng  (FCT)');
  console.log('    National coordinator:  +2348000000006  national.coordinator@electromon.ng');
  console.log('');
  console.log('  State coordinators (36 + FCT) — phone is +23481{INEC}000001 except FCT demo 0005:');
  for (const row of stateCoordinatorPhones) {
    console.log(
      `    ${row.code.padEnd(2)}  ${row.name.padEnd(14)}  ${row.phone}  ${row.email}`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
