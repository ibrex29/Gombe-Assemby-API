import {
  extractWhatsAppMessages,
  isHelpCommand,
  parseStoredWhatsAppMessage,
} from './whatsapp-inbound.parser';

const inbound = {
  type: 'inbound',
  id: '8248611476370959318',
  message_id: '3905204342778053556',
  receiver: '12022214836',
  sender: '2347069549231',
  message: 'Thugs at the gate',
  received_at: '2020-12-16T10:51:03.000000Z',
  status: 'Received',
  channel: 'whatsapp',
};

describe('extractWhatsAppMessages', () => {
  it('parses a Termii inbound text message', () => {
    const messages = extractWhatsAppMessages(inbound);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      wamid: '3905204342778053556',
      from: '2347069549231',
      text: 'Thugs at the gate',
      type: 'text',
    });
  });

  it('parses inbound media URLs', () => {
    const messages = extractWhatsAppMessages({
      ...inbound,
      message: '',
      media: { url: 'https://cdn.termii.com/shot.jpg', caption: 'EC8A torn' },
    });
    expect(messages[0]?.image).toMatchObject({
      url: 'https://cdn.termii.com/shot.jpg',
      caption: 'EC8A torn',
    });
  });

  it('ignores delivery reports and device status', () => {
    expect(extractWhatsAppMessages({ type: 'device_status', device_id: 'x' })).toEqual([]);
    expect(
      extractWhatsAppMessages({
        type: 'outbound',
        message_id: '1',
        sender: 'Pantamiyya',
        receiver: '2347069549231',
      }),
    ).toEqual([]);
  });

  it('reads a stored parsed payload back', () => {
    const [first] = extractWhatsAppMessages(inbound);
    expect(parseStoredWhatsAppMessage(first)).toEqual(first);
  });
});

describe('isHelpCommand', () => {
  it('matches help/hi/start without treating incident text as help', () => {
    expect(isHelpCommand('help')).toBe(true);
    expect(isHelpCommand('START')).toBe(true);
    expect(isHelpCommand('hi!')).toBe(true);
    expect(isHelpCommand('help the voters being blocked')).toBe(false);
  });
});
