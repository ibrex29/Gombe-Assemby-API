import { Injectable, Logger } from '@nestjs/common';

type GraphMediaMeta = {
  url?: string;
  mime_type?: string;
};

@Injectable()
export class WhatsAppClient {
  private readonly logger = new Logger(WhatsAppClient.name);

  isConfigured() {
    return Boolean(this.accessToken() && this.phoneNumberId());
  }

  graphVersion() {
    return process.env.WHATSAPP_GRAPH_VERSION?.trim() || 'v21.0';
  }

  async sendText(to: string, body: string): Promise<void> {
    if (!this.isConfigured()) return;
    const phoneNumberId = this.phoneNumberId();
    const recipient = to.replace(/^\+/, '');
    try {
      const response = await fetch(
        `https://graph.facebook.com/${this.graphVersion()}/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.accessToken()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: recipient,
            type: 'text',
            text: { body, preview_url: false },
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        this.logger.warn(
          { status: response.status, detail: detail.slice(0, 300) },
          'WhatsApp sendText failed',
        );
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'WhatsApp sendText error');
    }
  }

  async downloadMedia(
    mediaId: string,
  ): Promise<{ buffer: Buffer; mimeType: string } | null> {
    if (!this.isConfigured()) return null;
    try {
      const metaResponse = await fetch(
        `https://graph.facebook.com/${this.graphVersion()}/${mediaId}`,
        {
          headers: { Authorization: `Bearer ${this.accessToken()}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!metaResponse.ok) {
        this.logger.warn({ status: metaResponse.status, mediaId }, 'WhatsApp media meta failed');
        return null;
      }
      const meta = (await metaResponse.json()) as GraphMediaMeta;
      if (!meta.url) return null;

      const fileResponse = await fetch(meta.url, {
        headers: { Authorization: `Bearer ${this.accessToken()}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!fileResponse.ok) {
        this.logger.warn({ status: fileResponse.status, mediaId }, 'WhatsApp media download failed');
        return null;
      }
      const buffer = Buffer.from(await fileResponse.arrayBuffer());
      const mimeType =
        meta.mime_type ||
        fileResponse.headers.get('content-type') ||
        'application/octet-stream';
      return { buffer, mimeType };
    } catch (error) {
      this.logger.warn({ err: error, mediaId }, 'WhatsApp media download error');
      return null;
    }
  }

  private accessToken() {
    return process.env.WHATSAPP_ACCESS_TOKEN?.trim() || '';
  }

  private phoneNumberId() {
    return process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || '';
  }
}
