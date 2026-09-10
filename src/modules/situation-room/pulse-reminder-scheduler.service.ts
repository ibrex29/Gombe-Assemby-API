import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CampaignRole,
  NotificationType,
  ScopeType,
  calendarDateInTimeZone,
  isPulseSilent,
  pulseReminderHourId,
  pulseReminderSourceEventId,
} from '@electromon/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import {
  NOTIFICATION_DISPATCH_EVENT,
  type NotificationDispatchPayload,
} from '../notifications/notification.events';

const DEFAULT_INTERVAL_SECONDS = 60;
const LOCK_TTL_SECONDS = 180;
const MEMBERSHIP_PAGE = 500;
const RECIPIENT_CHUNK = 400;
const DEFAULT_SKIP_RECENT_MINUTES = 50;

const PU_ROLES: CampaignRole[] = [
  CampaignRole.POLLING_AGENT,
  CampaignRole.POLLING_UNIT_OFFICER,
];
const WARD_ROLES: CampaignRole[] = [
  CampaignRole.WARD_RA_OFFICER,
  CampaignRole.WARD_COORDINATOR,
];
const LGA_ROLES: CampaignRole[] = [
  CampaignRole.LGA_COLLATION_OFFICER,
  CampaignRole.LGA_COORDINATOR,
];

type AgentRow = { userId: string; scopeId: string };
type PulseRow = { pollingUnitId: string; phase: string | null; lastPulseAt: Date | null };
type GeoRow = { id: string; wardId: string; lgaId: string };

/**
 * Hourly nudge so PU agents, ward officers, and LGA officers send (or chase)
 * a full status update. Same interval + Redis lock pattern as the risk sweep.
 * Unique notification keys absorb overlapping ticks and first-open nudges.
 */
@Injectable()
export class PulseReminderSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PulseReminderSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastHourKey: string | null = null;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private redis: RedisService,
    private events: EventEmitter2,
  ) {}

  onModuleInit() {
    if (!this.isEnabled()) {
      this.logger.log(
        'Pulse reminders disabled (set PULSE_REMINDER_ENABLED=true to run them)',
      );
      return;
    }
    const seconds = this.intervalSeconds();
    this.timer = setInterval(() => void this.tick(), seconds);
    this.timer.unref?.();
    this.logger.log(`Pulse reminders every ${seconds}s (${this.timeZone()}, hourly)`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed so an hour can be triggered directly in tests. */
  async tick(now = new Date()): Promise<number> {
    if (this.running) {
      this.logger.warn('Previous pulse reminder tick still running; skipping');
      return 0;
    }

    const dateKey = calendarDateInTimeZone(now, this.timeZone());
    const hourId = pulseReminderHourId(now, this.timeZone());
    const hourKey = `${dateKey}:${hourId}`;
    if (this.lastHourKey === hourKey) return 0;

    if (this.redis.isConnected()) {
      const acquired = await this.redis.acquireLock('pulse:reminder', LOCK_TTL_SECONDS);
      if (!acquired) {
        this.logger.debug('Another instance holds the pulse reminder lock; skipping');
        return 0;
      }
    }

    this.running = true;
    const startedAt = Date.now();
    let dispatched = 0;
    try {
      const campaigns = await this.prisma.campaign.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
      });
      for (const campaign of campaigns) {
        dispatched += await this.runCampaign(campaign.id, dateKey, hourId, now);
      }
      this.lastHourKey = hourKey;
      this.logger.log(
        `Pulse reminder ${hourKey} finished in ${Date.now() - startedAt}ms (${dispatched} batches)`,
      );
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Pulse reminder tick failed',
      );
    } finally {
      this.running = false;
    }
    return dispatched;
  }

  private async runCampaign(
    campaignId: string,
    dateKey: string,
    hourId: string,
    now: Date,
  ): Promise<number> {
    const actorUserId = (await this.sweepActor(campaignId)) ?? '';
    const agents = await this.loadAgents(campaignId);
    if (agents.length === 0) return 0;

    const scopeIds = [...new Set(agents.map((row) => row.scopeId))];
    const [pulses, geo] = await Promise.all([
      this.loadPulses(campaignId, scopeIds),
      this.loadGeo(scopeIds),
    ]);
    const pulseByPu = new Map(pulses.map((row) => [row.pollingUnitId, row]));
    const geoByPu = new Map(geo.map((row) => [row.id, row]));

    const skipMs = this.skipRecentMinutes() * 60 * 1000;
    const agentIds: string[] = [];
    const assignedByWard = new Map<string, number>();
    const silentByWard = new Map<string, number>();
    const assignedByLga = new Map<string, number>();
    const silentByLga = new Map<string, number>();

    for (const agent of agents) {
      const unit = geoByPu.get(agent.scopeId);
      if (unit) {
        assignedByWard.set(unit.wardId, (assignedByWard.get(unit.wardId) ?? 0) + 1);
        assignedByLga.set(unit.lgaId, (assignedByLga.get(unit.lgaId) ?? 0) + 1);
      }
      const pulse = pulseByPu.get(agent.scopeId);
      if (pulse?.phase === 'CLOSED' || pulse?.phase === 'COUNTING') continue;
      const recent =
        pulse?.lastPulseAt != null && now.getTime() - pulse.lastPulseAt.getTime() < skipMs;
      if (recent) continue;
      agentIds.push(agent.userId);
      const silent = isPulseSilent({
        phase: pulse?.phase ?? null,
        lastPulseAt: pulse?.lastPulseAt ?? null,
        now,
      });
      if (silent && unit) {
        silentByWard.set(unit.wardId, (silentByWard.get(unit.wardId) ?? 0) + 1);
        silentByLga.set(unit.lgaId, (silentByLga.get(unit.lgaId) ?? 0) + 1);
      }
    }

    let batches = 0;
    batches += this.emitAgentReminders(campaignId, actorUserId, dateKey, hourId, agentIds);

    const wardOfficers = await this.loadOfficers(campaignId, WARD_ROLES, ScopeType.WARD);
    const officersByWard = groupByScope(wardOfficers);
    for (const [wardId, userIds] of officersByWard) {
      const silentCount = silentByWard.get(wardId) ?? 0;
      if (silentCount === 0) continue;
      this.emitCommandReminder({
        campaignId,
        actorUserId,
        dateKey,
        hourId,
        audience: 'ward',
        scopeId: wardId,
        userIds,
        silentCount,
        totalAssigned: assignedByWard.get(wardId) ?? silentCount,
        wardId,
      });
      batches += 1;
    }

    const lgaOfficers = await this.loadOfficers(campaignId, LGA_ROLES, ScopeType.LGA);
    const officersByLga = groupByScope(lgaOfficers);
    for (const [lgaId, userIds] of officersByLga) {
      const silentCount = silentByLga.get(lgaId) ?? 0;
      if (silentCount === 0) continue;
      this.emitCommandReminder({
        campaignId,
        actorUserId,
        dateKey,
        hourId,
        audience: 'lga',
        scopeId: lgaId,
        userIds,
        silentCount,
        totalAssigned: assignedByLga.get(lgaId) ?? silentCount,
        lgaId,
      });
      batches += 1;
    }

    return batches;
  }

  private emitAgentReminders(
    campaignId: string,
    actorUserId: string,
    dateKey: string,
    hourId: string,
    userIds: string[],
  ): number {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return 0;
    const sourceEventId = pulseReminderSourceEventId({
      campaignId,
      dateKey,
      slotId: hourId,
      audience: 'agent',
    });
    let batches = 0;
    for (const group of chunk(unique, RECIPIENT_CHUNK)) {
      this.events.emit(NOTIFICATION_DISPATCH_EVENT, {
        type: NotificationType.PULSE_REMINDER,
        campaignId,
        actorUserId,
        entityType: 'PULSE_REMINDER',
        entityId: campaignId,
        sourceEventId,
        sendPush: true,
        pulseReminder: {
          audience: 'agent',
          slotId: hourId,
        },
        explicitRecipients: group.map((userId) => ({ userId, sendPush: true })),
      } satisfies NotificationDispatchPayload);
      batches += 1;
    }
    return batches;
  }

  private emitCommandReminder(input: {
    campaignId: string;
    actorUserId: string;
    dateKey: string;
    hourId: string;
    audience: 'ward' | 'lga';
    scopeId: string;
    userIds: string[];
    silentCount: number;
    totalAssigned: number;
    wardId?: string;
    lgaId?: string;
  }) {
    const unique = [...new Set(input.userIds)];
    if (unique.length === 0) return;
    this.events.emit(NOTIFICATION_DISPATCH_EVENT, {
      type: NotificationType.PULSE_REMINDER,
      campaignId: input.campaignId,
      actorUserId: input.actorUserId,
      entityType: 'PULSE_REMINDER',
      entityId: input.scopeId,
      sourceEventId: pulseReminderSourceEventId({
        campaignId: input.campaignId,
        dateKey: input.dateKey,
        slotId: input.hourId,
        audience: input.audience,
        scopeId: input.scopeId,
      }),
      sendPush: true,
      pulseReminder: {
        audience: input.audience,
        slotId: input.hourId,
        silentCount: input.silentCount,
        totalAssigned: input.totalAssigned,
        wardId: input.wardId,
        lgaId: input.lgaId,
      },
      explicitRecipients: unique.map((userId) => ({ userId, sendPush: true })),
    } satisfies NotificationDispatchPayload);
  }

  private async loadAgents(campaignId: string): Promise<AgentRow[]> {
    const rows: AgentRow[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.prisma.campaignMembership.findMany({
        where: {
          campaignId,
          isActive: true,
          role: { in: PU_ROLES },
          scopeType: ScopeType.POLLING_UNIT,
          scopeId: { not: null },
        },
        select: { id: true, userId: true, scopeId: true },
        take: MEMBERSHIP_PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
      });
      for (const row of page) {
        if (row.scopeId) rows.push({ userId: row.userId, scopeId: row.scopeId });
      }
      if (page.length < MEMBERSHIP_PAGE) break;
      cursor = page[page.length - 1]?.id;
      if (!cursor) break;
    }
    return rows;
  }

  private async loadOfficers(
    campaignId: string,
    roles: CampaignRole[],
    scopeType: ScopeType,
  ): Promise<Array<{ userId: string; scopeId: string }>> {
    const rows = await this.prisma.campaignMembership.findMany({
      where: {
        campaignId,
        isActive: true,
        role: { in: roles },
        scopeType,
        scopeId: { not: null },
      },
      select: { userId: true, scopeId: true },
    });
    return rows.filter((row): row is { userId: string; scopeId: string } => Boolean(row.scopeId));
  }

  private async loadPulses(campaignId: string, pollingUnitIds: string[]): Promise<PulseRow[]> {
    if (pollingUnitIds.length === 0) return [];
    const rows: PulseRow[] = [];
    for (const ids of chunk(pollingUnitIds, 1000)) {
      const page = await this.prisma.pollingUnitPulse.findMany({
        where: { campaignId, pollingUnitId: { in: ids } },
        select: { pollingUnitId: true, phase: true, lastPulseAt: true },
      });
      rows.push(...page);
    }
    return rows;
  }

  private async loadGeo(pollingUnitIds: string[]): Promise<GeoRow[]> {
    if (pollingUnitIds.length === 0) return [];
    const rows: GeoRow[] = [];
    for (const ids of chunk(pollingUnitIds, 1000)) {
      const page = await this.prisma.pollingUnit.findMany({
        where: { id: { in: ids } },
        select: { id: true, wardId: true, ward: { select: { lgaId: true } } },
      });
      for (const row of page) {
        rows.push({ id: row.id, wardId: row.wardId, lgaId: row.ward.lgaId });
      }
    }
    return rows;
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

  private isEnabled(): boolean {
    return (this.config.get<string>('PULSE_REMINDER_ENABLED') ?? '').toLowerCase() === 'true';
  }

  private intervalSeconds(): number {
    const raw = Number(this.config.get<string>('PULSE_REMINDER_INTERVAL_SEC'));
    if (!Number.isFinite(raw) || raw < 15) return DEFAULT_INTERVAL_SECONDS;
    return Math.floor(raw);
  }

  private timeZone(): string {
    return this.config.get<string>('PULSE_REMINDER_TIMEZONE')?.trim() || 'Africa/Lagos';
  }

  private skipRecentMinutes(): number {
    const raw = Number(this.config.get<string>('PULSE_REMINDER_SKIP_RECENT_MINUTES'));
    if (!Number.isFinite(raw) || raw < 0) return DEFAULT_SKIP_RECENT_MINUTES;
    return Math.floor(raw);
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function groupByScope(rows: Array<{ userId: string; scopeId: string }>): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const list = grouped.get(row.scopeId) ?? [];
    list.push(row.userId);
    grouped.set(row.scopeId, list);
  }
  return grouped;
}
