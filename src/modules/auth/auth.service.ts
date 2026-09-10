import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { CampaignRole, JwtPayload, ScopeType } from '@electromon/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ScopeResolverService } from '../../common/collation/scope-resolver.service';
import { LoginDto, RegisterDto } from './dto/auth.dto';
import { normalizePhoneNumber, phoneLookupCandidates } from './phone.util';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private scopeResolver: ScopeResolverService,
  ) {}

  async validateUser(phoneNumber: string, password: string) {
    const candidates = phoneLookupCandidates(phoneNumber);
    if (candidates.length === 0) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const user = await this.prisma.user.findFirst({
      where: {
        OR: candidates.map((phone) => ({ phoneNumber: phone })),
      },
      include: {
        memberships: {
          where: { isActive: true },
          take: 1,
        },
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return user;
  }

  async login(dto: LoginDto, ipAddress?: string) {
    const user = await this.validateUser(dto.phoneNumber, dto.password);
    const membership = user.memberships[0];

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      phoneNumber: user.phoneNumber,
      campaignId: membership?.campaignId,
      role: membership?.role as JwtPayload['role'],
      scopeType: membership?.scopeType as JwtPayload['scopeType'],
      scopeId: membership?.scopeId ?? undefined,
    };

    const tokens = await this.generateTokens(payload, user.id);
    const dashboard = membership?.role
      ? await this.scopeResolver.buildDashboard(
          membership.role as CampaignRole,
          membership.scopeType as ScopeType,
          membership.scopeId,
        )
      : undefined;

    void this.recordAuthActivity(user.id, membership?.campaignId, 'auth.login', ipAddress);

    return {
      user: {
        id: user.id,
        email: user.email,
        phoneNumber: user.phoneNumber,
        firstName: user.firstName,
        lastName: user.lastName,
        role: membership?.role,
        scopeType: membership?.scopeType,
        scopeId: membership?.scopeId,
        campaignId: membership?.campaignId,
        mfaEnabled: user.mfaEnabled,
        dashboard,
      },
      ...tokens,
    };
  }

  async register(dto: RegisterDto) {
    const phoneNumber = normalizePhoneNumber(dto.phoneNumber);
    if (!phoneNumber) {
      throw new BadRequestException('Invalid phone number');
    }

    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: dto.email }, { phoneNumber }],
      },
    });

    if (existing) {
      throw new UnauthorizedException('User already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        phoneNumber,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
      },
    });

    return { id: user.id, email: user.email, phoneNumber: user.phoneNumber };
  }

  async refresh(refreshToken: string) {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: {
        user: {
          include: {
            memberships: { where: { isActive: true }, take: 1 },
          },
        },
      },
    });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const membership = stored.user.memberships[0];
    const payload: JwtPayload = {
      sub: stored.user.id,
      email: stored.user.email,
      phoneNumber: stored.user.phoneNumber,
      campaignId: membership?.campaignId,
      role: membership?.role as JwtPayload['role'],
      scopeType: membership?.scopeType as JwtPayload['scopeType'],
      scopeId: membership?.scopeId ?? undefined,
    };

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.generateTokens(payload, stored.user.id);
  }

  async logout(refreshToken: string) {
    await this.prisma.refreshToken.updateMany({
      where: { token: refreshToken, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { success: true };
  }

  async getSession(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        memberships: {
          where: { isActive: true },
          include: { campaign: true },
        },
      },
    });

    const memberships = await Promise.all(
      user.memberships.map(async (m) => ({
        campaignId: m.campaignId,
        campaignName: m.campaign.name,
        role: m.role,
        scopeType: m.scopeType,
        scopeId: m.scopeId,
        scopeName: await this.scopeResolver.resolveScopeName(m.scopeType as ScopeType, m.scopeId),
        dashboard: await this.scopeResolver.buildDashboard(
          m.role as CampaignRole,
          m.scopeType as ScopeType,
          m.scopeId,
        ),
      })),
    );

    return {
      id: user.id,
      email: user.email,
      phoneNumber: user.phoneNumber,
      firstName: user.firstName,
      lastName: user.lastName,
      mfaEnabled: user.mfaEnabled,
      memberships,
    };
  }

  private async generateTokens(payload: JwtPayload, userId: string) {
    const accessToken = this.jwtService.sign(
      { ...payload },
      {
        secret: process.env.JWT_ACCESS_SECRET,
        expiresIn: 900,
      },
    );

    const refreshToken = randomBytes(48).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await this.prisma.refreshToken.create({
      data: {
        token: refreshToken,
        userId,
        expiresAt,
      },
    });

    return { accessToken, refreshToken };
  }

  private async recordAuthActivity(
    userId: string,
    campaignId: string | undefined,
    action: string,
    ipAddress?: string,
  ) {
    try {
      await this.prisma.activityLog.create({
        data: {
          userId,
          campaignId,
          action,
          resource: 'auth',
          ipAddress,
        },
      });
    } catch {
      // Audit failures must not break auth flow
    }
  }
}
