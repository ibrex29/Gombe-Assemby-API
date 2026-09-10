import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@electromon/db';
import { CampaignRole, JwtPayload, ScopeType } from '@electromon/shared';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  assertPollingUnitInWard,
  getLgaScopeId,
  getStateScopeId,
  getWardScopeId,
  isLgaScopedUser,
  isStateScopedUser,
} from '../../common/scoping/campaign-scope';
import {
  normalizePhoneNumber,
  phoneLookupCandidates,
} from '../auth/phone.util';
import {
  CreateAgentDto,
  STATE_AGENT_ROLE,
  LGA_AGENT_ROLE,
  ListAgentsQueryDto,
  MANAGEABLE_AGENT_ROLES,
  ManageableAgentRole,
  PU_AGENT_ROLE,
  UpdateAgentDto,
  WARD_AGENT_ROLE,
} from './dto/agents.dto';

@Injectable()
export class AgentsService {
  constructor(private prisma: PrismaService) {}

  private assertViewer(user: JwtPayload) {
    const allowed = new Set([
      CampaignRole.CAMPAIGN_DIRECTOR,
      CampaignRole.CANDIDATE,
      CampaignRole.STATE_COLLATION_OFFICER,
      CampaignRole.LGA_COLLATION_OFFICER,
      CampaignRole.WARD_RA_OFFICER,
    ]);
    if (!user.role || !allowed.has(user.role)) {
      throw new ForbiddenException('You cannot view agents');
    }
  }

  /** Full create/update — system admin or scoped state coordinator */
  private isSystemAdmin(user: JwtPayload) {
    const allowed = new Set([
      CampaignRole.CAMPAIGN_DIRECTOR,
      CampaignRole.CANDIDATE,
    ]);
    return Boolean(user.role && allowed.has(user.role));
  }

  private assertSystemAdmin(user: JwtPayload) {
    if (!this.isSystemAdmin(user)) {
      throw new ForbiddenException(
        'Only system admin can manage agents at this level',
      );
    }
  }

  private async assertScopeInState(
    stateId: string,
    role: ManageableAgentRole,
    scopeId: string,
  ) {
    if (this.isLgaRole(role)) {
      const lga = await this.prisma.lGA.findFirst({
        where: { id: scopeId, stateId },
        select: { id: true },
      });
      if (!lga) {
        throw new ForbiddenException(
          'This agent is outside your assigned state',
        );
      }
      return;
    }

    if (this.isWardRole(role)) {
      const ward = await this.prisma.ward.findFirst({
        where: { id: scopeId, lga: { stateId } },
        select: { id: true },
      });
      if (!ward) {
        throw new ForbiddenException(
          'This agent is outside your assigned state',
        );
      }
      return;
    }

    if (this.isPuRole(role)) {
      const pu = await this.prisma.pollingUnit.findFirst({
        where: { id: scopeId, ward: { lga: { stateId } } },
        select: { id: true },
      });
      if (!pu) {
        throw new ForbiddenException(
          'This agent is outside your assigned state',
        );
      }
    }
  }

  private async assertCanManageAgent(
    user: JwtPayload,
    role: ManageableAgentRole,
    scopeId: string,
  ) {
    if (this.isSystemAdmin(user)) return;

    const stateScopeId = getStateScopeId(user);
    if (stateScopeId) {
      if (this.isStateRole(role)) {
        throw new ForbiddenException(
          'State coordinators cannot manage state coordinator accounts',
        );
      }
      await this.assertScopeInState(stateScopeId, role, scopeId);
      return;
    }

    throw new ForbiddenException('You cannot manage agents');
  }

  private async assertAgentVisibleToUser(
    user: JwtPayload,
    role: ManageableAgentRole,
    scopeId: string,
  ) {
    const stateScopeId = getStateScopeId(user);
    if (stateScopeId) {
      if (this.isStateRole(role)) {
        if (scopeId !== stateScopeId) {
          throw new ForbiddenException(
            'You cannot view agents outside your assigned state',
          );
        }
        await this.resolveStateScope(scopeId);
        return;
      }
      await this.assertScopeInState(stateScopeId, role, scopeId);
      return;
    }

    const wardScopeId = getWardScopeId(user);
    if (wardScopeId) {
      if (!this.isPuRole(role)) {
        throw new ForbiddenException(
          'Ward coordinators can only view polling unit agents',
        );
      }
      await assertPollingUnitInWard(this.prisma, scopeId, wardScopeId);
      return;
    }

    if (this.isStateRole(role)) {
      if (isLgaScopedUser(user)) {
        throw new ForbiddenException('You cannot view state coordinators');
      }
      await this.resolveStateScope(scopeId);
      return;
    }

    const managedLgaId = await this.requireManagedLgaId(
      user,
      undefined,
      role,
      scopeId,
    );
    await this.resolveScopeInLga(role, scopeId, managedLgaId);
  }

  private async assertCampaignAccess(userId: string, campaignId: string) {
    const membership = await this.prisma.campaignMembership.findFirst({
      where: { userId, campaignId, isActive: true },
    });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this campaign');
    }
    return membership;
  }

  private resolveManagedLgaId(
    user: JwtPayload,
    requestedLgaId?: string,
  ): string | undefined {
    if (isLgaScopedUser(user)) {
      const scopeId = getLgaScopeId(user);
      if (!scopeId)
        throw new ForbiddenException('Your account is not assigned to an LGA');
      if (requestedLgaId && requestedLgaId !== scopeId) {
        throw new ForbiddenException(
          'You can only manage agents in your assigned LGA',
        );
      }
      return scopeId;
    }

    return requestedLgaId;
  }

  private async requireManagedLgaId(
    user: JwtPayload,
    requestedLgaId: string | undefined,
    role: ManageableAgentRole,
    scopeId: string,
  ): Promise<string> {
    if (this.isStateRole(role)) {
      throw new BadRequestException(
        'State coordinators are assigned to a state, not an LGA',
      );
    }
    const fromUser = this.resolveManagedLgaId(user, requestedLgaId);
    if (fromUser) return fromUser;

    if (this.isLgaRole(role)) {
      const lga = await this.prisma.lGA.findUnique({
        where: { id: scopeId },
        select: { id: true },
      });
      if (!lga) throw new BadRequestException('LGA not found');
      return lga.id;
    }

    if (this.isWardRole(role)) {
      const ward = await this.prisma.ward.findUnique({
        where: { id: scopeId },
        select: { lgaId: true },
      });
      if (!ward) throw new BadRequestException('Ward not found');
      return ward.lgaId;
    }

    const pu = await this.prisma.pollingUnit.findUnique({
      where: { id: scopeId },
      select: { ward: { select: { lgaId: true } } },
    });
    if (!pu) throw new BadRequestException('Polling unit not found');
    return pu.ward.lgaId;
  }

  private isStateRole(role: CampaignRole): boolean {
    return role === STATE_AGENT_ROLE;
  }

  private isLgaRole(role: CampaignRole): boolean {
    return role === LGA_AGENT_ROLE;
  }

  private isWardRole(role: CampaignRole): boolean {
    return role === WARD_AGENT_ROLE;
  }

  private isPuRole(role: CampaignRole): boolean {
    return role === PU_AGENT_ROLE;
  }

  /** One active agent occupies a PU for the whole campaign (all contests). */
  private async assertPuSeatAvailable(
    campaignId: string,
    scopeType: ScopeType,
    scopeId: string,
    exceptUserId?: string,
  ) {
    if (scopeType !== ScopeType.POLLING_UNIT) return;
    const occupant = await this.prisma.campaignMembership.findFirst({
      where: {
        campaignId,
        isActive: true,
        scopeType: ScopeType.POLLING_UNIT,
        scopeId,
        ...(exceptUserId ? { userId: { not: exceptUserId } } : {}),
      },
      include: {
        user: { select: { firstName: true, lastName: true, phoneNumber: true } },
      },
    });
    if (!occupant) return;
    const name = `${occupant.user.firstName} ${occupant.user.lastName}`.trim();
    throw new ConflictException(
      `This polling unit already has an agent (${name || occupant.user.phoneNumber || occupant.userId}). One agent per PU.`,
    );
  }

  private assertManageableRole(
    role: CampaignRole,
  ): asserts role is ManageableAgentRole {
    if (!(MANAGEABLE_AGENT_ROLES as readonly CampaignRole[]).includes(role)) {
      throw new BadRequestException(
        'Role cannot be assigned via agent management',
      );
    }
  }

  private async resolveStateScope(scopeId: string) {
    const state = await this.prisma.state.findUnique({
      where: { id: scopeId },
      select: { id: true, name: true, code: true },
    });
    if (!state) throw new BadRequestException('State not found');
    return {
      scopeType: ScopeType.STATE as const,
      scopeId: state.id,
      scopeName: state.name,
      wardName: null as string | null,
      lgaName: null as string | null,
      stateName: state.name,
      stateCode: state.code,
    };
  }

  private async resolveAssignment(role: ManageableAgentRole, scopeId: string) {
    if (this.isStateRole(role)) {
      return this.resolveStateScope(scopeId);
    }
    const lgaId = await this.requireManagedLgaId(
      { role: CampaignRole.CAMPAIGN_DIRECTOR } as JwtPayload,
      undefined,
      role,
      scopeId,
    );
    return this.resolveScopeInLga(role, scopeId, lgaId);
  }

  private async resolveScopeInLga(
    role: ManageableAgentRole,
    scopeId: string,
    lgaId: string,
  ) {
    if (this.isLgaRole(role)) {
      if (scopeId !== lgaId) {
        throw new BadRequestException(
          'LGA coordinator scope must match the selected LGA',
        );
      }
      const lga = await this.prisma.lGA.findUnique({
        where: { id: lgaId },
        select: {
          id: true,
          name: true,
          state: { select: { name: true, code: true } },
        },
      });
      if (!lga) {
        throw new BadRequestException('LGA not found');
      }
      return {
        scopeType: ScopeType.LGA as const,
        scopeId: lga.id,
        scopeName: lga.name,
        wardName: null as string | null,
        lgaName: lga.name,
        stateName: lga.state.name,
        stateCode: lga.state.code,
      };
    }

    if (this.isWardRole(role)) {
      const ward = await this.prisma.ward.findFirst({
        where: { id: scopeId, lgaId },
        include: {
          lga: {
            select: {
              id: true,
              name: true,
              state: { select: { name: true, code: true } },
            },
          },
        },
      });
      if (!ward) {
        throw new BadRequestException('Ward not found in this LGA');
      }
      return {
        scopeType: ScopeType.WARD as const,
        scopeId: ward.id,
        scopeName: ward.name,
        wardName: ward.name,
        lgaName: ward.lga.name,
        stateName: ward.lga.state.name,
        stateCode: ward.lga.state.code,
      };
    }

    const pu = await this.prisma.pollingUnit.findFirst({
      where: { id: scopeId, ward: { lgaId } },
      include: {
        ward: {
          include: {
            lga: {
              select: {
                id: true,
                name: true,
                state: { select: { name: true, code: true } },
              },
            },
          },
        },
      },
    });
    if (!pu) {
      throw new BadRequestException('Polling unit not found in this LGA');
    }
    return {
      scopeType: ScopeType.POLLING_UNIT as const,
      scopeId: pu.id,
      scopeName: `${pu.name} (${pu.code})`,
      wardName: pu.ward.name,
      lgaName: pu.ward.lga.name,
      stateName: pu.ward.lga.state.name,
      stateCode: pu.ward.lga.state.code,
    };
  }

  private mapAgent(
    m: {
      id: string;
      role: string;
      scopeType: string | null;
      scopeId: string | null;
      isActive: boolean;
      createdAt: Date;
      user: {
        id: string;
        firstName: string;
        lastName: string;
        phoneNumber: string | null;
        email: string;
        isActive: boolean;
      };
    },
    meta: {
      scopeName: string;
      wardName?: string | null;
      lgaName?: string | null;
      stateName?: string | null;
      stateCode?: string | null;
    },
  ) {
    return {
      membershipId: m.id,
      userId: m.user.id,
      firstName: m.user.firstName,
      lastName: m.user.lastName,
      phoneNumber: m.user.phoneNumber,
      email: m.user.email,
      role: m.role as CampaignRole,
      scopeType: m.scopeType as ScopeType,
      scopeId: m.scopeId as string,
      scopeName: meta.scopeName,
      wardName: meta.wardName ?? null,
      lgaName: meta.lgaName ?? null,
      stateName: meta.stateName ?? null,
      stateCode: meta.stateCode ?? null,
      isActive: m.isActive,
      userActive: m.user.isActive,
      createdAt: m.createdAt,
    };
  }

  private async enrichMemberships(
    memberships: Array<{
      id: string;
      role: string;
      scopeType: string | null;
      scopeId: string | null;
      isActive: boolean;
      createdAt: Date;
      user: {
        id: string;
        firstName: string;
        lastName: string;
        phoneNumber: string | null;
        email: string;
        isActive: boolean;
      };
    }>,
  ) {
    const wardIds = memberships
      .filter((m) => m.scopeType === ScopeType.WARD && m.scopeId)
      .map((m) => m.scopeId as string);
    const puIds = memberships
      .filter((m) => m.scopeType === ScopeType.POLLING_UNIT && m.scopeId)
      .map((m) => m.scopeId as string);
    const lgaIds = memberships
      .filter((m) => m.scopeType === ScopeType.LGA && m.scopeId)
      .map((m) => m.scopeId as string);
    const stateIds = memberships
      .filter((m) => m.scopeType === ScopeType.STATE && m.scopeId)
      .map((m) => m.scopeId as string);

    const [wards, units, lgas, states] = await Promise.all([
      wardIds.length
        ? this.prisma.ward.findMany({
            where: { id: { in: wardIds } },
            include: {
              lga: {
                select: {
                  name: true,
                  state: { select: { name: true, code: true } },
                },
              },
            },
          })
        : Promise.resolve([]),
      puIds.length
        ? this.prisma.pollingUnit.findMany({
            where: { id: { in: puIds } },
            include: {
              ward: {
                include: {
                  lga: {
                    select: {
                      name: true,
                      state: { select: { name: true, code: true } },
                    },
                  },
                },
              },
            },
          })
        : Promise.resolve([]),
      lgaIds.length
        ? this.prisma.lGA.findMany({
            where: { id: { in: lgaIds } },
            select: {
              id: true,
              name: true,
              state: { select: { name: true, code: true } },
            },
          })
        : Promise.resolve([]),
      stateIds.length
        ? this.prisma.state.findMany({
            where: { id: { in: stateIds } },
            select: { id: true, name: true, code: true },
          })
        : Promise.resolve([]),
    ]);

    const wardMap = new Map(wards.map((w) => [w.id, w]));
    const puMap = new Map(units.map((u) => [u.id, u]));
    const lgaMap = new Map(lgas.map((l) => [l.id, l]));
    const stateMap = new Map(states.map((s) => [s.id, s]));

    return memberships.map((m) => {
      if (m.scopeType === ScopeType.STATE && m.scopeId) {
        const state = stateMap.get(m.scopeId);
        return this.mapAgent(m, {
          scopeName: state?.name ?? m.scopeId,
          wardName: null,
          lgaName: null,
          stateName: state?.name,
          stateCode: state?.code,
        });
      }
      if (m.scopeType === ScopeType.LGA && m.scopeId) {
        const lga = lgaMap.get(m.scopeId);
        return this.mapAgent(m, {
          scopeName: lga?.name ?? m.scopeId,
          wardName: null,
          lgaName: lga?.name,
          stateName: lga?.state.name,
          stateCode: lga?.state.code,
        });
      }
      if (m.scopeType === ScopeType.WARD && m.scopeId) {
        const ward = wardMap.get(m.scopeId);
        return this.mapAgent(m, {
          scopeName: ward?.name ?? m.scopeId,
          wardName: ward?.name,
          lgaName: ward?.lga.name,
          stateName: ward?.lga.state.name,
          stateCode: ward?.lga.state.code,
        });
      }
      if (m.scopeType === ScopeType.POLLING_UNIT && m.scopeId) {
        const pu = puMap.get(m.scopeId);
        return this.mapAgent(m, {
          scopeName: pu ? `${pu.name} (${pu.code})` : m.scopeId,
          wardName: pu?.ward.name,
          lgaName: pu?.ward.lga.name,
          stateName: pu?.ward.lga.state.name,
          stateCode: pu?.ward.lga.state.code,
        });
      }
      return this.mapAgent(m, { scopeName: m.scopeId ?? '—' });
    });
  }

  async listOptions(user: JwtPayload, campaignId: string, lgaId?: string) {
    this.assertViewer(user);
    await this.assertCampaignAccess(user.sub, campaignId);

    const wardScopeId = getWardScopeId(user);
    if (wardScopeId) {
      const ward = await this.prisma.ward.findUnique({
        where: { id: wardScopeId },
        include: {
          lga: { select: { id: true, name: true } },
          pollingUnits: {
            orderBy: { code: 'asc' },
            select: { id: true, code: true, name: true },
          },
        },
      });
      if (!ward) throw new NotFoundException('Ward not found');
      return {
        lga: ward.lga,
        ward: { id: ward.id, name: ward.name },
        wards: [
          {
            id: ward.id,
            name: ward.name,
            registrationAreaCode: ward.registrationAreaCode,
            pollingUnits: ward.pollingUnits,
          },
        ],
      };
    }

    const managedLgaId = this.resolveManagedLgaId(user, lgaId);
    if (isStateScopedUser(user) && managedLgaId) {
      const stateScopeId = getStateScopeId(user);
      if (stateScopeId) {
        const lga = await this.prisma.lGA.findFirst({
          where: { id: managedLgaId, stateId: stateScopeId },
          select: { id: true },
        });
        if (!lga) {
          throw new ForbiddenException(
            'You can only manage agents in your assigned state',
          );
        }
      }
    }
    if (!managedLgaId) {
      // Director/state: no LGA filter — options used for create form are loaded per-LGA
      return {
        lga: { id: '', name: 'All LGAs' },
        wards: [],
      };
    }

    const lga = await this.prisma.lGA.findUnique({
      where: { id: managedLgaId },
      select: { id: true, name: true },
    });
    if (!lga) throw new NotFoundException('LGA not found');

    const wards = await this.prisma.ward.findMany({
      where: { lgaId: managedLgaId },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        registrationAreaCode: true,
        pollingUnits: {
          orderBy: { code: 'asc' },
          select: { id: true, code: true, name: true },
        },
      },
    });

    return {
      lga,
      wards: wards.map((w) => ({
        id: w.id,
        name: w.name,
        registrationAreaCode: w.registrationAreaCode,
        pollingUnits: w.pollingUnits,
      })),
    };
  }

  private async idsInState(stateId: string, wardId?: string) {
    const lgas = await this.prisma.lGA.findMany({
      where: { stateId },
      select: { id: true },
    });
    const lgaIds = lgas.map((l) => l.id);
    if (!lgaIds.length)
      return { lgaIds, wardIds: [] as string[], puIds: [] as string[] };
    const wards = await this.prisma.ward.findMany({
      where: wardId
        ? { id: wardId, lgaId: { in: lgaIds } }
        : { lgaId: { in: lgaIds } },
      select: { id: true },
    });
    const wardIds = wards.map((w) => w.id);
    const pus = wardIds.length
      ? await this.prisma.pollingUnit.findMany({
          where: { wardId: { in: wardIds } },
          select: { id: true },
        })
      : [];
    return { lgaIds, wardIds, puIds: pus.map((p) => p.id) };
  }

  private async findAgentMemberships(
    campaignId: string,
    roleFilter: ManageableAgentRole[],
    scopeOr: Prisma.CampaignMembershipWhereInput[],
    search: string | undefined,
    includeInactive?: boolean,
  ) {
    if (!scopeOr.length) return [];
    return this.prisma.campaignMembership.findMany({
      where: {
        campaignId,
        role: { in: roleFilter },
        OR: scopeOr,
        ...(includeInactive ? {} : { isActive: true }),
        ...(search
          ? {
              user: {
                OR: [
                  { firstName: { contains: search, mode: 'insensitive' } },
                  { lastName: { contains: search, mode: 'insensitive' } },
                  { phoneNumber: { contains: search, mode: 'insensitive' } },
                  { email: { contains: search, mode: 'insensitive' } },
                ],
              },
            }
          : {}),
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phoneNumber: true,
            email: true,
            isActive: true,
          },
        },
      },
      orderBy: [{ role: 'asc' }, { createdAt: 'desc' }],
      take: 500,
    });
  }

  async list(user: JwtPayload, query: ListAgentsQueryDto) {
    this.assertViewer(user);
    await this.assertCampaignAccess(user.sub, query.campaignId);

    const wardScopeId = getWardScopeId(user);
    if (wardScopeId) {
      if (query.wardId && query.wardId !== wardScopeId) {
        throw new ForbiddenException(
          'You can only view agents in your assigned ward',
        );
      }

      const puIds = (
        await this.prisma.pollingUnit.findMany({
          where: { wardId: wardScopeId },
          select: { id: true },
        })
      ).map((p) => p.id);

      if (!puIds.length) return [];

      const search = query.search?.trim();
      const memberships = await this.prisma.campaignMembership.findMany({
        where: {
          campaignId: query.campaignId,
          role: PU_AGENT_ROLE,
          scopeType: ScopeType.POLLING_UNIT,
          scopeId: { in: puIds },
          ...(query.includeInactive ? {} : { isActive: true }),
          ...(search
            ? {
                user: {
                  OR: [
                    { firstName: { contains: search, mode: 'insensitive' } },
                    { lastName: { contains: search, mode: 'insensitive' } },
                    { phoneNumber: { contains: search, mode: 'insensitive' } },
                    { email: { contains: search, mode: 'insensitive' } },
                  ],
                },
              }
            : {}),
        },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              phoneNumber: true,
              email: true,
              isActive: true,
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }],
        take: 500,
      });

      return this.enrichMemberships(memberships);
    }

    const managedLgaId = this.resolveManagedLgaId(user, query.lgaId);
    const stateScopeId = getStateScopeId(user);
    if (stateScopeId && query.stateId && query.stateId !== stateScopeId) {
      throw new ForbiddenException(
        'You can only view agents in your assigned state',
      );
    }
    const filterStateId = stateScopeId ?? query.stateId;
    const kind = query.kind ?? 'all';

    // LGA coordinators manage their LGA team (ward + PU only).
    if (isLgaScopedUser(user) && (kind === 'lga' || kind === 'state')) {
      return [];
    }

    const roleFilter: ManageableAgentRole[] =
      kind === 'state'
        ? [STATE_AGENT_ROLE]
        : kind === 'lga'
          ? [LGA_AGENT_ROLE]
          : kind === 'ward'
            ? [WARD_AGENT_ROLE]
            : kind === 'pu'
              ? [PU_AGENT_ROLE]
              : isLgaScopedUser(user)
                ? [WARD_AGENT_ROLE, PU_AGENT_ROLE]
                : [...MANAGEABLE_AGENT_ROLES];

    // No LGA filter: optional state filter, otherwise all campaign LGA/ward/PU agents
    if (!managedLgaId) {
      const scopeOr: Prisma.CampaignMembershipWhereInput[] = [];
      if (filterStateId) {
        const ids = await this.idsInState(filterStateId, query.wardId);
        if ((kind === 'state' || kind === 'all') && !query.wardId) {
          scopeOr.push({
            scopeType: ScopeType.STATE,
            scopeId: filterStateId,
          });
        }
        if (
          (kind === 'lga' || kind === 'all') &&
          !query.wardId &&
          ids.lgaIds.length
        ) {
          scopeOr.push({
            scopeType: ScopeType.LGA,
            scopeId: { in: ids.lgaIds },
          });
        }
        if ((kind === 'ward' || kind === 'all') && ids.wardIds.length) {
          scopeOr.push({
            scopeType: ScopeType.WARD,
            scopeId: { in: ids.wardIds },
          });
        }
        if ((kind === 'pu' || kind === 'all') && ids.puIds.length) {
          scopeOr.push({
            scopeType: ScopeType.POLLING_UNIT,
            scopeId: { in: ids.puIds },
          });
        }
        const memberships = await this.findAgentMemberships(
          query.campaignId,
          roleFilter,
          scopeOr,
          query.search?.trim(),
          query.includeInactive,
        );
        return this.enrichMemberships(memberships);
      }

      if (kind === 'state' || kind === 'all') {
        scopeOr.push({ scopeType: ScopeType.STATE });
      }
      if (kind === 'lga' || kind === 'all') {
        scopeOr.push({ scopeType: ScopeType.LGA });
      }
      if (kind === 'ward' || kind === 'all') {
        scopeOr.push({
          scopeType: ScopeType.WARD,
          ...(query.wardId ? { scopeId: query.wardId } : {}),
        });
      }
      if (kind === 'pu' || kind === 'all') {
        if (query.wardId) {
          const statewidePuIds = (
            await this.prisma.pollingUnit.findMany({
              where: { wardId: query.wardId },
              select: { id: true },
            })
          ).map((p) => p.id);
          if (statewidePuIds.length) {
            scopeOr.push({
              scopeType: ScopeType.POLLING_UNIT,
              scopeId: { in: statewidePuIds },
            });
          }
        } else {
          scopeOr.push({ scopeType: ScopeType.POLLING_UNIT });
        }
      }

      if (!scopeOr.length) return [];

      const searchAll = query.search?.trim();
      const allMemberships = await this.prisma.campaignMembership.findMany({
        where: {
          campaignId: query.campaignId,
          role: { in: roleFilter },
          OR: scopeOr,
          ...(query.includeInactive ? {} : { isActive: true }),
          ...(searchAll
            ? {
                user: {
                  OR: [
                    { firstName: { contains: searchAll, mode: 'insensitive' } },
                    { lastName: { contains: searchAll, mode: 'insensitive' } },
                    {
                      phoneNumber: { contains: searchAll, mode: 'insensitive' },
                    },
                    { email: { contains: searchAll, mode: 'insensitive' } },
                  ],
                },
              }
            : {}),
        },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              phoneNumber: true,
              email: true,
              isActive: true,
            },
          },
        },
        orderBy: [{ role: 'asc' }, { createdAt: 'desc' }],
        take: 500,
      });

      return this.enrichMemberships(allMemberships);
    }

    const wardIds = (
      await this.prisma.ward.findMany({
        where: {
          lgaId: managedLgaId,
          ...(query.wardId ? { id: query.wardId } : {}),
        },
        select: { id: true },
      })
    ).map((w) => w.id);

    const puIds = (
      await this.prisma.pollingUnit.findMany({
        where: {
          ward: {
            lgaId: managedLgaId,
            ...(query.wardId ? { id: query.wardId } : {}),
          },
        },
        select: { id: true },
      })
    ).map((p) => p.id);

    const scopeOr: Prisma.CampaignMembershipWhereInput[] = [];
    if (
      (kind === 'lga' || kind === 'all') &&
      !query.wardId &&
      !isLgaScopedUser(user)
    ) {
      scopeOr.push({ scopeType: ScopeType.LGA, scopeId: managedLgaId });
    }
    if ((kind === 'ward' || kind === 'all') && wardIds.length) {
      scopeOr.push({ scopeType: ScopeType.WARD, scopeId: { in: wardIds } });
    }
    if ((kind === 'pu' || kind === 'all') && puIds.length) {
      scopeOr.push({
        scopeType: ScopeType.POLLING_UNIT,
        scopeId: { in: puIds },
      });
    }

    if (!scopeOr.length) {
      return [];
    }

    const search = query.search?.trim();
    const memberships = await this.prisma.campaignMembership.findMany({
      where: {
        campaignId: query.campaignId,
        role: { in: roleFilter },
        OR: scopeOr,
        ...(query.includeInactive ? {} : { isActive: true }),
        ...(search
          ? {
              user: {
                OR: [
                  { firstName: { contains: search, mode: 'insensitive' } },
                  { lastName: { contains: search, mode: 'insensitive' } },
                  { phoneNumber: { contains: search, mode: 'insensitive' } },
                  { email: { contains: search, mode: 'insensitive' } },
                ],
              },
            }
          : {}),
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phoneNumber: true,
            email: true,
            isActive: true,
          },
        },
      },
      orderBy: [{ role: 'asc' }, { createdAt: 'desc' }],
      take: 500,
    });

    return this.enrichMemberships(memberships);
  }

  async listActivities(user: JwtPayload, membershipId: string) {
    this.assertViewer(user);

    const membership = await this.prisma.campaignMembership.findUnique({
      where: { id: membershipId },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phoneNumber: true,
            email: true,
            isActive: true,
          },
        },
      },
    });
    if (!membership) throw new NotFoundException('Agent not found');

    await this.assertCampaignAccess(user.sub, membership.campaignId);
    this.assertManageableRole(membership.role as CampaignRole);

    await this.assertAgentVisibleToUser(
      user,
      membership.role as ManageableAgentRole,
      membership.scopeId!,
    );

    const userId = membership.userId;
    const campaignId = membership.campaignId;

    const [collationLogs, reportedIncidents, handledIncidents] =
      await Promise.all([
        this.prisma.collationActionLog.findMany({
          where: { actorId: userId, campaignId },
          include: {
            collationResult: {
              select: {
                id: true,
                level: true,
                scopeType: true,
                scopeId: true,
                status: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 80,
        }),
        this.prisma.fieldReport.findMany({
          where: { reportedById: userId, campaignId },
          include: {
            pollingUnit: { select: { code: true, name: true } },
            ward: { select: { name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 80,
        }),
        this.prisma.fieldReport.findMany({
          where: {
            handledById: userId,
            campaignId,
            NOT: { reportedById: userId },
          },
          include: {
            pollingUnit: { select: { code: true, name: true } },
            ward: { select: { name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 80,
        }),
      ]);

    const scopeIds = [
      ...new Set(
        collationLogs
          .map((l) => l.collationResult?.scopeId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const [wards, units] = await Promise.all([
      this.prisma.ward.findMany({
        where: { id: { in: scopeIds } },
        select: { id: true, name: true },
      }),
      this.prisma.pollingUnit.findMany({
        where: { id: { in: scopeIds } },
        select: { id: true, code: true, name: true },
      }),
    ]);
    const wardName = new Map(wards.map((w) => [w.id, w.name]));
    const puName = new Map(units.map((u) => [u.id, `${u.name} (${u.code})`]));

    const collationActionLabel: Record<string, string> = {
      SUBMITTED: 'Submitted result',
      APPROVED: 'Approved result',
      REJECTED: 'Returned result',
    };

    type Activity = {
      id: string;
      kind: 'COLLATION' | 'INCIDENT_REPORTED' | 'INCIDENT_HANDLED';
      title: string;
      detail: string | null;
      status: string | null;
      createdAt: Date;
    };

    const activities: Activity[] = [];

    for (const log of collationLogs) {
      const result = log.collationResult;
      const scopeLabel =
        (result?.scopeId &&
          (wardName.get(result.scopeId) || puName.get(result.scopeId))) ||
        result?.scopeId ||
        'Unknown scope';
      activities.push({
        id: `collation-${log.id}`,
        kind: 'COLLATION',
        title: collationActionLabel[log.action] ?? log.action,
        detail: `${result?.level ?? '—'} · ${scopeLabel}${log.comment ? ` · ${log.comment}` : ''}`,
        status: log.toStatus,
        createdAt: log.createdAt,
      });
    }

    for (const report of reportedIncidents) {
      const place = report.pollingUnit
        ? `${report.pollingUnit.code} — ${report.pollingUnit.name}`
        : (report.ward?.name ?? 'Incident');
      activities.push({
        id: `incident-reported-${report.id}`,
        kind: 'INCIDENT_REPORTED',
        title: `Reported: ${report.title}`,
        detail: place,
        status: report.status,
        createdAt: report.createdAt,
      });
    }

    for (const report of handledIncidents) {
      const place = report.pollingUnit
        ? `${report.pollingUnit.code} — ${report.pollingUnit.name}`
        : (report.ward?.name ?? 'Incident');
      activities.push({
        id: `incident-handled-${report.id}`,
        kind: 'INCIDENT_HANDLED',
        title: `${report.status === 'RESOLVED' ? 'Resolved' : 'Handled'}: ${report.title}`,
        detail: place + (report.wardComment ? ` · ${report.wardComment}` : ''),
        status: report.status,
        createdAt: report.handledAt ?? report.createdAt,
      });
    }

    activities.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const [agent] = await this.enrichMemberships([membership]);

    return {
      agent,
      activities: activities.slice(0, 5).map((a) => ({
        ...a,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  }

  async create(user: JwtPayload, dto: CreateAgentDto) {
    await this.assertCanManageAgent(user, dto.role, dto.scopeId);
    await this.assertCampaignAccess(user.sub, dto.campaignId);
    this.assertManageableRole(dto.role);

    const scope = await this.resolveAssignment(dto.role, dto.scopeId);

    const phoneNumber = normalizePhoneNumber(dto.phoneNumber);
    if (!phoneNumber) {
      throw new BadRequestException('Invalid phone number');
    }

    const email =
      dto.email?.trim().toLowerCase() ||
      `agent.${phoneNumber.replace(/\D/g, '')}@electromon.local`;

    const passwordHash = await bcrypt.hash(dto.password, 12);

    const candidates = phoneLookupCandidates(dto.phoneNumber);
    let existing = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email },
          ...(candidates.length ? [{ phoneNumber: { in: candidates } }] : []),
        ],
      },
    });

    if (existing) {
      const otherPhone = await this.prisma.user.findFirst({
        where: {
          id: { not: existing.id },
          phoneNumber: { in: candidates },
        },
      });
      if (otherPhone) {
        throw new ConflictException('Phone number already in use');
      }
    }

    if (!existing) {
      existing = await this.prisma.user.create({
        data: {
          email,
          phoneNumber,
          passwordHash,
          firstName: dto.firstName.trim(),
          lastName: dto.lastName.trim(),
          isActive: true,
        },
      });
    } else {
      existing = await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          firstName: dto.firstName.trim(),
          lastName: dto.lastName.trim(),
          phoneNumber,
          passwordHash,
          isActive: true,
          ...(dto.email ? { email } : {}),
        },
      });
    }

    await this.assertPuSeatAvailable(
      dto.campaignId,
      scope.scopeType,
      scope.scopeId,
      existing.id,
    );

    const membership = await this.prisma.campaignMembership.upsert({
      where: {
        userId_campaignId: { userId: existing.id, campaignId: dto.campaignId },
      },
      create: {
        userId: existing.id,
        campaignId: dto.campaignId,
        role: dto.role,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        isActive: true,
      },
      update: {
        role: dto.role,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        isActive: true,
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phoneNumber: true,
            email: true,
            isActive: true,
          },
        },
      },
    });

    return this.mapAgent(membership, {
      scopeName: scope.scopeName,
      wardName: scope.wardName,
      lgaName: scope.lgaName,
      stateName: scope.stateName,
      stateCode: scope.stateCode,
    });
  }

  async update(user: JwtPayload, membershipId: string, dto: UpdateAgentDto) {
    const membership = await this.prisma.campaignMembership.findUnique({
      where: { id: membershipId },
      include: {
        user: true,
      },
    });
    if (!membership) throw new NotFoundException('Agent not found');

    await this.assertCampaignAccess(user.sub, membership.campaignId);
    this.assertManageableRole(membership.role as CampaignRole);

    await this.assertCanManageAgent(
      user,
      membership.role as ManageableAgentRole,
      membership.scopeId!,
    );

    const nextRole = (dto.role ?? membership.role) as ManageableAgentRole;
    this.assertManageableRole(nextRole);
    const nextScopeId = dto.scopeId ?? membership.scopeId!;
    await this.assertCanManageAgent(user, nextRole, nextScopeId);
    const scope = await this.resolveAssignment(nextRole, nextScopeId);
    await this.assertPuSeatAvailable(
      membership.campaignId,
      scope.scopeType,
      scope.scopeId,
      membership.userId,
    );

    let phoneNumber = membership.user.phoneNumber;
    if (dto.phoneNumber) {
      phoneNumber = normalizePhoneNumber(dto.phoneNumber);
      if (!phoneNumber) throw new BadRequestException('Invalid phone number');
      const candidates = phoneLookupCandidates(dto.phoneNumber);
      const clash = await this.prisma.user.findFirst({
        where: {
          id: { not: membership.userId },
          phoneNumber: { in: candidates },
        },
      });
      if (clash) throw new ConflictException('Phone number already in use');
    }

    const passwordHash = dto.password
      ? await bcrypt.hash(dto.password, 12)
      : undefined;

    await this.prisma.user.update({
      where: { id: membership.userId },
      data: {
        ...(dto.firstName ? { firstName: dto.firstName.trim() } : {}),
        ...(dto.lastName ? { lastName: dto.lastName.trim() } : {}),
        ...(dto.phoneNumber ? { phoneNumber } : {}),
        ...(dto.email ? { email: dto.email.trim().toLowerCase() } : {}),
        ...(passwordHash ? { passwordHash } : {}),
        ...(dto.isActive === false ? { isActive: false } : {}),
        ...(dto.isActive === true ? { isActive: true } : {}),
      },
    });

    const updated = await this.prisma.campaignMembership.update({
      where: { id: membershipId },
      data: {
        role: nextRole,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phoneNumber: true,
            email: true,
            isActive: true,
          },
        },
      },
    });

    return this.mapAgent(updated, {
      scopeName: scope.scopeName,
      wardName: scope.wardName,
      lgaName: scope.lgaName,
      stateName: scope.stateName,
      stateCode: scope.stateCode,
    });
  }

  /* ---------------------------------------------------------------------- *
   * Responsibility chain — who to call about a place.
   * ---------------------------------------------------------------------- */

  /**
   * Roles that carry responsibility at each level.
   *
   * Both spellings are listed on purpose. `WARD_COORDINATOR`, `LGA_COORDINATOR`
   * and `STATE_COORDINATOR` are deprecated in favour of the `*_OFFICER` names,
   * but the old values are still live on existing rows, and a lookup that only
   * matched the new ones would silently report "nobody assigned" for a ward
   * that has had a coordinator all along.
   */
  private static readonly RESPONSIBLE_ROLES: Record<string, CampaignRole[]> = {
    [ScopeType.POLLING_UNIT]: [
      CampaignRole.POLLING_AGENT,
      CampaignRole.POLLING_UNIT_OFFICER,
    ],
    [ScopeType.WARD]: [
      CampaignRole.WARD_RA_OFFICER,
      CampaignRole.WARD_COORDINATOR,
    ],
    [ScopeType.LGA]: [
      CampaignRole.LGA_COLLATION_OFFICER,
      CampaignRole.LGA_COORDINATOR,
      CampaignRole.POLLING_AGENT_COORDINATOR,
    ],
    [ScopeType.STATE]: [
      CampaignRole.STATE_COLLATION_OFFICER,
      CampaignRole.STATE_COORDINATOR,
    ],
    [ScopeType.NATIONAL]: [CampaignRole.NATIONAL_COLLATION_OFFICER],
  };

  /**
   * Everyone responsible for a scope, closest first, then up the chain.
   *
   * The chain is the point rather than a nicety: when a polling unit goes
   * critical at 2am the agent there may be exactly the person who is not
   * answering, and the next call is their ward coordinator. Returning only the
   * closest contact would make the common case a second round trip.
   *
   * Reuses `assertViewer`, so this is readable by exactly the roles that can
   * already open the Agents page — contact details are not newly exposed to
   * anyone, they are only reachable from somewhere more useful.
   */
  async getScopeContacts(
    user: JwtPayload,
    campaignId: string,
    scopeType: ScopeType,
    scopeId: string,
  ) {
    this.assertViewer(user);
    await this.assertCampaignAccess(user.sub, campaignId);

    const chain = await this.buildScopeChain(scopeType, scopeId);
    if (chain.length === 0) {
      throw new NotFoundException('That place could not be found');
    }

    const memberships = await this.prisma.campaignMembership.findMany({
      where: {
        campaignId,
        isActive: true,
        OR: chain.map((link) => ({
          scopeType: link.scopeType,
          scopeId: link.scopeId,
          role: {
            in: AgentsService.RESPONSIBLE_ROLES[link.scopeType] ?? [],
          },
        })),
      },
      select: {
        id: true,
        role: true,
        scopeType: true,
        scopeId: true,
        user: {
          select: {
            firstName: true,
            lastName: true,
            phoneNumber: true,
            email: true,
            isActive: true,
          },
        },
      },
    });

    const levels = chain.map((link) => ({
      scopeType: link.scopeType,
      scopeId: link.scopeId,
      name: link.name,
      contacts: memberships
        .filter(
          (row) =>
            row.scopeType === link.scopeType && row.scopeId === link.scopeId,
        )
        .map((row) => ({
          membershipId: row.id,
          name: `${row.user.firstName} ${row.user.lastName}`.trim(),
          role: row.role,
          phoneNumber: row.user.phoneNumber,
          email: row.user.email,
          // A deactivated account still shows, flagged: knowing the post is
          // vacant is operational information, not an empty result.
          isActive: row.user.isActive,
        })),
    }));

    return {
      scope: { scopeType, scopeId, name: chain[0].name },
      levels,
      // Surfaced rather than left for the caller to compute: an unmanned scope
      // is the thing a war room most needs told, not something to notice.
      unassigned: levels
        .filter((level) => level.contacts.length === 0)
        .map((level) => level.scopeType),
    };
  }

  /** The scope itself, then each ancestor, nearest first. */
  private async buildScopeChain(
    scopeType: ScopeType,
    scopeId: string,
  ): Promise<Array<{ scopeType: ScopeType; scopeId: string; name: string }>> {
    if (scopeType === ScopeType.POLLING_UNIT) {
      const pu = await this.prisma.pollingUnit.findUnique({
        where: { id: scopeId },
        include: { ward: { include: { lga: { include: { state: true } } } } },
      });
      if (!pu) return [];
      return [
        {
          scopeType: ScopeType.POLLING_UNIT,
          scopeId: pu.id,
          name: pu.code ? `${pu.code} — ${pu.name}` : pu.name,
        },
        { scopeType: ScopeType.WARD, scopeId: pu.ward.id, name: pu.ward.name },
        {
          scopeType: ScopeType.LGA,
          scopeId: pu.ward.lga.id,
          name: pu.ward.lga.name,
        },
        {
          scopeType: ScopeType.STATE,
          scopeId: pu.ward.lga.state.id,
          name: pu.ward.lga.state.name,
        },
      ];
    }

    if (scopeType === ScopeType.WARD) {
      const ward = await this.prisma.ward.findUnique({
        where: { id: scopeId },
        include: { lga: { include: { state: true } } },
      });
      if (!ward) return [];
      return [
        { scopeType: ScopeType.WARD, scopeId: ward.id, name: ward.name },
        { scopeType: ScopeType.LGA, scopeId: ward.lga.id, name: ward.lga.name },
        {
          scopeType: ScopeType.STATE,
          scopeId: ward.lga.state.id,
          name: ward.lga.state.name,
        },
      ];
    }

    if (scopeType === ScopeType.LGA) {
      const lga = await this.prisma.lGA.findUnique({
        where: { id: scopeId },
        include: { state: true },
      });
      if (!lga) return [];
      return [
        { scopeType: ScopeType.LGA, scopeId: lga.id, name: lga.name },
        {
          scopeType: ScopeType.STATE,
          scopeId: lga.state.id,
          name: lga.state.name,
        },
      ];
    }

    if (scopeType === ScopeType.STATE) {
      const state = await this.prisma.state.findUnique({
        where: { id: scopeId },
      });
      if (!state) return [];
      return [
        { scopeType: ScopeType.STATE, scopeId: state.id, name: state.name },
      ];
    }

    return [];
  }

  /**
   * Finds a place by what someone would actually type.
   *
   * The assistant is asked "who is the agent at PU 32-02-03-001" or "who runs
   * Ahoada III", never "...at cmt2t7j8v21a9". Codes are matched exactly first
   * because they are unambiguous; names fall back to a contains match, and an
   * ambiguous name returns the candidates rather than guessing which Ahoada the
   * asker meant.
   */
  async findScopeByLabel(query: string): Promise<
    | { match: { scopeType: ScopeType; scopeId: string; name: string } }
    | {
        ambiguous: Array<{
          scopeType: ScopeType;
          scopeId: string;
          name: string;
        }>;
      }
    | { notFound: true }
  > {
    const term = query.trim();
    if (term.length < 2) return { notFound: true };

    const [puByCode, pus, wards, lgas, states] = await Promise.all([
      this.prisma.pollingUnit.findMany({
        where: { code: { equals: term, mode: 'insensitive' } },
        select: { id: true, name: true, code: true },
        take: 5,
      }),
      this.prisma.pollingUnit.findMany({
        where: { name: { contains: term, mode: 'insensitive' } },
        select: { id: true, name: true, code: true },
        take: 6,
      }),
      this.prisma.ward.findMany({
        where: { name: { contains: term, mode: 'insensitive' } },
        select: { id: true, name: true, lga: { select: { name: true } } },
        take: 6,
      }),
      this.prisma.lGA.findMany({
        where: { name: { contains: term, mode: 'insensitive' } },
        select: { id: true, name: true, state: { select: { name: true } } },
        take: 6,
      }),
      this.prisma.state.findMany({
        where: { name: { contains: term, mode: 'insensitive' } },
        select: { id: true, name: true },
        take: 6,
      }),
    ]);

    if (puByCode.length === 1) {
      const pu = puByCode[0];
      return {
        match: {
          scopeType: ScopeType.POLLING_UNIT,
          scopeId: pu.id,
          name: `${pu.code} — ${pu.name}`,
        },
      };
    }

    const candidates = [
      ...states.map((s) => ({
        scopeType: ScopeType.STATE,
        scopeId: s.id,
        name: s.name,
      })),
      ...lgas.map((l) => ({
        scopeType: ScopeType.LGA,
        scopeId: l.id,
        name: `${l.name} (${l.state.name})`,
      })),
      ...wards.map((w) => ({
        scopeType: ScopeType.WARD,
        scopeId: w.id,
        name: `${w.name} (${w.lga.name})`,
      })),
      ...pus.map((p) => ({
        scopeType: ScopeType.POLLING_UNIT,
        scopeId: p.id,
        name: p.code ? `${p.code} — ${p.name}` : p.name,
      })),
    ];

    if (candidates.length === 0) return { notFound: true };
    if (candidates.length === 1) return { match: candidates[0] };

    // An exact name match beats a pile of partial ones.
    const exact = candidates.filter(
      (c) => c.name.toLowerCase() === term.toLowerCase(),
    );
    if (exact.length === 1) return { match: exact[0] };

    return { ambiguous: candidates.slice(0, 8) };
  }
}
