import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ContestType } from '@electromon/shared';
import { PrismaService } from '../prisma/prisma.service';

export type ResolvedContest = {
  id: string;
  campaignId: string;
  type: ContestType;
  slug: string;
  label: string;
  irevElectionId: string | null;
  irevElectionLabel: string | null;
  isDefault: boolean;
};

export type ResolvedSeat = {
  id: string;
  code: string;
  name: string;
  lgaId: string | null;
  lgaName: string | null;
  wardIds: string[];
  wards: { id: string; name: string }[];
  irevElectionId: string | null;
};

type ContestStore = { contest: ResolvedContest; seat: ResolvedSeat | null };

const FALLBACK_GOV_ID = '6407d9bfce35006e92156f2e';

@Injectable()
export class ContestService {
  private readonly als = new AsyncLocalStorage<ContestStore>();

  constructor(private prisma: PrismaService) {}

  run<T>(contest: ResolvedContest, seatOrFn: ResolvedSeat | null | (() => T), fn?: () => T): T {
    if (typeof seatOrFn === 'function') {
      return this.als.run({ contest, seat: null }, seatOrFn);
    }
    return this.als.run({ contest, seat: seatOrFn }, fn!);
  }

  current(): ResolvedContest | null {
    return this.als.getStore()?.contest ?? null;
  }

  seat(): ResolvedSeat | null {
    return this.als.getStore()?.seat ?? null;
  }

  id(): string {
    const contest = this.current();
    if (!contest) {
      throw new Error('Contest is not resolved for this request');
    }
    return contest.id;
  }

  scope(campaignId: string) {
    return { campaignId, contestId: this.id() };
  }

  resultKey(
    campaignId: string,
    level: string,
    scopeType: string,
    scopeId: string,
  ) {
    return {
      campaignId_contestId_level_scopeType_scopeId: {
        campaignId,
        contestId: this.id(),
        level,
        scopeType,
        scopeId,
      },
    };
  }

  async list(campaignId: string): Promise<ResolvedContest[]> {
    const rows = await this.prisma.contest.findMany({
      where: { campaignId },
      orderBy: [{ isDefault: 'desc' }, { type: 'asc' }],
    });
    return rows.map(toResolved);
  }

  async active(campaignId: string, raw?: string | null): Promise<ResolvedContest> {
    const current = this.current();
    if (current && current.campaignId === campaignId && !raw) return current;
    return this.resolve(campaignId, raw);
  }

  async resolve(campaignId: string, raw?: string | null): Promise<ResolvedContest> {
    const locked = process.env.DEFAULT_CONTEST?.trim();
    const key = locked || raw?.trim();
    if (!key) {
      const fallback = await this.prisma.contest.findFirst({
        where: { campaignId, isDefault: true },
      });
      if (fallback) return toResolved(fallback);
      const any = await this.prisma.contest.findFirst({ where: { campaignId } });
      if (any) return toResolved(any);
      throw new NotFoundException('No contest is configured for this campaign');
    }

    const normalized = key.toLowerCase();
    const type =
      normalized === 'assembly' || normalized === 'sha' || normalized === 'house'
        ? ContestType.ASSEMBLY
        : normalized === 'governorship' || normalized === 'gov'
          ? ContestType.GOVERNORSHIP
          : null;

    const row = await this.prisma.contest.findFirst({
      where: {
        campaignId,
        OR: [
          { id: key },
          { slug: normalized },
          ...(type ? [{ type }] : []),
        ],
      },
    });
    if (!row) {
      throw new NotFoundException(`Unknown contest "${key}"`);
    }
    return toResolved(row);
  }

  async listSeats(campaignId: string): Promise<ResolvedSeat[]> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { stateId: true },
    });
    if (!campaign?.stateId) return [];
    const rows = await this.prisma.stateAssemblyConstituency.findMany({
      where: { stateId: campaign.stateId },
      include: {
        lga: { select: { id: true, name: true } },
        wards: { select: { id: true, name: true }, orderBy: { name: 'asc' } },
      },
      orderBy: { name: 'asc' },
    });
    return rows.map(toResolvedSeat);
  }

  async resolveSeat(campaignId: string, raw?: string | null): Promise<ResolvedSeat | null> {
    const key = raw?.trim();
    if (!key) return null;
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { stateId: true },
    });
    if (!campaign?.stateId) return null;
    const row = await this.prisma.stateAssemblyConstituency.findFirst({
      where: {
        stateId: campaign.stateId,
        OR: [
          { id: key },
          { code: { equals: key, mode: 'insensitive' } },
          { name: { equals: key, mode: 'insensitive' } },
        ],
      },
      include: {
        lga: { select: { id: true, name: true } },
        wards: { select: { id: true, name: true }, orderBy: { name: 'asc' } },
      },
    });
    if (!row) {
      throw new NotFoundException(`Unknown assembly seat "${key}"`);
    }
    return toResolvedSeat(row);
  }

  async ensurePantamiyyaContests(campaignId: string) {
    const gov = await this.prisma.contest.upsert({
      where: { campaignId_type: { campaignId, type: ContestType.GOVERNORSHIP } },
      update: { isDefault: true, slug: 'governorship', label: 'Governorship' },
      create: {
        campaignId,
        type: ContestType.GOVERNORSHIP,
        slug: 'governorship',
        label: 'Governorship',
        irevElectionId: process.env.IREV_ELECTION_ID?.trim() || FALLBACK_GOV_ID,
        irevElectionLabel:
          process.env.IREV_ELECTION_LABEL?.trim() || 'Gombe Governorship Election',
        isDefault: true,
      },
    });

    const assembly = await this.prisma.contest.upsert({
      where: { campaignId_type: { campaignId, type: ContestType.ASSEMBLY } },
      update: {
        slug: 'assembly',
        label: 'State House of Assembly',
        irevElectionId: null,
        irevElectionLabel:
          process.env.IREV_ASSEMBLY_ELECTION_LABEL?.trim() ||
          'Gombe State House of Assembly Election',
      },
      create: {
        campaignId,
        type: ContestType.ASSEMBLY,
        slug: 'assembly',
        label: 'State House of Assembly',
        irevElectionId: null,
        irevElectionLabel:
          process.env.IREV_ASSEMBLY_ELECTION_LABEL?.trim() ||
          'Gombe State House of Assembly Election',
        isDefault: false,
      },
    });

    return { governorship: toResolved(gov), assembly: toResolved(assembly) };
  }
}

function toResolved(row: {
  id: string;
  campaignId: string;
  type: string;
  slug: string;
  label: string;
  irevElectionId: string | null;
  irevElectionLabel: string | null;
  isDefault: boolean;
}): ResolvedContest {
  return {
    id: row.id,
    campaignId: row.campaignId,
    type: row.type as ContestType,
    slug: row.slug,
    label: row.label,
    irevElectionId: row.irevElectionId,
    irevElectionLabel: row.irevElectionLabel,
    isDefault: row.isDefault,
  };
}

function toResolvedSeat(row: {
  id: string;
  code: string;
  name: string;
  lgaId: string | null;
  irevElectionId?: string | null;
  lga: { id: string; name: string } | null;
  wards: { id: string; name: string }[];
}): ResolvedSeat {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    lgaId: row.lga?.id ?? row.lgaId,
    lgaName: row.lga?.name ?? null,
    wardIds: row.wards.map((ward) => ward.id),
    wards: row.wards,
    irevElectionId: row.irevElectionId?.trim() || null,
  };
}
