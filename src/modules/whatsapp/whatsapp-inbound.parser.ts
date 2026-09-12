export type WhatsAppMediaRef = {
  id?: string;
  url?: string;
  caption?: string;
  mimeType?: string;
};

export type ParsedWhatsAppMessage = {
  wamid: string;
  from: string;
  type: string;
  text?: string;
  image?: WhatsAppMediaRef;
  audio?: WhatsAppMediaRef;
  location?: { latitude: number; longitude: number };
};

const IMAGE_EXT = /\.(jpe?g|png|gif|webp)(\?|#|$)/i;
const AUDIO_EXT = /\.(ogg|opus|mp3|m4a|aac|amr|wav|webm)(\?|#|$)/i;

export function extractWhatsAppMessages(payload: unknown): ParsedWhatsAppMessage[] {
  const termii = parseTermiiInbound(payload);
  if (termii) return [termii];
  return [];
}

export function parseStoredWhatsAppMessage(payload: unknown): ParsedWhatsAppMessage | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.wamid === 'string' && typeof record.from === 'string') {
    return record as unknown as ParsedWhatsAppMessage;
  }
  return parseTermiiInbound(payload);
}

function parseTermiiInbound(payload: unknown): ParsedWhatsAppMessage | null {
  if (!payload || typeof payload !== 'object') return null;
  const row = payload as Record<string, unknown>;
  const eventType = typeof row.type === 'string' ? row.type.toLowerCase() : '';
  if (eventType && eventType !== 'inbound' && eventType !== 'received') {
    return null;
  }

  const from = coerceString(row.sender) || coerceString(row.from);
  const wamid =
    coerceString(row.message_id) || coerceString(row.messageId) || coerceString(row.id);
  if (!from || !wamid) return null;

  const text = coerceString(row.message) || coerceString(row.sms) || coerceString(row.text);
  const media = extractMedia(row, text);
  const location = extractLocation(row);

  let type = 'text';
  if (media.image) type = 'image';
  else if (media.audio) type = 'audio';
  else if (location && !text) type = 'location';

  const parsed: ParsedWhatsAppMessage = { wamid, from, type };
  if (text && !looksLikeMediaUrl(text)) parsed.text = text;
  if (media.image) parsed.image = media.image;
  if (media.audio) parsed.audio = media.audio;
  if (location) parsed.location = location;
  return parsed;
}

function extractMedia(
  row: Record<string, unknown>,
  text: string,
): { image?: WhatsAppMediaRef; audio?: WhatsAppMediaRef } {
  const mediaObj = isRecord(row.media) ? row.media : null;
  const url =
    coerceString(mediaObj?.url) ||
    coerceString(row.media_url) ||
    coerceString(row.mediaUrl) ||
    coerceString(row.file_url) ||
    coerceString(row.image_url) ||
    (looksLikeMediaUrl(text) ? text : '');
  if (!url) return {};

  const caption =
    coerceString(mediaObj?.caption) ||
    coerceString(row.caption) ||
    (looksLikeMediaUrl(text) ? undefined : undefined);
  const mimeType =
    coerceString(mediaObj?.mime_type) ||
    coerceString(mediaObj?.mimeType) ||
    coerceString(row.mime_type);
  const ref: WhatsAppMediaRef = { url, caption, mimeType };

  if ((mimeType && mimeType.startsWith('audio/')) || AUDIO_EXT.test(url)) {
    return { audio: ref };
  }
  if ((mimeType && mimeType.startsWith('image/')) || IMAGE_EXT.test(url) || !mimeType) {
    return { image: ref };
  }
  return { image: ref };
}

function extractLocation(row: Record<string, unknown>) {
  const location = isRecord(row.location) ? row.location : row;
  const latitude = Number(location.latitude ?? location.lat);
  const longitude = Number(location.longitude ?? location.lng ?? location.lon);
  if (Number.isFinite(latitude) && Number.isFinite(longitude) && (location.latitude != null || location.lat != null)) {
    return { latitude, longitude };
  }
  return undefined;
}

function looksLikeMediaUrl(value: string) {
  return /^https?:\/\//i.test(value) && (IMAGE_EXT.test(value) || AUDIO_EXT.test(value));
}

function coerceString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isHelpCommand(text: string | undefined): boolean {
  if (!text) return false;
  return /^(help|hi|hello|start|menu)[\s.!?]*$/i.test(text.trim());
}

export const UNSUPPORTED_WHATSAPP_TYPES = new Set([
  'video',
  'document',
  'sticker',
  'reaction',
  'button',
  'interactive',
  'contacts',
  'order',
  'system',
  'device_status',
]);
