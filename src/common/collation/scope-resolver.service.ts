import { Injectable } from '@nestjs/common';
import {
  CollationLevel,
  NATIONAL_SCOPE_ID,
  ScopeType,
  buildDashboardMeta,
  getCollationLevelForRole,
  getChildLevel,
} from '@electromon/shared';
import { CampaignRole } from '@electromon/shared';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ScopeResolverService {
  constructor(private prisma: PrismaService) {}

  async resolveScopeName(scopeType?: ScopeType | null, scopeId?: string | null): Promise<string | undefined> {
    if (!scopeType || !scopeId) return undefined;

    switch (scopeType) {
      case ScopeType.POLLING_UNIT: {
        const pu = await this.prisma.pollingUnit.findUnique({ where: { id: scopeId } });
        return pu ? `${pu.name} (${pu.code})` : undefined;
      }
      case ScopeType.WARD: {
        const ward = await this.prisma.ward.findUnique({ where: { id: scopeId } });
        return ward?.name;
      }
      case ScopeType.LGA: {
        const lga = await this.prisma.lGA.findUnique({ where: { id: scopeId } });
        return lga?.name;
      }
      case ScopeType.STATE: {
        const state = await this.prisma.state.findUnique({ where: { id: scopeId } });
        return state?.name;
      }
      case ScopeType.NATIONAL:
        return 'National Collation Centre (Abuja)';
      case ScopeType.CAMPAIGN: {
        const campaign = await this.prisma.campaign.findUnique({ where: { id: scopeId } });
        return campaign?.name;
      }
      default:
        return undefined;
    }
  }

  async buildDashboard(
    role: CampaignRole,
    scopeType?: ScopeType | null,
    scopeId?: string | null,
  ) {
    const scopeName = await this.resolveScopeName(scopeType, scopeId);
    return buildDashboardMeta(role, scopeType ?? undefined, scopeId, scopeName);
  }

  async resolveScopeChain(scopeType: ScopeType, scopeId: string) {
    switch (scopeType) {
      case ScopeType.POLLING_UNIT: {
        const pu = await this.prisma.pollingUnit.findUniqueOrThrow({
          where: { id: scopeId },
          include: { ward: { include: { lga: { include: { state: true } } } } },
        });
        return {
          pollingUnit: { id: pu.id, code: pu.code, name: pu.name },
          ward: {
            id: pu.ward.id,
            name: pu.ward.name,
            registrationAreaCode: pu.ward.registrationAreaCode,
          },
          lga: { id: pu.ward.lga.id, name: pu.ward.lga.name },
          state: { id: pu.ward.lga.state.id, name: pu.ward.lga.state.name, code: pu.ward.lga.state.code },
          national: { id: NATIONAL_SCOPE_ID, name: 'National Collation Centre (Abuja)' },
        };
      }
      case ScopeType.WARD: {
        const ward = await this.prisma.ward.findUniqueOrThrow({
          where: { id: scopeId },
          include: { lga: { include: { state: true } } },
        });
        return {
          ward: {
            id: ward.id,
            name: ward.name,
            registrationAreaCode: ward.registrationAreaCode,
          },
          lga: { id: ward.lga.id, name: ward.lga.name },
          state: { id: ward.lga.state.id, name: ward.lga.state.name, code: ward.lga.state.code },
          national: { id: NATIONAL_SCOPE_ID, name: 'National Collation Centre (Abuja)' },
        };
      }
      case ScopeType.LGA: {
        const lga = await this.prisma.lGA.findUniqueOrThrow({
          where: { id: scopeId },
          include: { state: true },
        });
        return {
          lga: { id: lga.id, name: lga.name },
          state: { id: lga.state.id, name: lga.state.name, code: lga.state.code },
          national: { id: NATIONAL_SCOPE_ID, name: 'National Collation Centre (Abuja)' },
        };
      }
      case ScopeType.STATE: {
        const state = await this.prisma.state.findUniqueOrThrow({ where: { id: scopeId } });
        return {
          state: { id: state.id, name: state.name, code: state.code },
          national: { id: NATIONAL_SCOPE_ID, name: 'National Collation Centre (Abuja)' },
        };
      }
      case ScopeType.NATIONAL:
        return {
          national: { id: NATIONAL_SCOPE_ID, name: 'National Collation Centre (Abuja)' },
        };
      default:
        return {};
    }
  }

  getLevelForUser(role?: CampaignRole, scopeType?: ScopeType | null): CollationLevel | undefined {
    const fromRole = role ? getCollationLevelForRole(role) : undefined;
    if (fromRole) return fromRole;

    if (!scopeType) return undefined;
    const map: Partial<Record<ScopeType, CollationLevel>> = {
      [ScopeType.POLLING_UNIT]: CollationLevel.POLLING_UNIT,
      [ScopeType.WARD]: CollationLevel.WARD,
      [ScopeType.LGA]: CollationLevel.LGA,
      [ScopeType.STATE]: CollationLevel.STATE,
      [ScopeType.NATIONAL]: CollationLevel.NATIONAL,
    };
    return map[scopeType];
  }

  getChildScopeType(level: CollationLevel): ScopeType | undefined {
    const child = getChildLevel(level);
    if (!child) return undefined;
    const map: Record<CollationLevel, ScopeType> = {
      [CollationLevel.POLLING_UNIT]: ScopeType.WARD,
      [CollationLevel.WARD]: ScopeType.LGA,
      [CollationLevel.LGA]: ScopeType.STATE,
      [CollationLevel.CONSTITUENCY]: ScopeType.STATE,
      [CollationLevel.STATE]: ScopeType.NATIONAL,
      [CollationLevel.NATIONAL]: ScopeType.NATIONAL,
    };
    return map[level];
  }
}
