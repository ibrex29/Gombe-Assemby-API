import {
  extractWhatsAppMessages,
  isHelpCommand,
  parseStoredWhatsAppMessage,
} from './whatsapp-inbound.parser';

const webhook = {
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          value: {
            messages: [
              {
                from: '2348031234567',
                id: 'wamid.TEXT1',
                type: 'text',
                text: { body: 'Thugs at the gate' },
              },
              {
                from: '2348031234567',
                id: 'wamid.IMG1',
                type: 'image',
                image: {
                  id: 'media-1',
                  caption: 'EC8A torn',
                  mime_type: 'image/jpeg',
                },
              },
            ],
            statuses: [{ id: 'wamid.STATUS', status: 'delivered' }],
          },
        },
      ],
    },
  ],
};

describe('extractWhatsAppMessages', () => {
  it('pulls text and image messages and ignores delivery statuses', () => {
    const messages = extractWhatsAppMessages(webhook);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      wamid: 'wamid.TEXT1',
      from: '2348031234567',
      text: 'Thugs at the gate',
    });
    expect(messages[1]?.image).toMatchObject({
      id: 'media-1',
      caption: 'EC8A torn',
    });
  });

  it('reads a stored parsed payload back', () => {
    const [first] = extractWhatsAppMessages(webhook);
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
