import { createHmac } from 'crypto';
import { verifyWhatsAppSignature } from './whatsapp-signature';

describe('verifyWhatsAppSignature', () => {
  const secret = 'termii-secret';
  const body = Buffer.from('{"type":"inbound","message_id":"1"}');
  const digest = createHmac('sha512', secret).update(body).digest('hex');

  it('accepts a matching Termii sha512 header', () => {
    expect(verifyWhatsAppSignature(body, digest, secret)).toBe(true);
  });

  it('accepts a sha512= prefixed header', () => {
    expect(verifyWhatsAppSignature(body, `sha512=${digest}`, secret)).toBe(true);
  });

  it('rejects a mismatched signature', () => {
    expect(verifyWhatsAppSignature(body, 'a'.repeat(128), secret)).toBe(false);
  });

  it('rejects a missing raw body', () => {
    expect(verifyWhatsAppSignature(undefined, digest, secret)).toBe(false);
  });

  it('rejects a missing header or secret', () => {
    expect(verifyWhatsAppSignature(body, undefined, secret)).toBe(false);
    expect(verifyWhatsAppSignature(body, digest, undefined)).toBe(false);
  });
});
