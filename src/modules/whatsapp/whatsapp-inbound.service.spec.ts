import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WhatsAppInboundService } from './whatsapp-inbound.service';
import { WHATSAPP_INBOUND_EVENT } from './whatsapp.events';

describe('WhatsAppInboundService', () => {
  it('persists each message and emits an inbound job', async () => {
    const create = jest.fn()
      .mockResolvedValueOnce({ id: 'in-1' })
      .mockResolvedValueOnce({ id: 'in-2' });
    const prisma = {
      whatsAppInboundMessage: { create },
    } as unknown as PrismaService;
    const events = { emit: jest.fn() } as unknown as EventEmitter2;
    const service = new WhatsAppInboundService(prisma, events);

    const result = await service.ingestWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { from: '234801', id: 'wamid.A', type: 'text', text: { body: 'one' } },
                  { from: '234801', id: 'wamid.B', type: 'text', text: { body: 'two' } },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(result).toEqual({ accepted: 2, seen: 2 });
    expect(events.emit).toHaveBeenCalledTimes(2);
    expect(events.emit).toHaveBeenCalledWith(WHATSAPP_INBOUND_EVENT, { inboundId: 'in-1' });
  });

  it('treats a duplicate wamid as already accepted', async () => {
    const prisma = {
      whatsAppInboundMessage: {
        create: jest.fn().mockRejectedValue({ code: 'P2002' }),
      },
    } as unknown as PrismaService;
    const events = { emit: jest.fn() } as unknown as EventEmitter2;
    const service = new WhatsAppInboundService(prisma, events);

    const result = await service.ingestWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ from: '234801', id: 'wamid.A', type: 'text', text: { body: 'again' } }],
              },
            },
          ],
        },
      ],
    });

    expect(result).toEqual({ accepted: 0, seen: 1 });
    expect(events.emit).not.toHaveBeenCalled();
  });
});
