import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@electromon/db';
import {
  CampaignRole,
  NotificationType,
  calendarDateInTimeZone,
  pulseReminderAudienceFromRole,
  pulseReminderHourId,
  pulseReminderSourceEventId,
  PULSE_REMINDER_TIMEZONE,
  type JwtPayload,
} from '@electromon/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FcmService } from './fcm.service';
import { buildNotificationCopy } from './notification-copy';
import { NotificationDispatchPayload } from './notification.events';
import { RecipientResolverService } from './recipient-resolver.service';
import {
  ListNotificationsQueryDto,
  RegisterDeviceDto,
  UnregisterDeviceDto,
} from './dto/notifications.dto';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private prisma: PrismaService,
    private recipients: RecipientResolverService,
    private fcm: FcmService,
  ) {}

  async dispatch(payload: NotificationDispatchPayload) {
    const [resolved, scopeName] = await Promise.all([
      this.recipients.resolve(payload),
      this.recipients.resolveScopeLabel(payload),
    ]);
    if (resolved.length === 0) return [];

    const urgent =
      payload.fieldReport?.isUrgent === true || payload.situationUpdate?.isUrgent === true;
    const copy = buildNotificationCopy(payload.type, scopeName, {
      urgent,
      level: payload.collationResult?.level,
      // Triage moves carry their own detail: the band, the score, and the top
      // driver the engine generated. Passing them through is what turns
      // "Kaduna moved to HIGH" into a line somebody can act on.
      riskLevel: payload.triage?.toRisk,
      score: payload.triage?.compositeScore,
      reason: payload.triage?.driver ?? undefined,
      pulseAudience: payload.pulseReminder?.audience,
      silentCount: payload.pulseReminder?.silentCount,
      totalAssigned: payload.pulseReminder?.totalAssigned,
    });
    const deepLink = this.buildData(payload, copy.route);
    const createdIds: string[] = [];
    const pushUserIds: string[] = [];

    for (const recipient of resolved) {
      const priority = recipient.priority ?? copy.priority;
      try {
        const row = await this.prisma.notification.create({
          data: {
            campaignId: payload.campaignId,
            recipientUserId: recipient.userId,
            actorUserId: payload.actorUserId,
            type: payload.type,
            priority,
            title: copy.title,
            body: copy.body,
            entityType: payload.entityType,
            entityId: payload.entityId,
            sourceEventId: payload.sourceEventId,
            data: deepLink,
          },
        });
        createdIds.push(row.id);
        if (recipient.sendPush) {
          pushUserIds.push(recipient.userId);
        }
      } catch (error) {
        if (this.isUniqueViolation(error)) continue;
        this.logger.error({ err: error }, 'Failed to persist notification');
      }
    }

    if (pushUserIds.length > 0) {
      const tokens = await this.fcm.tokensForUsers(pushUserIds);
      if (tokens.length > 0) {
        const data: Record<string, string> = {};
        for (const [key, value] of Object.entries(deepLink)) {
          if (value != null) data[key] = String(value);
        }
        await this.fcm.send({
          tokens: tokens.map((item) => item.token),
          title: copy.title,
          body: copy.body,
          data,
          priority: copy.priority,
        });
      }
    }

    return createdIds;
  }

  async registerDevice(user: JwtPayload, dto: RegisterDeviceDto) {
    return this.prisma.deviceToken.upsert({
      where: { token: dto.token },
      create: {
        userId: user.sub,
        token: dto.token,
        platform: dto.platform,
        campaignId: user.campaignId ?? null,
        isActive: true,
        lastSeenAt: new Date(),
      },
      update: {
        userId: user.sub,
        platform: dto.platform,
        campaignId: user.campaignId ?? null,
        isActive: true,
        lastSeenAt: new Date(),
      },
    });
  }

  async unregisterDevice(user: JwtPayload, dto: UnregisterDeviceDto) {
    await this.prisma.deviceToken.updateMany({
      where: { token: dto.token, userId: user.sub },
      data: { isActive: false },
    });
    return { success: true };
  }

  async list(user: JwtPayload, query: ListNotificationsQueryDto) {
    if (!user.campaignId) {
      return { items: [], nextCursor: null };
    }
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const where: Prisma.NotificationWhereInput = {
      recipientUserId: user.sub,
      campaignId: user.campaignId,
      ...(query.unreadOnly ? { readAt: null } : {}),
    };

    if (query.cursor) {
      const cursor = await this.prisma.notification.findFirst({
        where: { id: query.cursor, recipientUserId: user.sub },
      });
      if (cursor) {
        where.createdAt = { lt: cursor.createdAt };
      }
    }

    const rows = await this.prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: items.map((row) => this.toDto(row)),
      nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
    };
  }

  async unreadCount(user: JwtPayload) {
    if (!user.campaignId) return { count: 0 };
    const count = await this.prisma.notification.count({
      where: {
        recipientUserId: user.sub,
        campaignId: user.campaignId,
        readAt: null,
      },
    });
    return { count };
  }

  async markRead(user: JwtPayload, id: string) {
    const existing = await this.prisma.notification.findFirst({
      where: { id, recipientUserId: user.sub },
    });
    if (!existing) throw new NotFoundException('Notification not found');
    const row = await this.prisma.notification.update({
      where: { id },
      data: { readAt: existing.readAt ?? new Date() },
    });
    return this.toDto(row);
  }

  async markAllRead(user: JwtPayload) {
    if (!user.campaignId) return { success: true, count: 0 };
    const result = await this.prisma.notification.updateMany({
      where: {
        recipientUserId: user.sub,
        campaignId: user.campaignId,
        readAt: null,
      },
      data: { readAt: new Date() },
    });
    return { success: true, count: result.count };
  }

  /**
   * First mobile open: put this hour's status-update reminder in the inbox.
   * Shares the hourly unique key so the scheduler does not double-send.
   * Push is left to the client (local notification) so opening the app is visible
   * even when FCM is unavailable.
   */
  async nudgePulseReminder(user: JwtPayload) {
    if (!user.campaignId) {
      return { created: false, skipped: true as const, notification: null };
    }
    const audience = pulseReminderAudienceFromRole(user.role);
    if (!audience) {
      return { created: false, skipped: true as const, notification: null };
    }
    if (audience !== 'agent' && !user.scopeId) {
      return { created: false, skipped: true as const, notification: null };
    }

    const now = new Date();
    const dateKey = calendarDateInTimeZone(now, PULSE_REMINDER_TIMEZONE);
    const hourId = pulseReminderHourId(now, PULSE_REMINDER_TIMEZONE);
    const sourceEventId = pulseReminderSourceEventId({
      campaignId: user.campaignId,
      dateKey,
      slotId: hourId,
      audience,
      scopeId: audience === 'agent' ? undefined : user.scopeId ?? undefined,
    });
    const entityId = audience === 'agent' ? user.campaignId : user.scopeId!;
    const actorUserId = (await this.sweepActor(user.campaignId)) ?? '';

    const createdIds = await this.dispatch({
      type: NotificationType.PULSE_REMINDER,
      campaignId: user.campaignId,
      actorUserId,
      entityType: 'PULSE_REMINDER',
      entityId,
      sourceEventId,
      sendPush: false,
      pulseReminder: {
        audience,
        slotId: hourId,
        wardId: audience === 'ward' ? user.scopeId ?? undefined : undefined,
        lgaId: audience === 'lga' ? user.scopeId ?? undefined : undefined,
      },
      explicitRecipients: [{ userId: user.sub, sendPush: false }],
    });

    const row = await this.prisma.notification.findFirst({
      where:
        createdIds.length > 0
          ? { id: createdIds[0] }
          : {
              campaignId: user.campaignId,
              recipientUserId: user.sub,
              sourceEventId,
              type: NotificationType.PULSE_REMINDER,
            },
      orderBy: { createdAt: 'desc' },
    });

    return {
      created: createdIds.length > 0,
      skipped: false as const,
      notification: row ? this.toDto(row) : null,
    };
  }

  private async sweepActor(campaignId: string): Promise<string | undefined> {
    const membership = await this.prisma.campaignMembership.findFirst({
      where: {
        campaignId,
        isActive: true,
        role: CampaignRole.CAMPAIGN_DIRECTOR,
      },
      select: { userId: true },
    });
    return membership?.userId;
  }

  private buildData(payload: NotificationDispatchPayload, route: string): Record<string, string> {
    const collation = payload.collationResult;
    const field = payload.fieldReport;
    const situation = payload.situationUpdate;
    const reminder = payload.pulseReminder;
    const pollingUnitId =
      collation?.scopeType === 'POLLING_UNIT'
        ? collation.scopeId
        : field?.pollingUnitId ?? situation?.pollingUnitId ?? '';
    const wardId =
      collation?.scopeType === 'WARD'
        ? collation.scopeId
        : field?.wardId ?? reminder?.wardId ?? '';

    return {
      type: payload.type,
      campaignId: payload.campaignId,
      entityType: payload.entityType,
      entityId: payload.entityId,
      pollingUnitId,
      wardId,
      route,
    };
  }

  private toDto(row: {
    id: string;
    type: string;
    priority: string;
    title: string;
    body: string;
    entityType: string;
    entityId: string;
    data: Prisma.JsonValue;
    readAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: row.id,
      type: row.type,
      priority: row.priority,
      title: row.title,
      body: row.body,
      entityType: row.entityType,
      entityId: row.entityId,
      data: row.data,
      readAt: row.readAt,
      createdAt: row.createdAt,
    };
  }

  private isUniqueViolation(error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'P2002';
  }
}

export type { RegisterDeviceDto, UnregisterDeviceDto, ListNotificationsQueryDto };
