import { Test, TestingModule } from '@nestjs/testing';
import { NotificationPriority, NotificationType, CampaignRole, ScopeType } from '@electromon/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { createMockPrismaService } from '../../../test/helpers/prisma.mock';
import { TEST_CAMPAIGN_ID } from '../../../test/helpers/fixtures';
import { FcmService } from './fcm.service';
import { NotificationsService } from './notifications.service';
import { RecipientResolverService } from './recipient-resolver.service';
import { NotificationDispatchPayload } from './notification.events';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let prisma: ReturnType<typeof createMockPrismaService>;
  let fcm: { send: jest.Mock; tokensForUsers: jest.Mock };
  let recipients: { resolve: jest.Mock; resolveScopeLabel: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrismaService();
    fcm = {
      send: jest.fn().mockResolvedValue(undefined),
      tokensForUsers: jest.fn().mockResolvedValue([{ userId: 'ward-1', token: 'tok-1', platform: 'ANDROID' }]),
    };
    recipients = {
      resolve: jest.fn().mockResolvedValue([{ userId: 'ward-1', sendPush: true }]),
      resolveScopeLabel: jest.fn().mockResolvedValue('Kargi PU'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RecipientResolverService, useValue: recipients },
        { provide: FcmService, useValue: fcm },
      ],
    }).compile();

    service = module.get(NotificationsService);
  });

  const payload: NotificationDispatchPayload = {
    type: NotificationType.RESULT_SUBMITTED,
    campaignId: TEST_CAMPAIGN_ID,
    actorUserId: 'agent-1',
    entityType: 'COLLATION_RESULT',
    entityId: 'result-1',
    sourceEventId: 'log-1',
    sendPush: true,
    collationResult: {
      level: 'POLLING_UNIT',
      scopeType: ScopeType.POLLING_UNIT,
      scopeId: 'pu-1',
      submittedById: 'agent-1',
    },
  };

  it('persists an inbox row then sends FCM without vote figures in the copy', async () => {
    prisma.notification.create.mockResolvedValue({ id: 'n-1' });

    await service.dispatch(payload);

    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recipientUserId: 'ward-1',
          title: 'New PU result submitted',
          body: 'Kargi PU submitted results for review.',
          priority: NotificationPriority.HIGH,
        }),
      }),
    );
    const created = prisma.notification.create.mock.calls[0][0].data;
    expect(JSON.stringify(created)).not.toMatch(/votes|accredited|registered/i);
    expect(fcm.send).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: ['tok-1'],
        title: 'New PU result submitted',
      }),
    );
  });

  it('swallows unique-constraint duplicates', async () => {
    prisma.notification.create.mockRejectedValue({ code: 'P2002' });

    await expect(service.dispatch(payload)).resolves.toEqual([]);
    expect(fcm.send).not.toHaveBeenCalled();
  });

  it('creates a first-open status reminder without FCM', async () => {
    recipients.resolve.mockResolvedValue([{ userId: 'agent-1', sendPush: false }]);
    prisma.campaignMembership.findFirst.mockResolvedValue({ userId: 'director-1' });
    prisma.notification.create.mockResolvedValue({ id: 'n-pulse' });
    prisma.notification.findFirst.mockResolvedValue({
      id: 'n-pulse',
      type: NotificationType.PULSE_REMINDER,
      priority: NotificationPriority.HIGH,
      title: 'Send your status update',
      body: 'Tap All fine if nothing change.',
      entityType: 'PULSE_REMINDER',
      entityId: TEST_CAMPAIGN_ID,
      data: { route: 'agent.pulseUpdate' },
      readAt: null,
      createdAt: new Date('2026-02-25T09:05:00.000Z'),
    });

    const result = await service.nudgePulseReminder({
      sub: 'agent-1',
      email: 'agent@test.ng',
      campaignId: TEST_CAMPAIGN_ID,
      role: CampaignRole.POLLING_AGENT,
      scopeId: 'pu-1',
    });

    expect(result.created).toBe(true);
    expect(result.notification?.title).toBe('Send your status update');
    expect(fcm.send).not.toHaveBeenCalled();
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recipientUserId: 'agent-1',
          title: 'Send your status update',
        }),
      }),
    );
  });

  it('skips a first-open nudge for roles that do not send pulse', async () => {
    const result = await service.nudgePulseReminder({
      sub: 'director-1',
      email: 'director@test.ng',
      campaignId: TEST_CAMPAIGN_ID,
      role: CampaignRole.CAMPAIGN_DIRECTOR,
    });
    expect(result).toEqual({ created: false, skipped: true, notification: null });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });
});
