import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WhatsAppInboundService } from './whatsapp-inbound.service';
import { WHATSAPP_INBOUND_EVENT } from './whatsapp.events';

const inbound = {
  type: 'inbound',
  message_id: 'wamid.A',
  sender: '234801',
  message: 'one',
  channel: 'whatsapp',
};

describe('WhatsAppInboundService', () => {
  it('persists a Termii inbound and emits a job', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'in-1' });
    const prisma = {
      whatsAppInboundMessage: { create },
    } as unknown as PrismaService;
    const events = { emit: jest.fn() } as unknown as EventEmitter2;
    const service = new WhatsAppInboundService(prisma, events);

    const result = await service.ingestWebhook(inbound);

    expect(result).toEqual({ accepted: 1, seen: 1 });
    expect(events.emit).toHaveBeenCalledWith(WHATSAPP_INBOUND_EVENT, { inboundId: 'in-1' });
  });

  it('treats a duplicate message_id as already accepted', async () => {
    const prisma = {
      whatsAppInboundMessage: {
        create: jest.fn().mockRejectedValue({ code: 'P2002' }),
      },
    } as unknown as PrismaService;
    const events = { emit: jest.fn() } as unknown as EventEmitter2;
    const service = new WhatsAppInboundService(prisma, events);

    const result = await service.ingestWebhook(inbound);

    expect(result).toEqual({ accepted: 0, seen: 1 });
    expect(events.emit).not.toHaveBeenCalled();
  });
});
