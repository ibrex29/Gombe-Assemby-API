"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = require("dotenv");
const node_path_1 = require("node:path");
const node_url_1 = require("node:url");
const client_1 = require("@prisma/client");
const client_2 = require("../src/client");
const bcrypt = __importStar(require("bcrypt"));
const __dirname = (0, node_path_1.resolve)((0, node_url_1.fileURLToPath)(import.meta.url), '..');
(0, dotenv_1.config)({ path: (0, node_path_1.resolve)(__dirname, '../.env') });
(0, dotenv_1.config)({ path: (0, node_path_1.resolve)(__dirname, '../../../.env') });
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
}
const { adapter, pool } = (0, client_2.createPgAdapter)(connectionString);
const prisma = new client_1.PrismaClient({ adapter });
async function main() {
    console.log('Seeding Electromon database...');
    const states = [
        { name: 'Abia', code: 'AB' },
        { name: 'Adamawa', code: 'AD' },
        { name: 'Akwa Ibom', code: 'AK' },
        { name: 'Anambra', code: 'AN' },
        { name: 'Bauchi', code: 'BA' },
        { name: 'Bayelsa', code: 'BY' },
        { name: 'Benue', code: 'BE' },
        { name: 'Borno', code: 'BO' },
        { name: 'Cross River', code: 'CR' },
        { name: 'Delta', code: 'DE' },
        { name: 'Ebonyi', code: 'EB' },
        { name: 'Edo', code: 'ED' },
        { name: 'Ekiti', code: 'EK' },
        { name: 'Enugu', code: 'EN' },
        { name: 'FCT', code: 'FC' },
        { name: 'Gombe', code: 'GO' },
        { name: 'Imo', code: 'IM' },
        { name: 'Jigawa', code: 'JI' },
        { name: 'Kaduna', code: 'KD' },
        { name: 'Kano', code: 'KN' },
        { name: 'Katsina', code: 'KT' },
        { name: 'Kebbi', code: 'KE' },
        { name: 'Kogi', code: 'KO' },
        { name: 'Kwara', code: 'KW' },
        { name: 'Lagos', code: 'LA' },
        { name: 'Nasarawa', code: 'NA' },
        { name: 'Niger', code: 'NI' },
        { name: 'Ogun', code: 'OG' },
        { name: 'Ondo', code: 'ON' },
        { name: 'Osun', code: 'OS' },
        { name: 'Oyo', code: 'OY' },
        { name: 'Plateau', code: 'PL' },
        { name: 'Rivers', code: 'RI' },
        { name: 'Sokoto', code: 'SO' },
        { name: 'Taraba', code: 'TA' },
        { name: 'Yobe', code: 'YO' },
        { name: 'Zamfara', code: 'ZA' },
    ];
    for (const state of states) {
        await prisma.state.upsert({
            where: { code: state.code },
            update: {},
            create: state,
        });
    }
    const jigawa = await prisma.state.findUniqueOrThrow({ where: { code: 'JI' } });
    const districts = ['Jigawa North West', 'Jigawa North East', 'Jigawa South West', 'Jigawa South East'];
    const districtRecords = [];
    for (const name of districts) {
        const district = await prisma.senatorialDistrict.upsert({
            where: { name_stateId: { name, stateId: jigawa.id } },
            update: {},
            create: { name, stateId: jigawa.id },
        });
        districtRecords.push(district);
    }
    const jigawaLgas = [
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
    for (const lga of jigawaLgas) {
        const district = districtRecords.find((d) => d.name === lga.district);
        await prisma.lGA.upsert({
            where: { name_stateId: { name: lga.name, stateId: jigawa.id } },
            update: {},
            create: {
                name: lga.name,
                stateId: jigawa.id,
                senatorialDistrictId: district?.id,
            },
        });
    }
    const campaign = await prisma.campaign.upsert({
        where: { slug: 'jigawa-2027' },
        update: {},
        create: {
            name: 'Jigawa State Campaign 2027',
            slug: 'jigawa-2027',
            stateId: jigawa.id,
        },
    });
    const passwordHash = await bcrypt.hash('ChangeMe123!', 12);
    const director = await prisma.user.upsert({
        where: { email: 'director@electromon.ng' },
        update: {},
        create: {
            email: 'director@electromon.ng',
            phoneNumber: '+2348000000001',
            passwordHash,
            firstName: 'Campaign',
            lastName: 'Director',
            isActive: true,
        },
    });
    await prisma.campaignMembership.upsert({
        where: { userId_campaignId: { userId: director.id, campaignId: campaign.id } },
        update: {},
        create: {
            userId: director.id,
            campaignId: campaign.id,
            role: client_1.CampaignRole.CAMPAIGN_DIRECTOR,
            scopeType: client_1.ScopeType.CAMPAIGN,
            scopeId: campaign.id,
        },
    });
    const hadejia = await prisma.lGA.findFirstOrThrow({
        where: { name: 'Hadejia', stateId: jigawa.id },
    });
    const ward = await prisma.ward.upsert({
        where: { name_lgaId: { name: 'Hadejia Ward A', lgaId: hadejia.id } },
        update: {},
        create: {
            name: 'Hadejia Ward A',
            lgaId: hadejia.id,
            latitude: 12.4534,
            longitude: 10.0411,
        },
    });
    await prisma.pollingUnit.upsert({
        where: { code: 'JI-HD-001' },
        update: {
            strengthAssessment: 'STRONG',
            status: 'ACTIVE',
        },
        create: {
            code: 'JI-HD-001',
            name: 'Hadejia Central PU 001',
            wardId: ward.id,
            latitude: 12.4534,
            longitude: 10.0411,
            strengthAssessment: 'STRONG',
            status: 'ACTIVE',
        },
    });
    await prisma.pollingUnit.upsert({
        where: { code: 'JI-HD-002' },
        update: {},
        create: {
            code: 'JI-HD-002',
            name: 'Hadejia North PU 002',
            wardId: ward.id,
            latitude: 12.4612,
            longitude: 10.0489,
            strengthAssessment: 'SWING',
            status: 'NEEDS_ATTENTION',
            notes: 'High opposition activity reported during last election',
        },
    });
    await prisma.pollingUnit.upsert({
        where: { code: 'JI-HD-003' },
        update: {},
        create: {
            code: 'JI-HD-003',
            name: 'Hadejia South PU 003',
            wardId: ward.id,
            latitude: 12.4478,
            longitude: 10.0356,
            strengthAssessment: 'WEAK',
            status: 'ACTIVE',
        },
    });
    const dutse = await prisma.lGA.findFirstOrThrow({
        where: { name: 'Dutse', stateId: jigawa.id },
    });
    const sampleGroups = [
        {
            name: 'Hadejia Youth Forum',
            category: client_1.SupportGroupCategory.YOUTH,
            leaderName: 'Ibrahim Musa',
            leaderPhone: '+2348012345678',
            leaderEmail: 'ibrahim@example.com',
            memberCount: 120,
            lgaId: hadejia.id,
            areaOfOperation: 'Hadejia town and surrounds',
            verificationStatus: client_1.VerificationStatus.ACTIVE,
        },
        {
            name: 'Dutse Women Alliance',
            category: client_1.SupportGroupCategory.WOMEN,
            leaderName: 'Fatima Abdullahi',
            leaderPhone: '+2348098765432',
            memberCount: 85,
            lgaId: dutse.id,
            areaOfOperation: 'Dutse LGA',
            verificationStatus: client_1.VerificationStatus.VERIFIED,
        },
        {
            name: 'Jigawa Farmers Cooperative',
            category: client_1.SupportGroupCategory.FARMERS,
            leaderName: 'Usman Garba',
            leaderPhone: '+2348076543210',
            memberCount: 200,
            areaOfOperation: 'Statewide',
            verificationStatus: client_1.VerificationStatus.PENDING,
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
        where: { campaignId: campaign.id, name: 'Hadejia Youth Forum' },
    });
    const womenAlliance = await prisma.supportGroup.findFirstOrThrow({
        where: { campaignId: campaign.id, name: 'Dutse Women Alliance' },
    });
    const sampleCommitments = [
        {
            supportGroupId: youthForum.id,
            title: 'Mobilize 500 youth voters in Hadejia',
            description: 'Door-to-door outreach before INEC registration deadline',
            targetValue: 500,
            currentValue: 120,
            deadline: new Date('2026-12-31'),
            status: client_1.CommitmentStatus.ACTIVE,
        },
        {
            supportGroupId: womenAlliance.id,
            title: 'Organize 20 ward-level women rallies',
            description: 'Coordinate rallies across Dutse LGA wards',
            targetValue: 20,
            currentValue: 8,
            deadline: new Date('2026-10-15'),
            status: client_1.CommitmentStatus.ACTIVE,
        },
        {
            supportGroupId: youthForum.id,
            title: 'Register 1,000 new party members',
            targetValue: 1000,
            currentValue: 0,
            deadline: new Date('2027-01-31'),
            status: client_1.CommitmentStatus.DRAFT,
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
            wardId: ward.id,
            role: 'CANVASSER',
            performanceScore: 72,
            isVerified: true,
        },
        {
            firstName: 'Musa',
            lastName: 'Bello',
            phoneNumber: '+2348011111002',
            wardId: ward.id,
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
        await prisma.pollingUnit.updateMany({
            where: { code: 'JI-HD-001' },
            data: { assignedAgentId: pollingAgent.id },
        });
    }
    const pu001 = await prisma.pollingUnit.findFirst({ where: { code: 'JI-HD-001' } });
    const pu002 = await prisma.pollingUnit.findFirst({ where: { code: 'JI-HD-002' } });
    if (pu001 && pu002) {
        const situationSamples = [
            {
                pollingUnitId: pu001.id,
                reportedById: director.id,
                status: client_1.SituationStatus.REPORTING,
                notes: 'Voting underway. Good turnout observed.',
                isUrgent: false,
            },
            {
                pollingUnitId: pu002.id,
                reportedById: director.id,
                status: client_1.SituationStatus.INCIDENT,
                notes: 'Materials arrived late. Situation being monitored.',
                isUrgent: true,
            },
            {
                pollingUnitId: pu001.id,
                reportedById: director.id,
                status: client_1.SituationStatus.OPEN,
                notes: 'PU opened on time. Agents in position.',
                isUrgent: false,
            },
        ];
        for (const sample of situationSamples) {
            const existing = await prisma.situationUpdate.findFirst({
                where: {
                    pollingUnitId: sample.pollingUnitId,
                    notes: sample.notes,
                },
            });
            if (!existing) {
                await prisma.situationUpdate.create({ data: sample });
            }
        }
    }
    const fieldReportSamples = [
        {
            campaignId: campaign.id,
            reportedById: director.id,
            type: client_1.FieldReportType.CAMPAIGN_PROGRESS,
            title: 'Strong turnout in Hadejia Ward A',
            description: 'Early morning reports indicate higher than expected voter turnout at central polling units.',
            wardId: ward.id,
            pollingUnitId: pu001?.id,
            isUrgent: false,
        },
        {
            campaignId: campaign.id,
            reportedById: director.id,
            type: client_1.FieldReportType.SECURITY_CONCERN,
            title: 'Opposition supporters near PU 002',
            description: 'Group of unidentified persons gathering 200m from polling unit. Local coordinators notified.',
            wardId: ward.id,
            pollingUnitId: pu002?.id,
            isUrgent: true,
        },
    ];
    for (const report of fieldReportSamples) {
        const existing = await prisma.fieldReport.findFirst({
            where: { campaignId: campaign.id, title: report.title },
        });
        if (!existing) {
            await prisma.fieldReport.create({
                data: { ...report, photoUrls: [] },
            });
        }
    }
    console.log('Seed complete.');
    console.log('  Campaign:', campaign.name);
    console.log('  Director login: director@electromon.ng / ChangeMe123!');
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
//# sourceMappingURL=seed.js.map