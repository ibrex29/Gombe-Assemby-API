import type { PrismaClient } from '../src/generated/client';
import {
  FieldReportStatus,
  FieldReportType,
  IncidentSeverity,
  IncidentType,
} from '../src/generated/client';
import { NIGERIA_STATE_BY_CODE } from './nigeria-states';
import {
  pickSeedOutcome,
  seedLgaCollationTree,
  seedLgaRollupFromWards,
  seedPollingUnitResult,
  seedWardRollupFromPus,
  type SeedOutcome,
} from './seed-collation';

type PuStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
type CoverageTier = 'none' | 'sparse' | 'low' | 'partial' | 'medium' | 'high';

const SHOWCASE_STATES: Array<{
  code: string;
  coverage: CoverageTier;
  lgaCount: number;
  incidentLgas: number;
}> = [
  { code: 'FC', coverage: 'high', lgaCount: 2, incidentLgas: 2 },
  { code: 'LA', coverage: 'high', lgaCount: 4, incidentLgas: 4 },
  { code: 'KN', coverage: 'partial', lgaCount: 4, incidentLgas: 3 },
  { code: 'SO', coverage: 'partial', lgaCount: 3, incidentLgas: 2 },
  { code: 'RI', coverage: 'low', lgaCount: 3, incidentLgas: 3 },
  { code: 'JI', coverage: 'medium', lgaCount: 3, incidentLgas: 2 },
  { code: 'BO', coverage: 'medium', lgaCount: 3, incidentLgas: 2 },
  { code: 'BE', coverage: 'partial', lgaCount: 3, incidentLgas: 2 },
  { code: 'AN', coverage: 'sparse', lgaCount: 2, incidentLgas: 2 },
  { code: 'KD', coverage: 'low', lgaCount: 3, incidentLgas: 2 },
];

const INCIDENT_SPECS = [
  { type: IncidentType.VIOLENCE_THUGGERY, severity: IncidentSeverity.CRITICAL, urgent: true },
  { type: IncidentType.BALLOT_SNATCHING, severity: IncidentSeverity.HIGH, urgent: true },
  { type: IncidentType.VOTE_BUYING, severity: IncidentSeverity.HIGH, urgent: true },
  { type: IncidentType.BVAS_MALFUNCTION, severity: IncidentSeverity.MEDIUM, urgent: false },
  { type: IncidentType.VOTER_INTIMIDATION, severity: IncidentSeverity.MEDIUM, urgent: false },
  { type: IncidentType.OTHERS, severity: IncidentSeverity.LOW, urgent: false },
] as const;

function coverageTarget(tier: CoverageTier) {
  switch (tier) {
    case 'none':
      return 0;
    case 'sparse':
      return 0.06;
    case 'low':
      return 0.18;
    case 'partial':
      return 0.42;
    case 'medium':
      return 0.68;
    case 'high':
      return 0.92;
  }
}

function puStatusForCoverage(tier: CoverageTier, puPos: number, puTotal: number): PuStatus {
  const target = Math.round(puTotal * coverageTarget(tier));
  if (target <= 0) return 'DRAFT';
  if (puPos < Math.floor(target * 0.72)) return 'APPROVED';
  if (puPos < target) return 'SUBMITTED';
  if (puPos === target) return 'REJECTED';
  return 'DRAFT';
}

function puCapForTier(tier: CoverageTier) {
  switch (tier) {
    case 'none':
      return 0;
    case 'sparse':
      return 20;
    case 'low':
      return 60;
    case 'partial':
      return 120;
    case 'medium':
      return 180;
    case 'high':
      return 260;
  }
}

function wardOutcomeFor(lgaOutcome: SeedOutcome, wardIndex: number): SeedOutcome {
  if (lgaOutcome === 'PENDING') return 'PENDING';
  if (wardIndex % 6 === 0) return 'TIE';
  if (wardIndex % 5 === 0) {
    return lgaOutcome.includes('WIN') ? 'LOSS' : 'WIN';
  }
  return lgaOutcome;
}

export interface MatureDemoActors {
  directorId: string;
  puOfficerId?: string;
  wardOfficerId?: string;
  lgaOfficerId?: string;
  reporterIds: string[];
}

export async function seedMatureNationalDemo(
  prisma: PrismaClient,
  campaignId: string,
  contestId: string,
  partyCodes: string[],
  actors: MatureDemoActors,
) {
  let seededPus = 0;
  let seededWards = 0;
  let seededLgas = 0;
  let puIndex = 10_000;

  let seededIncidents = 0;

  for (const plan of SHOWCASE_STATES) {
    const meta = NIGERIA_STATE_BY_CODE[plan.code];
    if (!meta) continue;

    const state = await prisma.state.findFirst({
      where: { code: plan.code },
      select: { id: true, name: true },
    });
    if (!state) continue;

    const lgas = await prisma.lGA.findMany({
      where: { stateId: state.id },
      orderBy: { name: 'asc' },
      take: plan.lgaCount,
      include: {
        wards: {
          orderBy: { name: 'asc' },
          include: {
            pollingUnits: { orderBy: { code: 'asc' } },
          },
        },
      },
    });

    const puCap = puCapForTier(plan.coverage);

    for (const [lgaIndex, lga] of lgas.entries()) {
      const lgaOutcome =
        meta.outcome === 'PENDING'
          ? ('PENDING' as SeedOutcome)
          : (meta.outcome as SeedOutcome) ?? pickSeedOutcome(lgaIndex + plan.code.charCodeAt(0));

      if (lgaOutcome === 'PENDING') continue;

      seededLgas += 1;
      let lgaPuSeeded = 0;
      const wardPuCounts = new Map<string, number>();

      for (const [wardIndex, ward] of lga.wards.entries()) {
        if (lgaPuSeeded >= puCap) break;

        const wardOutcome = wardOutcomeFor(lgaOutcome, wardIndex + lgaIndex);
        let wardPuSeeded = 0;

        for (const [puPos, pu] of ward.pollingUnits.entries()) {
          if (lgaPuSeeded >= puCap) break;

          const wardTotal = wardPuCounts.get(ward.id) ?? ward.pollingUnits.length;
          wardPuCounts.set(ward.id, wardTotal);
          const status = puStatusForCoverage(plan.coverage, puPos, wardTotal);
          let puOutcome: SeedOutcome = wardOutcome;
          if (puPos % 7 === 0) puOutcome = 'TIE';
          else if (puPos % 9 === 0) puOutcome = wardOutcome.includes('WIN') ? 'LOSS' : 'WIN';

          await seedPollingUnitResult(prisma, campaignId, contestId, {
            puId: pu.id,
            index: puIndex,
            partyCodes,
            status,
            outcome: puOutcome,
            figureProfile: puPos % 11 === 0 ? 'PARTY_MISMATCH' : 'MATCH',
            submittedById: actors.puOfficerId,
            approvedById: actors.wardOfficerId,
            includeEc8a: status !== 'DRAFT',
            hoursAgo: 2 + (puPos % 14),
          });
          puIndex += 1;
          seededPus += 1;
          lgaPuSeeded += 1;
          wardPuSeeded += 1;
        }

        if (wardPuSeeded === 0) continue;

        const wardStatus =
          wardIndex % 5 === 1 ? ('SUBMITTED' as const) : wardIndex % 7 === 2 ? ('REJECTED' as const) : ('APPROVED' as const);

        await seedWardRollupFromPus(prisma, campaignId, contestId, ward.id, partyCodes, {
          status: wardStatus,
          approvedOnly: true,
          submittedById: actors.wardOfficerId,
          approvedById: actors.lgaOfficerId,
        });
        seededWards += 1;
      }

      await seedLgaRollupFromWards(prisma, campaignId, contestId, lga.id, partyCodes, {
        status: lgaIndex % 4 === 0 ? 'SUBMITTED' : 'APPROVED',
        approvedOnly: true,
      });
    }

    // Incidents across selected LGAs in this state
    const incidentLgas = await prisma.lGA.findMany({
      where: { stateId: state.id },
      orderBy: { name: 'asc' },
      skip: plan.lgaCount,
      take: plan.incidentLgas,
      select: {
        id: true,
        name: true,
        wards: {
          take: 1,
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            pollingUnits: { take: 3, orderBy: { code: 'asc' }, select: { id: true, code: true } },
          },
        },
      },
    });

    const reporterId =
      actors.reporterIds.find((id) => id) ?? actors.directorId;

    for (const [lgaIndex, lga] of incidentLgas.entries()) {
      const ward = lga.wards[0];
      if (!ward) continue;
      const pu = ward.pollingUnits[lgaIndex % ward.pollingUnits.length];
      if (!pu) continue;

      for (let n = 0; n < 1 + (lgaIndex % 2); n += 1) {
        const spec = INCIDENT_SPECS[(lgaIndex + n) % INCIDENT_SPECS.length]!;
        const title = `${state.name} · ${spec.type.replace(/_/g, ' ')} @ ${pu.code}${n ? ` (${n + 1})` : ''}`;
        await prisma.fieldReport.deleteMany({ where: { campaignId, title } });
        await prisma.fieldReport.create({
          data: {
            campaignId,
            reportedById: reporterId,
            type: FieldReportType.INCIDENT,
            incidentType: spec.type,
            incidentSeverity: spec.severity,
            title,
            description: `Demo incident — ${state.name} · ${lga.name} · ${ward.name}.`,
            wardId: ward.id,
            pollingUnitId: pu.id,
            isUrgent: spec.urgent,
            status: FieldReportStatus.OPEN,
            photoUrls: [],
          },
        });
        seededIncidents += 1;
      }
    }
  }

  return { seededPus, seededWards, seededLgas, seededIncidents };
}

/** Full ward/LGA review workflow on any LGA (FCT demo or Jigawa Hadejia). */
export { seedLgaCollationTree };
