export type WhatsAppMediaRef = {
  id: string;
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

export function extractWhatsAppMessages(payload: unknown): ParsedWhatsAppMessage[] {
  if (!payload || typeof payload !== 'object') return [];
  const root = payload as Record<string, unknown>;
  const entries = Array.isArray(root.entry) ? root.entry : [];
  const out: ParsedWhatsAppMessage[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const changes = Array.isArray((entry as { changes?: unknown }).changes)
      ? ((entry as { changes: unknown[] }).changes)
      : [];
    for (const change of changes) {
      if (!change || typeof change !== 'object') continue;
      const value = (change as { value?: unknown }).value;
      if (!value || typeof value !== 'object') continue;
      const messages = Array.isArray((value as { messages?: unknown }).messages)
        ? ((value as { messages: unknown[] }).messages)
        : [];
      for (const message of messages) {
        const parsed = parseMessage(message);
        if (parsed) out.push(parsed);
      }
    }
  }

  return out;
}

export function parseStoredWhatsAppMessage(payload: unknown): ParsedWhatsAppMessage | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.wamid === 'string' && typeof record.from === 'string') {
    return record as unknown as ParsedWhatsAppMessage;
  }
  return parseMessage(payload);
}

function parseMessage(message: unknown): ParsedWhatsAppMessage | null {
  if (!message || typeof message !== 'object') return null;
  const row = message as Record<string, unknown>;
  const wamid = typeof row.id === 'string' ? row.id : '';
  const from = typeof row.from === 'string' ? row.from : '';
  const type = typeof row.type === 'string' ? row.type : 'unknown';
  if (!wamid || !from) return null;

  const parsed: ParsedWhatsAppMessage = { wamid, from, type };

  if (row.text && typeof row.text === 'object') {
    const body = (row.text as { body?: unknown }).body;
    if (typeof body === 'string' && body.trim()) parsed.text = body.trim();
  }

  if (row.image && typeof row.image === 'object') {
    const image = row.image as Record<string, unknown>;
    if (typeof image.id === 'string') {
      parsed.image = {
        id: image.id,
        caption: typeof image.caption === 'string' ? image.caption.trim() : undefined,
        mimeType: typeof image.mime_type === 'string' ? image.mime_type : undefined,
      };
    }
  }

  if (row.audio && typeof row.audio === 'object') {
    const audio = row.audio as Record<string, unknown>;
    if (typeof audio.id === 'string') {
      parsed.audio = {
        id: audio.id,
        mimeType: typeof audio.mime_type === 'string' ? audio.mime_type : undefined,
      };
    }
  }

  if (row.voice && typeof row.voice === 'object') {
    const voice = row.voice as Record<string, unknown>;
    if (typeof voice.id === 'string') {
      parsed.audio = {
        id: voice.id,
        mimeType: typeof voice.mime_type === 'string' ? voice.mime_type : undefined,
      };
    }
  }

  if (row.location && typeof row.location === 'object') {
    const location = row.location as Record<string, unknown>;
    const latitude = Number(location.latitude);
    const longitude = Number(location.longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      parsed.location = { latitude, longitude };
    }
  }

  return parsed;
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
]);
