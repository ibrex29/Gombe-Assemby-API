import type { Prisma, PrismaClient } from '../src/generated/client';
import {
  ScopeType,
  CollationLevel,
  CollationResultStatus,
  CollationActionType,
} from '../src/generated/client';
import { arithmeticVerification } from '../../src/modules/collation/ocr-verification';

type PartyTotals = Record<string, number>;
type PuStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
type RollupStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
export type SeedOutcome =
  | 'WIN'
  | 'LOSS'
  | 'TIE'
  | 'CLOSE_WIN'
  | 'CLOSE_LOSS'
  | 'LANDSLIDE_WIN'
  | 'LANDSLIDE_LOSS';

function sumPartyMaps(values: PartyTotals[]): PartyTotals {
  if (values.length === 0) return {};
  const codes = [...new Set(values.flatMap((entry) => Object.keys(entry)))];
  const totals: PartyTotals = Object.fromEntries(codes.map((code) => [code, 0]));
  for (const entry of values) {
    for (const code of codes) {
      totals[code] = (totals[code] ?? 0) + (entry[code] ?? 0);
    }
  }
  return totals;
}

/** Deterministic sample votes — major parties lead; others share remainder */
export function generateSamplePartyResults(index: number, partyCodes: string[]): PartyTotals {
  return generateOutcomePartyResults('WIN', index, partyCodes);
}

/**
 * Build party totals with an explicit APC outcome so Situation Room win/loss
 * heatmaps are easy to demo (wins, losses, ties, landslides, close races).
 */
export function generateOutcomePartyResults(
  outcome: SeedOutcome,
  index: number,
  partyCodes: string[],
  clientParty = 'APC',
): PartyTotals {
  const registered = 420 + (index * 41) % 680;
  const turnout = 0.52 + (index % 9) * 0.035;
  const votesCast = Math.max(80, Math.round(registered * turnout));

  const shares: Record<string, number> = {};
  switch (outcome) {
    case 'LANDSLIDE_WIN':
      shares.APC = 0.58;
      shares.PDP = 0.18;
      shares.NNPP = 0.1;
      shares.LP = 0.05;
      break;
    case 'WIN':
      shares.APC = 0.42;
      shares.PDP = 0.28;
      shares.NNPP = 0.12;
      shares.LP = 0.06;
      break;
    case 'CLOSE_WIN':
      shares.APC = 0.36;
      shares.PDP = 0.34;
      shares.NNPP = 0.12;
      shares.LP = 0.06;
      break;
    case 'TIE':
      shares.APC = 0.34;
      shares.PDP = 0.34;
      shares.NNPP = 0.14;
      shares.LP = 0.07;
      break;
    case 'CLOSE_LOSS':
      shares.APC = 0.33;
      shares.PDP = 0.36;
      shares.NNPP = 0.13;
      shares.LP = 0.06;
      break;
    case 'LOSS':
      shares.APC = 0.26;
      shares.PDP = 0.4;
      shares.NNPP = 0.16;
      shares.LP = 0.07;
      break;
    case 'LANDSLIDE_LOSS':
      shares.APC = 0.18;
      shares.PDP = 0.52;
      shares.NNPP = 0.14;
      shares.LP = 0.06;
      break;
  }

  // Rotate which opposition leads on some losses (PDP vs NNPP)
  if ((outcome === 'LOSS' || outcome === 'LANDSLIDE_LOSS' || outcome === 'CLOSE_LOSS') && index % 5 === 0) {
    const pdp = shares.PDP ?? 0.35;
    const nnpp = shares.NNPP ?? 0.12;
    shares.PDP = nnpp;
    shares.NNPP = pdp;
  }

  const results: PartyTotals = {};
  let remaining = votesCast;
  const ordered = [...partyCodes];

  for (let i = 0; i < ordered.length; i++) {
    const code = ordered[i]!;
    if (i === ordered.length - 1) {
      results[code] = Math.max(0, remaining);
      break;
    }
    const base = shares[code] ?? 0.012 + (i % 6) * 0.002;
    let votes = Math.round(votesCast * base);
    // Keep exact APC/PDP equality on ties
    if (outcome === 'TIE' && code === 'PDP' && clientParty === 'APC') {
      votes = results.APC ?? votes;
    }
    results[code] = votes;
    remaining -= votes;
  }

  // Safety: ensure intended leader actually leads after rounding
  const apc = results[clientParty] ?? 0;
  if (outcome === 'WIN' || outcome === 'CLOSE_WIN' || outcome === 'LANDSLIDE_WIN') {
    const rival = Math.max(
      0,
      ...partyCodes.filter((c) => c !== clientParty).map((c) => results[c] ?? 0),
    );
    if (apc <= rival) results[clientParty] = rival + 8 + (index % 5);
  }
  if (outcome === 'LOSS' || outcome === 'CLOSE_LOSS' || outcome === 'LANDSLIDE_LOSS') {
    const rivalCode = partyCodes.find((c) => c !== clientParty && (results[c] ?? 0) > 0) ?? 'PDP';
    const rival = results[rivalCode] ?? 0;
    if (apc >= rival) {
      results[rivalCode] = apc + 11 + (index % 7);
    }
  }
  if (outcome === 'TIE') {
    const rivalCode = partyCodes.includes('PDP') ? 'PDP' : partyCodes.find((c) => c !== clientParty);
    if (rivalCode) results[rivalCode] = results[clientParty] ?? 0;
  }

  return results;
}

/** Pick a varied outcome for demo seed rows. */
export function pickSeedOutcome(index: number): SeedOutcome {
  const cycle: SeedOutcome[] = [
    'WIN',
    'LOSS',
    'CLOSE_WIN',
    'LANDSLIDE_LOSS',
    'WIN',
    'CLOSE_LOSS',
    'TIE',
    'LOSS',
    'LANDSLIDE_WIN',
    'LOSS',
    'WIN',
    'CLOSE_LOSS',
    'LANDSLIDE_LOSS',
    'WIN',
    'TIE',
  ];
  return cycle[index % cycle.length]!;
}

/** Explicit LGA outcome map for statewide Situation Room testing. */
export const LGA_OUTCOME_OVERRIDES: Record<string, SeedOutcome | 'PENDING'> = {
  // APC strongholds
  Auyo: 'LANDSLIDE_WIN',
  Hadejia: 'WIN',
  KafinHausa: 'WIN',
  'Kafin Hausa': 'WIN',
  Kaugama: 'CLOSE_WIN',
  MalamMadori: 'WIN',
  'Malam Madori': 'WIN',
  Birniwa: 'WIN',
  Biriniwa: 'WIN',
  Guri: 'CLOSE_WIN',
  // Competitive / APC struggles
  Dutse: 'LANDSLIDE_LOSS',
  Gumel: 'LOSS',
  Ringim: 'CLOSE_LOSS',
  Kazaure: 'LOSS',
  'Birnin Kudu': 'LANDSLIDE_LOSS',
  Jahun: 'LOSS',
  Gwaram: 'CLOSE_LOSS',
  Babura: 'LOSS',
  Taura: 'CLOSE_LOSS',
  Kiyawa: 'LOSS',
  Maigatari: 'LANDSLIDE_LOSS',
  Roni: 'LOSS',
  Garki: 'CLOSE_LOSS',
  SuleTankarkar: 'LOSS',
  'Sule Tankarkar': 'LOSS',
  // Ties + unfinished
  Buji: 'TIE',
  Gwiwa: 'TIE',
  Yankwashi: 'PENDING',
  Gagarawa: 'PENDING',
  Miga: 'CLOSE_WIN',
  'Kiri Kasama': 'WIN',
  Kirikasamma: 'WIN',
};

export type SeedFigureProfile =
  | 'MATCH'
  | 'PARTY_MISMATCH'
  | 'USED_MISMATCH'
  | 'ACCREDITED_OVER'
  | 'INCOMPLETE';

interface SeedPuResultInput {
  puId: string;
  index: number;
  partyCodes: string[];
  status: PuStatus;
  outcome?: SeedOutcome;
  partyResults?: PartyTotals;
  submittedById?: string;
  approvedById?: string;
  rejectionReason?: string;
  includeEc8a?: boolean;
  hoursAgo?: number;
  figureProfile?: SeedFigureProfile;
}

function partySum(partyResults: PartyTotals): number {
  return Object.values(partyResults).reduce((sum, n) => sum + (n ?? 0), 0);
}

/** Full EC8A identities, then optional mutations for ward/LGA verification demos. */
export function buildSeedEc8aSheet(partyResults: PartyTotals, profile: SeedFigureProfile = 'MATCH') {
  const valid = partySum(partyResults);
  const spoiled = 1;
  const rejected = 3;
  const used = spoiled + rejected + valid;
  const unused = 72;
  const issued = used + unused;
  const registered = issued + 20;
  const accredited = used;

  const match = {
    partyResults,
    votesCast: valid,
    registeredVoters: registered,
    accreditedVoters: accredited,
    ballotPapersIssued: issued,
    unusedBallotPapers: unused,
    spoiledBallotPapers: spoiled,
    invalidVotes: rejected,
    usedBallotPapers: used,
  };

  switch (profile) {
    case 'PARTY_MISMATCH':
      return { ...match, votesCast: Math.max(0, valid - 17) };
    case 'USED_MISMATCH':
      return { ...match, usedBallotPapers: Math.max(0, used - 11) };
    case 'ACCREDITED_OVER':
      return { ...match, accreditedVoters: registered + 25 };
    case 'INCOMPLETE':
      return {
        partyResults,
        votesCast: valid,
        registeredVoters: null as number | null,
        accreditedVoters: null as number | null,
        ballotPapersIssued: null as number | null,
        unusedBallotPapers: null as number | null,
        spoiledBallotPapers: null as number | null,
        invalidVotes: null as number | null,
        usedBallotPapers: null as number | null,
      };
    default:
      return match;
  }
}

function atafiVerificationScenario(
  puCode: string,
  puPos: number,
): { status: PuStatus; figureProfile: SeedFigureProfile; includeEc8a: boolean } {
  if (puCode === '17-13-01-001' || puPos === 0) {
    return { status: 'SUBMITTED', figureProfile: 'MATCH', includeEc8a: true };
  }
  if (puCode === '17-13-01-002' || puPos === 1) {
    return { status: 'SUBMITTED', figureProfile: 'PARTY_MISMATCH', includeEc8a: true };
  }
  if (puCode === '17-13-01-003' || puPos === 2) {
    return { status: 'DRAFT', figureProfile: 'INCOMPLETE', includeEc8a: false };
  }
  if (puCode === '17-13-01-004' || puPos === 3) {
    return { status: 'SUBMITTED', figureProfile: 'USED_MISMATCH', includeEc8a: true };
  }
  if (puCode === '17-13-01-005' || puPos === 4) {
    return { status: 'SUBMITTED', figureProfile: 'ACCREDITED_OVER', includeEc8a: true };
  }
  if (puPos === 5) {
    return { status: 'REJECTED', figureProfile: 'PARTY_MISMATCH', includeEc8a: true };
  }
  return { status: 'APPROVED', figureProfile: 'MATCH', includeEc8a: true };
}

interface ActorIds {
  puOfficerId?: string;
  wardOfficerId?: string;
  lgaOfficerId?: string;
}

async function writeSeedActionLog(
  prisma: PrismaClient,
  input: {
    campaignId: string;
    collationResultId: string;
    action: CollationActionType;
    actorId: string;
    fromStatus?: CollationResultStatus | null;
    toStatus: CollationResultStatus;
    comment?: string | null;
    hoursAgo?: number;
  },
) {
  const createdAt = new Date(Date.now() - (input.hoursAgo ?? 1) * 60 * 60 * 1000);

  const existing = await prisma.collationActionLog.findFirst({
    where: {
      collationResultId: input.collationResultId,
      action: input.action,
      actorId: input.actorId,
    },
  });
  if (existing) return existing;

  return prisma.collationActionLog.create({
    data: {
      campaignId: input.campaignId,
      collationResultId: input.collationResultId,
      action: input.action,
      actorId: input.actorId,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus,
      comment: input.comment ?? null,
      createdAt,
      metadata: { seeded: true },
    },
  });
}

export async function seedPollingUnitResult(
  prisma: PrismaClient,
  campaignId: string,
  input: SeedPuResultInput,
) {
  const partyResults =
    input.partyResults ??
    generateOutcomePartyResults(input.outcome ?? pickSeedOutcome(input.index), input.index, input.partyCodes);
  const figureProfile = input.figureProfile ?? 'MATCH';
  const sheet = buildSeedEc8aSheet(partyResults, figureProfile);
  const hoursAgo = input.hoursAgo ?? 6 + (input.index % 10);
  const submittedAt =
    input.status === 'DRAFT' ? null : new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
  const approvedAt =
    input.status === 'APPROVED' || input.status === 'REJECTED'
      ? new Date(Date.now() - Math.max(1, hoursAgo - 2) * 60 * 60 * 1000)
      : null;
  const includeEc8a = input.includeEc8a !== false && input.status !== 'DRAFT' && figureProfile !== 'INCOMPLETE';
  const ec8aPhotoUrls = includeEc8a
    ? [`/uploads/seed-ec8a-${input.puId.slice(-8)}.png`]
    : [];
  const verification = arithmeticVerification({ ...sheet, ec8aPhotoUrls });

  const payload = {
    ...sheet,
    ocrVerification: verification as unknown as Prisma.InputJsonValue,
    ocrVerifiedAt: new Date(verification.verifiedAt),
    status: input.status as CollationResultStatus,
    submittedById: input.status === 'DRAFT' ? null : (input.submittedById ?? null),
    submittedAt,
    approvedById:
      input.status === 'APPROVED' || input.status === 'REJECTED'
        ? (input.approvedById ?? null)
        : null,
    approvedAt,
    rejectionReason: input.status === 'REJECTED' ? (input.rejectionReason ?? 'Returned for correction') : null,
    approvalComment:
      input.status === 'APPROVED' ? 'Verified against EC8A — figures match' : null,
    ec8aPhotoUrls,
  };

  const result = await prisma.collationResult.upsert({
    where: {
      campaignId_level_scopeType_scopeId: {
        campaignId,
        level: CollationLevel.POLLING_UNIT,
        scopeType: ScopeType.POLLING_UNIT,
        scopeId: input.puId,
      },
    },
    update: payload,
    create: {
      campaignId,
      level: CollationLevel.POLLING_UNIT,
      scopeType: ScopeType.POLLING_UNIT,
      scopeId: input.puId,
      ...payload,
    },
  });

  return { partyResults, resultId: result.id, status: input.status };
}

export async function seedWardRollupFromPus(
  prisma: PrismaClient,
  campaignId: string,
  wardId: string,
  partyCodes: string[],
  options: {
    status?: RollupStatus;
    submittedById?: string;
    approvedById?: string;
    rejectionReason?: string;
    /** Only sum APPROVED child PUs (matches production rollup) */
    approvedOnly?: boolean;
    flaggedPollingUnitIds?: string[];
  } = {},
) {
  const status = options.status ?? 'APPROVED';
  const approvedOnly = options.approvedOnly ?? true;

  const pus = await prisma.pollingUnit.findMany({
    where: { wardId },
    select: { id: true },
  });

  const puResults = await prisma.collationResult.findMany({
    where: {
      campaignId,
      level: CollationLevel.POLLING_UNIT,
      scopeId: { in: pus.map((pu) => pu.id) },
      ...(approvedOnly ? { status: CollationResultStatus.APPROVED } : {}),
    },
    select: {
      partyResults: true,
      votesCast: true,
      registeredVoters: true,
      accreditedVoters: true,
    },
  });

  if (puResults.length === 0 && status !== 'DRAFT') return null;

  const partyResults = sumPartyMaps(
    puResults.map((result) => (result.partyResults ?? {}) as PartyTotals),
  );
  const votesCast = puResults.reduce((sum, result) => sum + (result.votesCast ?? 0), 0);
  const registeredVoters = puResults.reduce((sum, result) => sum + (result.registeredVoters ?? 0), 0);
  const accreditedVoters = puResults.reduce((sum, result) => sum + (result.accreditedVoters ?? 0), 0);
  const submittedAt =
    status === 'SUBMITTED' || status === 'APPROVED' || status === 'REJECTED'
      ? new Date(Date.now() - 8 * 60 * 60 * 1000)
      : null;
  const approvedAt =
    status === 'APPROVED' || status === 'REJECTED'
      ? new Date(Date.now() - 3 * 60 * 60 * 1000)
      : null;

  const payload = {
    partyResults,
    votesCast,
    registeredVoters,
    accreditedVoters,
    status: status as CollationResultStatus,
    submittedById: options.submittedById ?? null,
    submittedAt,
    approvedById: options.approvedById ?? null,
    approvedAt,
    rejectionReason:
      status === 'REJECTED'
        ? (options.rejectionReason ?? 'Returned to ward for correction')
        : null,
    approvalComment: null,
    flaggedPollingUnitIds:
      status === 'REJECTED' ? (options.flaggedPollingUnitIds ?? []) : [],
  };

  const result = await prisma.collationResult.upsert({
    where: {
      campaignId_level_scopeType_scopeId: {
        campaignId,
        level: CollationLevel.WARD,
        scopeType: ScopeType.WARD,
        scopeId: wardId,
      },
    },
    update: payload,
    create: {
      campaignId,
      level: CollationLevel.WARD,
      scopeType: ScopeType.WARD,
      scopeId: wardId,
      ...payload,
    },
  });

  return { partyResults, resultId: result.id, status };
}

export async function seedLgaRollupFromWards(
  prisma: PrismaClient,
  campaignId: string,
  lgaId: string,
  partyCodes: string[],
  options: {
    status?: RollupStatus;
    approvedOnly?: boolean;
  } = {},
) {
  const status = options.status ?? 'APPROVED';
  const approvedOnly = options.approvedOnly ?? true;

  const wards = await prisma.ward.findMany({
    where: { lgaId },
    select: { id: true },
  });

  const wardResults = await prisma.collationResult.findMany({
    where: {
      campaignId,
      level: CollationLevel.WARD,
      scopeId: { in: wards.map((ward) => ward.id) },
      ...(approvedOnly ? { status: CollationResultStatus.APPROVED } : {}),
    },
    select: { partyResults: true, votesCast: true },
  });

  let partyResults: PartyTotals;
  let votesCast: number;

  if (wardResults.length === 0) {
    partyResults = generateSamplePartyResults(wards.length, partyCodes);
    votesCast = Object.values(partyResults).reduce((sum, n) => sum + n, 0);
  } else {
    partyResults = sumPartyMaps(
      wardResults.map((result) => (result.partyResults ?? {}) as PartyTotals),
    );
    votesCast = wardResults.reduce((sum, result) => sum + (result.votesCast ?? 0), 0);
  }

  await prisma.collationResult.upsert({
    where: {
      campaignId_level_scopeType_scopeId: {
        campaignId,
        level: CollationLevel.LGA,
        scopeType: ScopeType.LGA,
        scopeId: lgaId,
      },
    },
    update: { partyResults, votesCast, status: status as CollationResultStatus },
    create: {
      campaignId,
      level: CollationLevel.LGA,
      scopeType: ScopeType.LGA,
      scopeId: lgaId,
      partyResults,
      votesCast,
      status: status as CollationResultStatus,
    },
  });

  return partyResults;
}

/**
 * Scenario matrix across Hadejia LGA for end-to-end testing:
 *
 * ATAFI (demo ward / ward.officer@…):
 *   - Mix of DRAFT / SUBMITTED / REJECTED / APPROVED PUs
 *   - Demo PU 17-13-01-001: SUBMITTED (awaiting ward) with EC8A
 *   - Ward rollup REJECTED by LGA (reason visible on Ward Review)
 *
 * Incomplete ward (first non-ATAFI if ready):
 *   - Some PUs not fully approved → live partial ward totals still publish
 *
 * Other Hadejia wards:
 *   - Mostly full APPROVED PUs + a few LGA correction requests
 */
export async function seedLgaCollationTree(
  prisma: PrismaClient,
  campaignId: string,
  lgaId: string,
  partyCodes: string[],
  actors: ActorIds = {},
) {
  const wards = await prisma.ward.findMany({
    where: { lgaId },
    include: { pollingUnits: { orderBy: { code: 'asc' } } },
    orderBy: { name: 'asc' },
  });

  const puOfficerId = actors.puOfficerId;
  const wardOfficerId = actors.wardOfficerId;
  const lgaOfficerId = actors.lgaOfficerId;

  let puIndex = 0;
  let seededPus = 0;
  let incompleteWardId: string | null = null;
  let atafiWardId: string | null = null;
  const atafiFlaggedPuIds: string[] = [];

  for (const [wardIndex, ward] of wards.entries()) {
    const isAtafi = ward.name.toUpperCase().includes('ATAFI');
    if (isAtafi) atafiWardId = ward.id;

    // First non-ATAFI ward with 4+ PUs = incomplete readiness scenario
    if (!isAtafi && !incompleteWardId && ward.pollingUnits.length >= 4) {
      incompleteWardId = ward.id;
    }

    // Whole-ward electoral story for Situation Room (APC win/loss mix)
    const wardOutcome: SeedOutcome = isAtafi
      ? 'CLOSE_WIN'
      : ward.id === incompleteWardId
        ? 'CLOSE_LOSS'
        : pickSeedOutcome(wardIndex + 3);

    for (const [puPos, pu] of ward.pollingUnits.entries()) {
      const atafi = isAtafi ? atafiVerificationScenario(pu.code, puPos) : null;
      const status =
        atafi?.status ??
        resolvePuStatus({
          isAtafi: false,
          isIncompleteWard: ward.id === incompleteWardId,
          isDemoPu: false,
          puPos,
          wardPuCount: ward.pollingUnits.length,
          puIndex,
        });
      const figureProfile = atafi?.figureProfile ?? 'MATCH';
      const includeEc8a = atafi?.includeEc8a ?? status !== 'DRAFT';

      // Within a ward, mostly follow wardOutcome; sprinkle opposite pockets
      let puOutcome: SeedOutcome = wardOutcome;
      if (puPos % 6 === 5) {
        puOutcome =
          wardOutcome === 'WIN' || wardOutcome === 'CLOSE_WIN' || wardOutcome === 'LANDSLIDE_WIN'
            ? 'LOSS'
            : 'WIN';
      } else if (puPos % 8 === 4) {
        puOutcome = 'TIE';
      }

      const seeded = await seedPollingUnitResult(prisma, campaignId, {
        puId: pu.id,
        index: puIndex,
        partyCodes,
        status,
        outcome: puOutcome,
        figureProfile,
        submittedById: puOfficerId,
        approvedById: wardOfficerId,
        rejectionReason:
          status === 'REJECTED'
            ? 'EC8A total does not match entered party votes — please recheck'
            : undefined,
        includeEc8a,
        hoursAgo: 4 + (puPos % 12),
      });

      if (
        isAtafi &&
        status === 'SUBMITTED' &&
        (figureProfile === 'PARTY_MISMATCH' || figureProfile === 'USED_MISMATCH')
      ) {
        atafiFlaggedPuIds.push(pu.id);
      }

      if (puOfficerId && status !== 'DRAFT') {
        await writeSeedActionLog(prisma, {
          campaignId,
          collationResultId: seeded.resultId,
          action: CollationActionType.SUBMITTED,
          actorId: puOfficerId,
          fromStatus: CollationResultStatus.DRAFT,
          toStatus: CollationResultStatus.SUBMITTED,
          hoursAgo: 10,
        });
      }
      if (wardOfficerId && status === 'APPROVED') {
        await writeSeedActionLog(prisma, {
          campaignId,
          collationResultId: seeded.resultId,
          action: CollationActionType.APPROVED,
          actorId: wardOfficerId,
          fromStatus: CollationResultStatus.SUBMITTED,
          toStatus: CollationResultStatus.APPROVED,
          comment: 'Verified against EC8A',
          hoursAgo: 6,
        });
      }
      if (wardOfficerId && status === 'REJECTED') {
        await writeSeedActionLog(prisma, {
          campaignId,
          collationResultId: seeded.resultId,
          action: CollationActionType.REJECTED,
          actorId: wardOfficerId,
          fromStatus: CollationResultStatus.SUBMITTED,
          toStatus: CollationResultStatus.REJECTED,
          comment: 'EC8A total does not match entered party votes — please recheck',
          hoursAgo: 5,
        });
      }

      puIndex += 1;
      seededPus += 1;
    }

    // Ward rollup status
    let wardStatus: RollupStatus = 'APPROVED';
    let rejectionReason: string | undefined;

    if (isAtafi) {
      // Primary demo: LGA returned the whole ward (ward-level return, not PU Returned filter)
      wardStatus = 'REJECTED';
      rejectionReason =
        'LGA review: recheck APC/PDP split on returned PUs and confirm EC8A photos before resubmitting';
    } else if (ward.id === incompleteWardId) {
      // Partial ward still publishes approved PUs to Situation Room
      wardStatus = 'APPROVED';
    } else if (wardIndex % 11 === 4) {
      wardStatus = 'REJECTED';
      rejectionReason = 'LGA requested correction: incomplete documentation on ward summary sheet';
    } else {
      wardStatus = 'APPROVED';
    }

    const wardRollup = await seedWardRollupFromPus(prisma, campaignId, ward.id, partyCodes, {
      status: wardStatus,
      approvedOnly: true,
      submittedById: wardOfficerId,
      approvedById: lgaOfficerId,
      rejectionReason,
      flaggedPollingUnitIds: isAtafi ? atafiFlaggedPuIds : undefined,
    });

    if (wardRollup && wardOfficerId) {
      await writeSeedActionLog(prisma, {
        campaignId,
        collationResultId: wardRollup.resultId,
        action: CollationActionType.SUBMITTED,
        actorId: wardOfficerId,
        fromStatus: CollationResultStatus.DRAFT,
        toStatus: CollationResultStatus.SUBMITTED,
        hoursAgo: 9,
      });
    }
    if (wardRollup && lgaOfficerId && wardStatus === 'APPROVED') {
      await writeSeedActionLog(prisma, {
        campaignId,
        collationResultId: wardRollup.resultId,
        action: CollationActionType.COMMENTED,
        actorId: lgaOfficerId,
        fromStatus: CollationResultStatus.APPROVED,
        toStatus: CollationResultStatus.APPROVED,
        comment: 'Figures look consistent with the EC8A photos',
        hoursAgo: 2,
      });
    }
    if (wardRollup && lgaOfficerId && wardStatus === 'REJECTED') {
      await writeSeedActionLog(prisma, {
        campaignId,
        collationResultId: wardRollup.resultId,
        action: CollationActionType.REJECTED,
        actorId: lgaOfficerId,
        fromStatus: CollationResultStatus.APPROVED,
        toStatus: CollationResultStatus.REJECTED,
        comment: rejectionReason,
        hoursAgo: 1,
      });
    }
  }

  // LGA rollup from ward-approved PUs — live snapshot, no LGA/state approval
  await seedLgaRollupFromWards(prisma, campaignId, lgaId, partyCodes, {
    status: 'APPROVED',
    approvedOnly: true,
  });

  return {
    seededPus,
    seededWards: wards.length,
    atafiWardId,
    incompleteWardId,
  };
}

/** @deprecated Use seedLgaCollationTree */
export async function seedHadejiaCollationResults(
  prisma: PrismaClient,
  campaignId: string,
  hadejiaLgaId: string,
  partyCodes: string[],
  actors: ActorIds = {},
) {
  return seedLgaCollationTree(prisma, campaignId, hadejiaLgaId, partyCodes, actors);
}

function resolvePuStatus(input: {
  isAtafi: boolean;
  isIncompleteWard: boolean;
  isDemoPu: boolean;
  puPos: number;
  wardPuCount: number;
  puIndex: number;
}): PuStatus {
  if (input.isDemoPu) {
    // Ward officer sees this first in default “Awaiting review”
    return 'SUBMITTED';
  }

  if (input.isAtafi) {
    // Spread statuses within ATAFI for ward filters / dashboard
    if (input.puPos === 1) return 'REJECTED';
    if (input.puPos === 2) return 'DRAFT';
    if (input.puPos === 3) return 'SUBMITTED';
    return 'APPROVED';
  }

  if (input.isIncompleteWard) {
    // Leave several PUs incomplete so LGA readiness gate fails
    if (input.puPos === 0) return 'APPROVED';
    if (input.puPos === 1) return 'SUBMITTED';
    if (input.puPos === 2) return 'DRAFT';
    if (input.puPos === 3) return 'REJECTED';
    return 'APPROVED';
  }

  // Default bulk: nearly all approved so LGA has volume of work
  if (input.puIndex % 23 === 0) return 'SUBMITTED';
  if (input.puIndex % 29 === 0) return 'REJECTED';
  return 'APPROVED';
}

export async function seedStateLgaSummaries(
  prisma: PrismaClient,
  campaignId: string,
  stateId: string,
  partyCodes: string[],
) {
  const lgas = await prisma.lGA.findMany({
    where: { stateId },
    orderBy: { name: 'asc' },
  });

  const summary = {
    win: 0,
    loss: 0,
    tie: 0,
    pending: 0,
  };

  for (const [index, lga] of lgas.entries()) {
    const override = LGA_OUTCOME_OVERRIDES[lga.name] ?? pickSeedOutcome(index + 17);
    const existing = await prisma.collationResult.findFirst({
      where: {
        campaignId,
        level: CollationLevel.LGA,
        scopeId: lga.id,
      },
    });

    // Keep Hadejia rollup from detailed ward seed unless missing
    if (existing && lga.name.toUpperCase() === 'HADEJIA') {
      summary.win += 1;
      continue;
    }

    if (override === 'PENDING') {
      if (existing) {
        await prisma.collationResult.delete({ where: { id: existing.id } });
      }
      summary.pending += 1;
      continue;
    }

    const partyResults = generateOutcomePartyResults(override, index + 10, partyCodes);
    const votesCast = Object.values(partyResults).reduce((sum, n) => sum + n, 0);
    const status =
      index % 9 === 0 ? CollationResultStatus.SUBMITTED : CollationResultStatus.APPROVED;

    if (existing) {
      await prisma.collationResult.update({
        where: { id: existing.id },
        data: { partyResults, votesCast, status },
      });
    } else {
      await prisma.collationResult.create({
        data: {
          campaignId,
          level: CollationLevel.LGA,
          scopeType: ScopeType.LGA,
          scopeId: lga.id,
          partyResults,
          votesCast,
          status,
        },
      });
    }

    if (override === 'TIE') summary.tie += 1;
    else if (
      override === 'LOSS' ||
      override === 'CLOSE_LOSS' ||
      override === 'LANDSLIDE_LOSS'
    ) {
      summary.loss += 1;
    } else summary.win += 1;
  }

  return summary;
}

/**
 * Deep seed for competitive / opposition LGAs so Situation Room drill-down
 * shows ward + PU losses (not only LGA choropleth).
 */
export async function seedCompetitiveLgaTrees(
  prisma: PrismaClient,
  campaignId: string,
  stateId: string,
  partyCodes: string[],
  actors: ActorIds = {},
) {
  const targetNames = [
    'Dutse',
    'Gumel',
    'Ringim',
    'Kazaure',
    'Birnin Kudu',
    'Jahun',
    'Gwaram',
    'Babura',
    'Maigatari',
    'Taura',
  ];

  let seededPus = 0;
  let seededWards = 0;
  let seededLgas = 0;
  let puIndex = 5000;

  for (const [lgaPos, name] of targetNames.entries()) {
    const lga = await prisma.lGA.findFirst({
      where: { stateId, name: { equals: name, mode: 'insensitive' } },
      include: {
        wards: {
          include: { pollingUnits: { orderBy: { code: 'asc' }, take: 12 } },
          orderBy: { name: 'asc' },
        },
      },
    });
    if (!lga) continue;

    const lgaOutcome =
      (LGA_OUTCOME_OVERRIDES[lga.name] as SeedOutcome | undefined) ??
      (lgaPos % 2 === 0 ? 'LANDSLIDE_LOSS' : 'LOSS');
    if (lgaOutcome === ('PENDING' as string)) continue;

    seededLgas += 1;

    for (const [wardIndex, ward] of lga.wards.entries()) {
      // Mix: most wards follow LGA loss story; a few APC pockets survive
      const wardOutcome: SeedOutcome =
        wardIndex % 5 === 0
          ? 'CLOSE_WIN'
          : wardIndex % 7 === 0
            ? 'TIE'
            : wardIndex % 3 === 0
              ? 'LANDSLIDE_LOSS'
              : lgaOutcome === 'LANDSLIDE_LOSS'
                ? 'LOSS'
                : 'CLOSE_LOSS';

      for (const [puPos, pu] of ward.pollingUnits.entries()) {
        const puOutcome: SeedOutcome =
          puPos % 7 === 0 ? 'WIN' : puPos % 5 === 0 ? 'TIE' : wardOutcome;
        const status: PuStatus =
          puPos === ward.pollingUnits.length - 1 && wardIndex % 4 === 1
            ? 'SUBMITTED'
            : 'APPROVED';

        await seedPollingUnitResult(prisma, campaignId, {
          puId: pu.id,
          index: puIndex,
          partyCodes,
          status,
          outcome: puOutcome,
          figureProfile: puPos % 11 === 0 ? 'PARTY_MISMATCH' : 'MATCH',
          submittedById: actors.puOfficerId,
          approvedById: actors.wardOfficerId,
          includeEc8a: true,
          hoursAgo: 3 + (puPos % 8),
        });
        puIndex += 1;
        seededPus += 1;
      }

      const wardStatus: RollupStatus =
        wardIndex % 6 === 1 ? 'SUBMITTED' : 'APPROVED';
      await seedWardRollupFromPus(prisma, campaignId, ward.id, partyCodes, {
        status: wardStatus,
        approvedOnly: true,
        submittedById: actors.wardOfficerId,
        approvedById: actors.lgaOfficerId,
      });
      seededWards += 1;
    }

    await seedLgaRollupFromWards(prisma, campaignId, lga.id, partyCodes, {
      status: 'APPROVED',
      approvedOnly: true,
    });
  }

  return { seededLgas, seededWards, seededPus };
}

function scalePartyResults(results: PartyTotals, factor: number): PartyTotals {
  return Object.fromEntries(
    Object.entries(results).map(([code, votes]) => [code, Math.round(votes * factor)]),
  );
}

/**
 * National APC demo: STATE-level results for all 36+FCT, plus LGA heatmaps.
 * Does not invent hundreds of thousands of PU rows — Situation Room uses these rollups.
 */
export async function seedNationalSummaries(
  prisma: PrismaClient,
  campaignId: string,
  partyCodes: string[],
  stateOutcomes: Array<{ stateId: string; name: string; outcome: SeedOutcome }>,
) {
  const summary = { win: 0, loss: 0, tie: 0, pending: 0 };
  const nationalTotals: PartyTotals = {};

  for (const [stateIndex, row] of stateOutcomes.entries()) {
    if (row.outcome === 'PENDING') {
      const lgas = await prisma.lGA.findMany({
        where: { stateId: row.stateId },
        select: { id: true },
      });
      await prisma.collationResult.deleteMany({
        where: {
          campaignId,
          OR: [
            { level: CollationLevel.STATE, scopeId: row.stateId },
            { level: CollationLevel.LGA, scopeId: { in: lgas.map((l) => l.id) } },
          ],
        },
      });
      summary.pending += 1;
      continue;
    }

    const lgas = await prisma.lGA.findMany({
      where: { stateId: row.stateId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });

    const stateParties = scalePartyResults(
      generateOutcomePartyResults(row.outcome, stateIndex + 3, partyCodes),
      Math.max(8, lgas.length * 12),
    );
    const stateVotes = Object.values(stateParties).reduce((sum, n) => sum + n, 0);
    for (const [code, votes] of Object.entries(stateParties)) {
      nationalTotals[code] = (nationalTotals[code] ?? 0) + votes;
    }

    await prisma.collationResult.upsert({
      where: {
        campaignId_level_scopeType_scopeId: {
          campaignId,
          level: CollationLevel.STATE,
          scopeType: ScopeType.STATE,
          scopeId: row.stateId,
        },
      },
      update: {
        partyResults: stateParties,
        votesCast: stateVotes,
        status: CollationResultStatus.APPROVED,
      },
      create: {
        campaignId,
        level: CollationLevel.STATE,
        scopeType: ScopeType.STATE,
        scopeId: row.stateId,
        partyResults: stateParties,
        votesCast: stateVotes,
        status: CollationResultStatus.APPROVED,
      },
    });

    if (row.outcome === 'TIE') summary.tie += 1;
    else if (
      row.outcome === 'LOSS' ||
      row.outcome === 'CLOSE_LOSS' ||
      row.outcome === 'LANDSLIDE_LOSS'
    ) {
      summary.loss += 1;
    } else summary.win += 1;

    const lgaOutcomes: SeedOutcome[] = [
      row.outcome,
      row.outcome,
      row.outcome === 'WIN' ? 'CLOSE_WIN' : row.outcome,
      row.outcome === 'LOSS' ? 'CLOSE_LOSS' : row.outcome,
      'CLOSE_WIN',
      'CLOSE_LOSS',
      'TIE',
    ];

    for (const [lgaIndex, lga] of lgas.entries()) {
      if (lgaIndex % 17 === 0) continue;
      const lgaOutcome = lgaOutcomes[lgaIndex % lgaOutcomes.length]!;
      const lgaParties = scalePartyResults(
        generateOutcomePartyResults(lgaOutcome, lgaIndex + stateIndex * 17, partyCodes),
        9 + (lgaIndex % 6),
      );
      const lgaVotes = Object.values(lgaParties).reduce((sum, n) => sum + n, 0);
      await prisma.collationResult.upsert({
        where: {
          campaignId_level_scopeType_scopeId: {
            campaignId,
            level: CollationLevel.LGA,
            scopeType: ScopeType.LGA,
            scopeId: lga.id,
          },
        },
        update: {
          partyResults: lgaParties,
          votesCast: lgaVotes,
          status:
            lgaIndex % 11 === 0
              ? CollationResultStatus.SUBMITTED
              : CollationResultStatus.APPROVED,
        },
        create: {
          campaignId,
          level: CollationLevel.LGA,
          scopeType: ScopeType.LGA,
          scopeId: lga.id,
          partyResults: lgaParties,
          votesCast: lgaVotes,
          status:
            lgaIndex % 11 === 0
              ? CollationResultStatus.SUBMITTED
              : CollationResultStatus.APPROVED,
        },
      });
    }
  }

  const nationalVotes = Object.values(nationalTotals).reduce((sum, n) => sum + n, 0);
  await prisma.collationResult.upsert({
    where: {
      campaignId_level_scopeType_scopeId: {
        campaignId,
        level: CollationLevel.NATIONAL,
        scopeType: ScopeType.NATIONAL,
        scopeId: 'NGA',
      },
    },
    update: {
      partyResults: nationalTotals,
      votesCast: nationalVotes,
      status: CollationResultStatus.APPROVED,
    },
    create: {
      campaignId,
      level: CollationLevel.NATIONAL,
      scopeType: ScopeType.NATIONAL,
      scopeId: 'NGA',
      partyResults: nationalTotals,
      votesCast: nationalVotes,
      status: CollationResultStatus.APPROVED,
    },
  });

  return summary;
}
