import { createHmac, timingSafeEqual } from 'crypto';

/** Termii signs webhooks with HMAC-SHA512 in `X-Termii-Signature`. */
export function verifyWhatsAppSignature(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
  secret: string | undefined,
): boolean {
  if (!rawBody?.length || !signatureHeader || !secret) return false;
  const expectedHex = signatureHeader.includes('=')
    ? signatureHeader.slice(signatureHeader.indexOf('=') + 1)
    : signatureHeader;
  const digest = createHmac('sha512', secret).update(rawBody).digest('hex');
  const left = Buffer.from(digest, 'utf8');
  const right = Buffer.from(expectedHex, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function termiiSigningSecret(): string | undefined {
  return process.env.TERMII_SECRET_KEY?.trim() || process.env.TERMII_API_KEY?.trim() || undefined;
}
