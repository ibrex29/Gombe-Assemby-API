import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class WhatsAppClient {
  private readonly logger = new Logger(WhatsAppClient.name);

  isConfigured() {
    return Boolean(this.apiKey());
  }

  canSend() {
    return Boolean(this.apiKey() && this.deviceId());
  }

  async sendText(to: string, body: string): Promise<void> {
    if (!this.canSend()) {
      this.logger.warn('Termii send skipped: TERMII_API_KEY or TERMII_DEVICE_ID is unset');
      return;
    }
    const recipient = to.replace(/^\+/, '');
    try {
      const response = await fetch(`${this.baseUrl()}/api/sms/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey(),
          to: recipient,
          from: this.deviceId(),
          sms: body,
          type: 'plain',
          channel: 'whatsapp',
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        this.logger.warn(
          { status: response.status, detail: detail.slice(0, 300) },
          'Termii sendText failed',
        );
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'Termii sendText error');
    }
  }

  async downloadMedia(source: {
    url?: string;
    id?: string;
  }): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const url = source.url?.trim();
    if (!url) return null;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        this.logger.warn({ status: response.status, url }, 'Termii media download failed');
        return null;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const mimeType = response.headers.get('content-type') || 'application/octet-stream';
      return { buffer, mimeType };
    } catch (error) {
      this.logger.warn({ err: error, url }, 'Termii media download error');
      return null;
    }
  }

  private apiKey() {
    return process.env.TERMII_API_KEY?.trim() || '';
  }

  private deviceId() {
    return (
      process.env.TERMII_DEVICE_ID?.trim() ||
      process.env.TERMII_WHATSAPP_FROM?.trim() ||
      ''
    );
  }

  private baseUrl() {
    return (process.env.TERMII_BASE_URL?.trim() || 'https://v3.api.termii.com').replace(/\/$/, '');
  }
}
