import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CampaignRole, JwtPayload, ScopeType } from '@electromon/shared';
import { AiChatMessageRole } from '@electromon/db';
import { AssistantThreadsService } from './assistant-threads.service';

const user: JwtPayload = {
  sub: 'user-1',
  email: 'director@example.com',
  campaignId: 'campaign-1',
  role: CampaignRole.CAMPAIGN_DIRECTOR,
  scopeType: ScopeType.CAMPAIGN,
};

describe('AssistantThreadsService', () => {
  let prisma: any;
  let service: AssistantThreadsService;

  beforeEach(() => {
    prisma = {
      campaignMembership: {
        findFirst: jest.fn().mockResolvedValue({ id: 'membership-1' }),
      },
      aiChatThread: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      aiChatMessage: {
        findMany: jest.fn(),
        create: jest.fn(),
        createMany: jest.fn(),
      },
    };
    service = new AssistantThreadsService(prisma);
  });

  it('lists threads for the current user', async () => {
    prisma.aiChatThread.findMany.mockResolvedValue([
      {
        id: 'thread-1',
        title: 'Race pressure',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ]);

    const result = await service.listThreads(user);

    expect(result.threads).toHaveLength(1);
    expect(result.threads[0].title).toBe('Race pressure');
  });

  it('creates a thread scoped to the user and campaign', async () => {
    prisma.aiChatThread.create.mockResolvedValue({
      id: 'thread-1',
      title: 'New chat',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const result = await service.createThread(user);

    expect(prisma.aiChatThread.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          campaignId: 'campaign-1',
          userId: 'user-1',
        }),
      }),
    );
    expect(result.messages).toEqual([]);
  });

  it('rejects access to another users thread', async () => {
    prisma.aiChatThread.findFirst.mockResolvedValue(null);

    await expect(service.getThread(user, 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('loads ordered messages for a thread', async () => {
    prisma.aiChatThread.findFirst.mockResolvedValue({
      id: 'thread-1',
      title: 'Coverage',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    prisma.aiChatMessage.findMany.mockResolvedValue([
      {
        id: 'm1',
        role: AiChatMessageRole.USER,
        content: 'Hello',
        replyToId: null,
        spoken: null,
        meta: null,
        attachments: null,
        charts: null,
        contacts: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);

    const result = await service.getThread(user, 'thread-1');

    expect(result.messages).toEqual([
      expect.objectContaining({ id: 'm1', role: 'user', content: 'Hello' }),
    ]);
  });

  it('requires campaign membership', async () => {
    prisma.campaignMembership.findFirst.mockResolvedValue(null);

    await expect(service.listThreads(user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
