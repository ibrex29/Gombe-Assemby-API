import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@electromon/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { extractWhatsAppMessages } from './whatsapp-inbound.parser';
import { WHATSAPP_INBOUND_EVENT, type WhatsAppInboundJob } from './whatsapp.events';

@Injectable()
export class WhatsAppInboundService {
  private readonly logger = new Logger(WhatsAppInboundService.name);

  constructor(
    private prisma: PrismaService,
    private events: EventEmitter2,
  ) {}

  async ingestWebhook(payload: unknown) {
    const messages = extractWhatsAppMessages(payload);
    let accepted = 0;

    for (const message of messages) {
      try {
        const created = await this.prisma.whatsAppInboundMessage.create({
          data: {
            wamid: message.wamid,
            fromPhone: message.from,
            payload: message as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        const job: WhatsAppInboundJob = { inboundId: created.id };
        this.events.emit(WHATSAPP_INBOUND_EVENT, job);
        accepted += 1;
      } catch (error) {
        if (this.isUniqueViolation(error)) continue;
        this.logger.warn({ err: error, wamid: message.wamid }, 'Failed to persist WhatsApp inbound');
      }
    }

    return { accepted, seen: messages.length };
  }

  private isUniqueViolation(error: unknown) {
    return (
      typeof error === 'object' &&
      error != null &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    );
  }
}
