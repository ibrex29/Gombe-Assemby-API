import {
  CampaignRole,
  NotificationType,
  pulseReminderHourId,
  pulseReminderSourceEventId,
} from '@electromon/shared';
import { PulseReminderSchedulerService } from './pulse-reminder-scheduler.service';
import { NOTIFICATION_DISPATCH_EVENT } from '../notifications/notification.events';

function build(overrides: Record<string, string> = {}) {
  const config = {
    get: (key: string) => overrides[key],
  } as never;
  const emit = jest.fn();
  const prisma = {
    campaign: {
      findMany: jest.fn().mockResolvedValue([{ id: 'campaign-1', name: 'A4A' }]),
    },
    campaignMembership: {
      findFirst: jest.fn().mockResolvedValue({ userId: 'director-1' }),
      findMany: jest.fn(),
    },
    pollingUnitPulse: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    pollingUnit: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'pu-1', wardId: 'ward-1', ward: { lgaId: 'lga-1' } },
      ]),
    },
  };
  const redis = {
    isConnected: jest.fn().mockReturnValue(false),
    acquireLock: jest.fn().mockResolvedValue(true),
  };
  const events = { emit };

  prisma.campaignMembership.findMany.mockImplementation(
    async (args: { where?: { role?: { in?: CampaignRole[] } } }) => {
      const roles = args.where?.role?.in ?? [];
      if (roles.includes(CampaignRole.POLLING_AGENT)) {
        return [{ id: 'm-agent', userId: 'agent-1', scopeId: 'pu-1' }];
      }
      if (roles.includes(CampaignRole.WARD_RA_OFFICER)) {
        return [{ userId: 'ward-1-officer', scopeId: 'ward-1' }];
      }
      if (roles.includes(CampaignRole.LGA_COLLATION_OFFICER)) {
        return [{ userId: 'lga-1-officer', scopeId: 'lga-1' }];
      }
      return [];
    },
  );

  const service = new PulseReminderSchedulerService(
    config,
    prisma as never,
    redis as never,
    events as never,
  );
  return { service, prisma, redis, emit };
}

describe('PulseReminderSchedulerService', () => {
  it('does not start unless explicitly enabled', () => {
    const { service } = build();
    const spy = jest.spyOn(global, 'setInterval');
    service.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('fires once per clock hour', async () => {
    const { service, emit } = build({ PULSE_REMINDER_ENABLED: 'true' });
    const now = new Date('2026-02-25T09:05:00.000Z');
    expect(await service.tick(now)).toBeGreaterThan(0);
    expect(emit).toHaveBeenCalled();
    emit.mockClear();
    expect(await service.tick(now)).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('notifies the PU agent, ward officer, and LGA officer', async () => {
    const { service, emit } = build({ PULSE_REMINDER_ENABLED: 'true' });
    const dispatched = await service.tick(new Date('2026-02-25T09:05:00.000Z'));
    expect(dispatched).toBeGreaterThanOrEqual(3);
    const types = emit.mock.calls.map((call) => call[0]);
    expect(types.every((type) => type === NOTIFICATION_DISPATCH_EVENT)).toBe(true);
    const payloads = emit.mock.calls.map(
      (call) => call[1] as { type: string; pulseReminder?: { audience: string; slotId: string } },
    );
    expect(payloads.every((payload) => payload.type === NotificationType.PULSE_REMINDER)).toBe(true);
    expect(payloads.every((payload) => payload.pulseReminder?.slotId === 'hour-10')).toBe(true);
    const audiences = payloads.map((payload) => payload.pulseReminder?.audience).sort();
    expect(audiences).toEqual(['agent', 'lga', 'ward']);
  });

  it('skips an agent who already pulsed in the skip window', async () => {
    const { service, emit, prisma } = build({
      PULSE_REMINDER_ENABLED: 'true',
      PULSE_REMINDER_SKIP_RECENT_MINUTES: '50',
    });
    prisma.pollingUnitPulse.findMany.mockResolvedValue([
      {
        pollingUnitId: 'pu-1',
        phase: 'VOTING',
        lastPulseAt: new Date('2026-02-25T08:55:00.000Z'),
      },
    ]);
    await service.tick(new Date('2026-02-25T09:05:00.000Z'));
    const payloads = emit.mock.calls.map(
      (call) => call[1] as { pulseReminder?: { audience: string } },
    );
    expect(payloads.some((payload) => payload.pulseReminder?.audience === 'agent')).toBe(false);
    expect(payloads.some((payload) => payload.pulseReminder?.audience === 'ward')).toBe(false);
  });

  it('skips an agent whose unit is already counting', async () => {
    const { service, emit, prisma } = build({ PULSE_REMINDER_ENABLED: 'true' });
    prisma.pollingUnitPulse.findMany.mockResolvedValue([
      {
        pollingUnitId: 'pu-1',
        phase: 'COUNTING',
        lastPulseAt: new Date('2026-02-25T07:00:00.000Z'),
      },
    ]);
    await service.tick(new Date('2026-02-25T09:05:00.000Z'));
    const payloads = emit.mock.calls.map(
      (call) => call[1] as { pulseReminder?: { audience: string } },
    );
    expect(payloads.some((payload) => payload.pulseReminder?.audience === 'agent')).toBe(false);
  });

  it('skips when another instance holds the lock', async () => {
    const { service, redis, emit } = build({ PULSE_REMINDER_ENABLED: 'true' });
    redis.isConnected.mockReturnValue(true);
    redis.acquireLock.mockResolvedValue(false);
    await service.tick(new Date('2026-02-25T09:05:00.000Z'));
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('pulseReminderHourId', () => {
  it('buckets Africa/Lagos into a clock hour', () => {
    expect(pulseReminderHourId(new Date('2026-02-25T09:05:00.000Z'), 'Africa/Lagos')).toBe(
      'hour-10',
    );
  });
});

describe('pulseReminderSourceEventId', () => {
  it('dedupes one reminder per campaign, day, hour, and audience', () => {
    expect(
      pulseReminderSourceEventId({
        campaignId: 'c1',
        dateKey: '2026-02-25',
        slotId: 'hour-10',
        audience: 'ward',
        scopeId: 'ward-1',
      }),
    ).toBe('pulse-reminder:c1:2026-02-25:hour-10:ward:ward-1');
  });
});
