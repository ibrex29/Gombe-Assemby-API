import { createHmac } from 'crypto';
import { verifyWhatsAppSignature } from './whatsapp-signature';

describe('verifyWhatsAppSignature', () => {
  const secret = 'app-secret';
  const body = Buffer.from('{"object":"whatsapp_business_account"}');
  const digest = createHmac('sha256', secret).update(body).digest('hex');

  it('accepts a matching sha256 header', () => {
    expect(verifyWhatsAppSignature(body, `sha256=${digest}`, secret)).toBe(true);
  });

  it('rejects a mismatched signature', () => {
    expect(verifyWhatsAppSignature(body, `sha256=${'a'.repeat(64)}`, secret)).toBe(false);
  });

  it('rejects a missing raw body', () => {
    expect(verifyWhatsAppSignature(undefined, `sha256=${digest}`, secret)).toBe(false);
  });

  it('rejects a missing header or secret', () => {
    expect(verifyWhatsAppSignature(body, undefined, secret)).toBe(false);
    expect(verifyWhatsAppSignature(body, `sha256=${digest}`, undefined)).toBe(false);
  });
});
