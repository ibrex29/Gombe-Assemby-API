import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AiChatMessageRole, Prisma } from '@electromon/db';
import { JwtPayload } from '@electromon/shared';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { ChatTurnDto } from './dto/chat.dto';
import { CreateChatThreadDto } from './dto/chat-thread.dto';

const THREAD_LIST_LIMIT = 40;
const MESSAGE_HISTORY_LIMIT = 60;

function deriveTitle(content: string): string {
  const text = content.trim().replace(/\s+/g, ' ');
  if (!text) return 'New chat';
  return text.length > 52 ? `${text.slice(0, 52)}…` : text;
}

function toClientRole(role: AiChatMessageRole): 'user' | 'assistant' {
  return role === AiChatMessageRole.USER ? 'user' : 'assistant';
}

function mapMessage(message: {
  id: string;
  role: AiChatMessageRole;
  content: string;
  replyToId: string | null;
  spoken: string | null;
  meta: Prisma.JsonValue;
  attachments: Prisma.JsonValue;
  charts: Prisma.JsonValue;
  contacts: Prisma.JsonValue;
  createdAt: Date;
}) {
  return {
    id: message.id,
    role: toClientRole(message.role),
    content: message.content,
    replyTo: message.replyToId,
    spoken: message.spoken,
    meta: message.meta as
      | { grounded: boolean; suppressed: boolean; model: string }
      | null
      | undefined,
    attachments: (message.attachments as unknown[] | null) ?? undefined,
    charts: (message.charts as unknown[] | null) ?? undefined,
    contacts: (message.contacts as unknown[] | null) ?? undefined,
    createdAt: message.createdAt.toISOString(),
  };
}

@Injectable()
export class AssistantThreadsService {
  constructor(private prisma: PrismaService) {}

  private async assertCampaignAccess(userId: string, campaignId: string) {
    const membership = await this.prisma.campaignMembership.findFirst({
      where: { userId, campaignId, isActive: true },
    });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this campaign');
    }
  }

  private async getOwnedThread(user: JwtPayload, threadId: string) {
    if (!user.campaignId) {
      throw new ForbiddenException('Campaign membership required');
    }
    await this.assertCampaignAccess(user.sub, user.campaignId);

    const thread = await this.prisma.aiChatThread.findFirst({
      where: {
        id: threadId,
        campaignId: user.campaignId,
        userId: user.sub,
      },
    });
    if (!thread) {
      throw new NotFoundException('Chat thread not found');
    }
    return thread;
  }

  async listThreads(user: JwtPayload) {
    if (!user.campaignId) {
      throw new ForbiddenException('Campaign membership required');
    }
    await this.assertCampaignAccess(user.sub, user.campaignId);

    const threads = await this.prisma.aiChatThread.findMany({
      where: { campaignId: user.campaignId, userId: user.sub },
      orderBy: { updatedAt: 'desc' },
      take: THREAD_LIST_LIMIT,
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      threads: threads.map((thread) => ({
        id: thread.id,
        title: thread.title,
        createdAt: thread.createdAt.toISOString(),
        updatedAt: thread.updatedAt.toISOString(),
      })),
    };
  }

  async createThread(user: JwtPayload, dto: CreateChatThreadDto = {}) {
    if (!user.campaignId) {
      throw new ForbiddenException('Campaign membership required');
    }
    await this.assertCampaignAccess(user.sub, user.campaignId);

    const thread = await this.prisma.aiChatThread.create({
      data: {
        campaignId: user.campaignId,
        userId: user.sub,
        title: dto.title?.trim() || 'New chat',
      },
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      ...thread,
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
      messages: [],
    };
  }

  async getThread(user: JwtPayload, threadId: string) {
    const thread = await this.getOwnedThread(user, threadId);
    const messages = await this.prisma.aiChatMessage.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: 'asc' },
      take: MESSAGE_HISTORY_LIMIT,
    });

    return {
      id: thread.id,
      title: thread.title,
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
      messages: messages.map(mapMessage),
    };
  }

  async deleteThread(user: JwtPayload, threadId: string) {
    await this.getOwnedThread(user, threadId);
    await this.prisma.aiChatThread.delete({ where: { id: threadId } });
    return { message: 'Chat deleted' };
  }

  async loadHistoryTurns(threadId: string): Promise<ChatTurnDto[]> {
    const messages = await this.prisma.aiChatMessage.findMany({
      where: { threadId },
      orderBy: { createdAt: 'asc' },
      take: MESSAGE_HISTORY_LIMIT,
      select: { role: true, content: true },
    });

    return messages.map((message) => ({
      role: toClientRole(message.role),
      content: message.content,
    }));
  }

  async resolveThreadForChat(
    user: JwtPayload,
    threadId: string | undefined,
    seedHistory: ChatTurnDto[] | undefined,
  ): Promise<{ threadId: string; history: ChatTurnDto[] }> {
    if (!user.campaignId) {
      throw new ForbiddenException('Campaign membership required');
    }
    await this.assertCampaignAccess(user.sub, user.campaignId);

    if (threadId) {
      await this.getOwnedThread(user, threadId);
      const history = await this.loadHistoryTurns(threadId);
      return { threadId, history };
    }

    const created = await this.prisma.aiChatThread.create({
      data: {
        campaignId: user.campaignId,
        userId: user.sub,
      },
    });

    const history = seedHistory ?? [];
    if (history.length > 0) {
      await this.prisma.aiChatMessage.createMany({
        data: history.map((turn) => ({
          threadId: created.id,
          role:
            turn.role === 'user'
              ? AiChatMessageRole.USER
              : AiChatMessageRole.ASSISTANT,
          content: turn.content,
        })),
      });
      const firstUser = history.find((turn) => turn.role === 'user');
      if (firstUser) {
        await this.prisma.aiChatThread.update({
          where: { id: created.id },
          data: { title: deriveTitle(firstUser.content) },
        });
      }
    }

    return { threadId: created.id, history };
  }

  async appendUserMessage(threadId: string, content: string) {
    const message = await this.prisma.aiChatMessage.create({
      data: {
        threadId,
        role: AiChatMessageRole.USER,
        content,
      },
    });

    const thread = await this.prisma.aiChatThread.findUniqueOrThrow({
      where: { id: threadId },
      select: { title: true },
    });

    const updates: Prisma.AiChatThreadUpdateInput = { updatedAt: new Date() };
    if (thread.title === 'New chat') {
      updates.title = deriveTitle(content);
    }

    await this.prisma.aiChatThread.update({
      where: { id: threadId },
      data: updates,
    });

    return message;
  }

  async appendAssistantMessage(
    threadId: string,
    replyToId: string,
    result: {
      reply: string;
      spoken: string | null;
      grounded: boolean;
      suppressed: boolean;
      model: string;
      attachments: unknown[];
      charts: unknown[];
      contacts: unknown[];
    },
  ) {
    const message = await this.prisma.aiChatMessage.create({
      data: {
        threadId,
        role: AiChatMessageRole.ASSISTANT,
        content: result.reply,
        replyToId,
        spoken: result.spoken,
        meta: {
          grounded: result.grounded,
          suppressed: result.suppressed,
          model: result.model,
        },
        attachments: result.attachments as unknown as Prisma.InputJsonValue,
        charts: result.charts as unknown as Prisma.InputJsonValue,
        contacts: result.contacts as unknown as Prisma.InputJsonValue,
      },
    });

    await this.prisma.aiChatThread.update({
      where: { id: threadId },
      data: { updatedAt: new Date() },
    });

    return message;
  }
}
