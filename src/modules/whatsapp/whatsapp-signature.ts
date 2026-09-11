import { createHmac, timingSafeEqual } from 'crypto';

export function verifyWhatsAppSignature(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
  appSecret: string | undefined,
): boolean {
  if (!rawBody?.length || !signatureHeader || !appSecret) return false;
  const expectedHex = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;
  const digest = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const left = Buffer.from(digest, 'utf8');
  const right = Buffer.from(expectedHex, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
