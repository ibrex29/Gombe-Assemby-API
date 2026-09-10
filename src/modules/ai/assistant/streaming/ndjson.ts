import { Response } from 'express';

/**
 * Wire protocol for POST /ai/assistant/chat when `stream` is true.
 *
 * NDJSON rather than text/event-stream: this is a POST (EventSource cannot POST)
 * and a chat turn is one-shot, so SSE's reconnection semantics buy nothing while
 * costing a heavier client.
 *
 * Status events stream as work happens. The answer itself is sent only in the
 * final event, after the grounding check — streaming tokens as they arrive would
 * put unverified figures on screen before suppression could catch them.
 */
export type ChatEvent =
  | { type: 'status'; label: string; tool?: string }
  | {
      type: 'final';
      reply: string;
      /**
       * Short prose version of the same answer for read-aloud. Generated in the
       * same model call, so it costs no extra latency, and grounding-checked
       * alongside the reply.
       */
      spoken: string | null;
      grounded: boolean;
      suppressed: boolean;
      model: string;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
      toolCalls: Array<{ tool: string; ok: boolean }>;
      /** Photo evidence. URLs come from the server, never from the model. */
      attachments: Array<{
        ref: number;
        kind: 'incident' | 'ec8a';
        url: string;
        caption: string;
        takenAt: string | null;
      }>;
      /** Charts built from tool results, not from model-authored numbers. */
      charts: Array<{
        type: 'bar' | 'donut';
        title: string;
        unit: string;
        series: Array<{ label: string; value: number }>;
      }>;
      /**
       * Contact cards. Phone numbers travel here rather than in `reply` so the
       * model cannot mis-transcribe a digit.
       *
       * This was missing from the type while the controller spread the whole
       * result into the event, so it reached the wire anyway and TypeScript
       * said nothing -- a spread does not trigger excess-property checks. The
       * day someone builds this event field by field, contacts would have gone
       * silently missing.
       */
      contacts: Array<{
        place: string;
        level: string;
        levels: Array<{
          level: string;
          name: string;
          contacts: Array<{
            name: string;
            role: string;
            phone: string | null;
            email: string | null;
            accountActive: boolean;
          }>;
        }>;
        unassignedLevels: string[];
      }>;
    }
  | { type: 'error'; message: string };

export interface NdjsonWriter {
  emit(event: ChatEvent): void;
  end(): void;
  get started(): boolean;
}

export function createNdjsonWriter(res: Response): NdjsonWriter {
  let started = false;

  return {
    get started() {
      return started;
    },
    emit(event: ChatEvent) {
      if (!started) {
        started = true;
        res.status(200);
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        // Ask intermediaries not to buffer, otherwise status events arrive in
        // one burst at the end and the progress display is pointless.
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
      }
      res.write(`${JSON.stringify(event)}\n`);
    },
    end() {
      res.end();
    },
  };
}
