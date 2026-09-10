import {
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@electromon/db';
import { PrismaService } from '../prisma/prisma.service';
import { inecStateIdForCode } from '../../modules/irev/irev-inec-state-codes';

/** Pantamiyya deploys are Gombe-only when DEPLOYMENT_STATE_CODE is unset. */
const PANTAMIYYA_DEFAULT_STATE_CODE = 'GO';

/** INEC IReV portal election id — 2023 Gombe State governorship. */
const PANTAMIYYA_IREV_ELECTION_ID = '6407d9bfce35006e92156f2e';

/** Pantamiyya tracks Isa Ali Pantami on PDP. */
const PANTAMIYYA_CLIENT_PARTY_CODE = 'PDP';

export type DeploymentElectionType = 'GOVERNORSHIP' | 'PRESIDENTIAL' | 'ASSEMBLY';

export type DeploymentGeoScope = {
  stateId?: string;
  lgaId?: string;
  wardId?: string;
};

@Injectable()
export class DeploymentScopeService implements OnModuleInit {
  private readonly logger = new Logger(DeploymentScopeService.name);
  private readonly stateCode: string | null;
  private stateId: string | null = null;
  private stateName: string | null = null;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    const configured = this.config.get<string>('DEPLOYMENT_STATE_CODE')?.trim();
    const code = configured || PANTAMIYYA_DEFAULT_STATE_CODE;
    this.stateCode = code ? code.toUpperCase() : null;
  }

  async onModuleInit() {
    if (!this.stateCode) return;
    const state = await this.prisma.state.findFirst({
      where: { code: { equals: this.stateCode, mode: 'insensitive' } },
      select: { id: true, name: true, code: true },
    });
    if (!state) {
      throw new Error(
        `DEPLOYMENT_STATE_CODE=${this.stateCode} is not in the electoral register`,
      );
    }
    this.stateId = state.id;
    this.stateName = state.name;
    this.logger.log(
      `Deployment geo scope locked to ${state.name} (${state.code}) · IReV election ${this.irevElectionId()} · client party ${this.clientPartyCode()}`,
    );

    const partyCode = this.clientPartyCode();
    if (partyCode) {
      const updated = await this.prisma.campaign.updateMany({
        where: {
          isActive: true,
          stateId: this.stateId,
          clientPartyCode: { not: partyCode },
        },
        data: { clientPartyCode: partyCode },
      });
      if (updated.count > 0) {
        this.logger.log(`Updated clientPartyCode to ${partyCode} on ${updated.count} campaign(s)`);
      }
    }
  }

  /** State-scoped deploys pin the client party (Pantamiyya = PDP). */
  clientPartyCode(): string | null {
    if (!this.stateCode) return null;
    return (
      this.config.get<string>('DEPLOYMENT_CLIENT_PARTY_CODE')?.trim() ||
      PANTAMIYYA_CLIENT_PARTY_CODE
    );
  }

  resolveClientPartyCode(stored?: string | null): string | null {
    return this.clientPartyCode() ?? stored ?? null;
  }

  /** State-scoped deploys use a governorship portal election by default. */
  irevElectionId(): string | null {
    if (!this.isStateLocked()) return null;
    return (
      this.config.get<string>('IREV_ELECTION_ID')?.trim() || PANTAMIYYA_IREV_ELECTION_ID
    );
  }

  irevElectionLabel(): string | null {
    if (!this.isStateLocked()) return null;
    const configured = this.config.get<string>('IREV_ELECTION_LABEL')?.trim();
    if (configured) return configured;
    return this.stateName ? `${this.stateName} Governorship Election` : null;
  }

  irevElectionType(): DeploymentElectionType | null {
    if (!this.isStateLocked()) return null;
    const raw = this.config.get<string>('IREV_ELECTION_TYPE')?.trim().toUpperCase();
    if (raw === 'GOVERNORSHIP' || raw === 'PRESIDENTIAL' || raw === 'ASSEMBLY') return raw;
    return 'GOVERNORSHIP';
  }

  irevPortalStateInecId(): number | null {
    if (!this.stateCode) return null;
    return inecStateIdForCode(this.stateCode);
  }

  isGovernorshipElection(): boolean {
    return this.irevElectionType() === 'GOVERNORSHIP';
  }

  isStateLocked(): boolean {
    return Boolean(this.stateCode && this.stateId);
  }

  lockedStateCode(): string | null {
    return this.stateCode;
  }

  lockedStateId(): string | null {
    return this.stateId;
  }

  lockedStateName(): string | null {
    return this.stateName;
  }

  /** Prisma filter for the single allowed state row. */
  stateWhere(): Prisma.StateWhereInput {
    if (!this.stateId) return {};
    return { id: this.stateId };
  }

  /** Restrict wards/PUs/LGAs to the locked state. */
  wardInLockedStateWhere(): Prisma.WardWhereInput {
    if (!this.stateId) return {};
    return { lga: { stateId: this.stateId } };
  }

  /**
   * When deployment is state-locked, national campaigns behave as state campaigns
   * for geo filtering (polling units, browse, IReV crawl, etc.).
   */
  effectivePuStateId(campaign: { isNational: boolean; stateId: string }): string | undefined {
    if (this.stateId) return this.stateId;
    if (campaign.isNational) return undefined;
    return campaign.stateId;
  }

  clampStateId(requested?: string | null): string | undefined {
    if (!this.stateId) return requested ?? undefined;
    if (requested && requested !== this.stateId) {
      throw new ForbiddenException(
        `This deployment is scoped to ${this.stateName ?? this.stateCode} only`,
      );
    }
    return this.stateId;
  }

  clampGeoScope(scope: DeploymentGeoScope): DeploymentGeoScope {
    if (!this.stateId) return scope;
    this.clampStateId(scope.stateId);
    return {
      ...scope,
      stateId: this.stateId,
    };
  }

  assertStateInScope(stateId: string) {
    if (this.stateId && stateId !== this.stateId) {
      throw new ForbiddenException(
        `This deployment is scoped to ${this.stateName ?? this.stateCode} only`,
      );
    }
  }

  /** Override national browse context to the locked state. */
  applyToBrowseContext<T extends {
    isNational: boolean;
    stateId: string;
    stateName: string;
    stateCode: string;
  }>(context: T): T {
    if (!this.stateId || !this.stateName || !this.stateCode) return context;
    this.assertStateInScope(context.stateId);
    return {
      ...context,
      isNational: false,
      stateId: this.stateId,
      stateName: this.stateName.toUpperCase(),
      stateCode: this.stateCode,
    };
  }

  deploymentMeta() {
    if (!this.isStateLocked()) {
      return { scoped: false as const };
    }
    return {
      scoped: true as const,
      deployment: 'Pantamiyya',
      stateCode: this.stateCode,
      stateName: this.stateName,
      stateId: this.stateId,
      electionId: this.irevElectionId(),
      electionLabel: this.irevElectionLabel(),
      electionType: this.irevElectionType(),
      clientPartyCode: this.clientPartyCode(),
    };
  }
}
