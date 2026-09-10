import { Test, TestingModule } from '@nestjs/testing';
import { CampaignRole, NotificationType, ScopeType } from '@electromon/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ScopeResolverService } from '../../common/collation/scope-resolver.service';
import { createMockPrismaService } from '../../../test/helpers/prisma.mock';
import { RecipientResolverService } from './recipient-resolver.service';
import { NotificationDispatchPayload } from './notification.events';

const CAMPAIGN_ID = 'camp-1';
const WARD_ID = 'ward-1';
const PU_ID = 'pu-1';
const ACTOR_ID = 'actor-1';
const WARD_OFFICER_ID = 'ward-officer-1';
const PU_AGENT_ID = 'pu-agent-1';

describe('RecipientResolverService', () => {
  let service: RecipientResolverService;
  let prisma: ReturnType<typeof createMockPrismaService>;

  beforeEach(async () => {
    prisma = createMockPrismaService();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecipientResolverService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ScopeResolverService,
          useValue: {
            resolveScopeName: jest.fn().mockResolvedValue('Kargi PU'),
            resolveScopeChain: jest.fn().mockResolvedValue({
              ward: { id: WARD_ID },
              lga: { id: 'lga-1' },
            }),
          },
        },
      ],
    }).compile();
    service = module.get(RecipientResolverService);
  });

  function payload(
    overrides: Partial<NotificationDispatchPayload> = {},
  ): NotificationDispatchPayload {
    return {
      type: NotificationType.RESULT_SUBMITTED,
      campaignId: CAMPAIGN_ID,
      actorUserId: ACTOR_ID,
      entityType: 'COLLATION_RESULT',
      entityId: 'result-1',
      sourceEventId: 'log-1',
      sendPush: true,
      collationResult: {
        level: 'POLLING_UNIT',
        scopeType: ScopeType.POLLING_UNIT,
        scopeId: PU_ID,
        submittedById: PU_AGENT_ID,
      },
      ...overrides,
    };
  }

  it('resolves ward officers for a PU submission and excludes the actor', async () => {
    prisma.pollingUnit.findUnique.mockResolvedValue({ wardId: WARD_ID });
    prisma.campaignMembership.findMany.mockResolvedValue([
      { userId: WARD_OFFICER_ID },
      { userId: ACTOR_ID },
    ]);

    const recipients = await service.resolve(payload());

    expect(recipients).toEqual([{ userId: WARD_OFFICER_ID, sendPush: true }]);
    expect(prisma.campaignMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          campaignId: CAMPAIGN_ID,
          scopeType: ScopeType.WARD,
          scopeId: WARD_ID,
          role: { in: [CampaignRole.WARD_RA_OFFICER, CampaignRole.WARD_COORDINATOR] },
        }),
      }),
    );
  });

  it('returns an empty list when no ward officer is assigned', async () => {
    prisma.pollingUnit.findUnique.mockResolvedValue({ wardId: WARD_ID });
    prisma.campaignMembership.findMany.mockResolvedValue([]);

    await expect(service.resolve(payload())).resolves.toEqual([]);
  });

  it('notifies the submitting PU agent on return, not every PU in the ward', async () => {
    const recipients = await service.resolve(
      payload({
        type: NotificationType.RESULT_RETURNED,
        collationResult: {
          level: 'POLLING_UNIT',
          scopeType: ScopeType.POLLING_UNIT,
          scopeId: PU_ID,
          submittedById: PU_AGENT_ID,
        },
      }),
    );

    expect(recipients).toEqual([{ userId: PU_AGENT_ID, sendPush: true }]);
    expect(prisma.campaignMembership.findMany).not.toHaveBeenCalled();
  });

  it('does not leak recipients across campaigns', async () => {
    prisma.pollingUnit.findUnique.mockResolvedValue({ wardId: WARD_ID });
    prisma.campaignMembership.findMany.mockResolvedValue([{ userId: WARD_OFFICER_ID }]);

    await service.resolve(payload({ campaignId: 'other-campaign' }));

    expect(prisma.campaignMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ campaignId: 'other-campaign' }),
      }),
    );
  });

  it('notifies ward officers when a reviewer comments on a ward result', async () => {
    prisma.campaignMembership.findMany.mockResolvedValue([{ userId: WARD_OFFICER_ID }]);

    const recipients = await service.resolve(
      payload({
        type: NotificationType.RESULT_COMMENTED,
        collationResult: {
          level: 'WARD',
          scopeType: ScopeType.WARD,
          scopeId: WARD_ID,
          submittedById: WARD_OFFICER_ID,
        },
      }),
    );

    expect(recipients).toEqual([{ userId: WARD_OFFICER_ID, sendPush: true }]);
  });

  it('uses explicit recipients for pulse reminders', async () => {
    const recipients = await service.resolve(
      payload({
        type: NotificationType.PULSE_REMINDER,
        entityType: 'PULSE_REMINDER',
        entityId: 'pu-1',
        sourceEventId: 'pulse-reminder:camp-1:2026-02-25:hour-07:agent',
        collationResult: undefined,
        pulseReminder: {
          audience: 'agent',
          slotId: 'hour-07',
        },
        explicitRecipients: [
          { userId: PU_AGENT_ID, sendPush: true },
          { userId: ACTOR_ID, sendPush: true },
        ],
      }),
    );

    expect(recipients).toEqual([{ userId: PU_AGENT_ID, sendPush: true }]);
  });
});
