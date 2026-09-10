import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import amqplib, {
  type Channel,
  type ChannelModel,
  type ConsumeMessage,
} from 'amqplib';
import { SocialAnalyzeWorker } from './social-analyze.worker';
import {
  AI_DEAD_LETTER_EXCHANGE,
  AI_SOCIAL_ANALYZE_EVENT,
  AI_SOCIAL_ANALYZE_QUEUE,
  AI_SOCIAL_DEAD_QUEUE,
  type SocialAnalyzeJob,
} from './social.events';

/**
 * Queue plumbing for sentiment analysis, following the EC8A OCR queue: connect
 * if RABBITMQ_URL is set, otherwise fall back to in-process events so the
 * pipeline still works on a laptop.
 *
 * One deliberate difference from the OCR queue: that consumer acks even on
 * failure, which drops the job. Analysis failures are usually transient (model
 * rate limits), so a failed job is requeued once and then dead-lettered — bounded
 * retry, and nothing vanishes silently.
 */
@Injectable()
export class SocialQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SocialQueueService.name);
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;

  constructor(
    private events: EventEmitter2,
    private worker: SocialAnalyzeWorker,
  ) {}

  async onModuleInit() {
    this.events.on(AI_SOCIAL_ANALYZE_EVENT, (job: SocialAnalyzeJob) => {
      void this.worker.handle(job).catch((error) => {
        this.logger.error({ err: error }, 'In-process social analysis failed');
      });
    });
    await this.connectRabbit();
  }

  async onModuleDestroy() {
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch {
      // ignore shutdown errors
    }
  }

  async publish(job: SocialAnalyzeJob) {
    if (this.channel) {
      try {
        this.channel.sendToQueue(
          AI_SOCIAL_ANALYZE_QUEUE,
          Buffer.from(JSON.stringify(job)),
          { persistent: true, contentType: 'application/json' },
        );
        return;
      } catch (error) {
        this.logger.warn(
          { err: error },
          'RabbitMQ publish failed; analysing social posts in-process',
        );
      }
    }
    this.events.emit(AI_SOCIAL_ANALYZE_EVENT, job);
  }

  private async connectRabbit() {
    const url = process.env.RABBITMQ_URL;
    if (!url) {
      this.logger.warn(
        'RABBITMQ_URL is not set; social analysis runs in-process',
      );
      return;
    }

    try {
      const connection = await amqplib.connect(url, { timeout: 4000 });
      const channel = await connection.createChannel();

      await channel.assertExchange(AI_DEAD_LETTER_EXCHANGE, 'fanout', {
        durable: true,
      });
      await channel.assertQueue(AI_SOCIAL_DEAD_QUEUE, { durable: true });
      await channel.bindQueue(
        AI_SOCIAL_DEAD_QUEUE,
        AI_DEAD_LETTER_EXCHANGE,
        '',
      );
      await channel.assertQueue(AI_SOCIAL_ANALYZE_QUEUE, {
        durable: true,
        deadLetterExchange: AI_DEAD_LETTER_EXCHANGE,
      });
      await channel.prefetch(1);
      await channel.consume(AI_SOCIAL_ANALYZE_QUEUE, (message) => {
        if (!message) return;
        void this.consume(channel, message);
      });

      connection.on('error', (error) => {
        this.logger.warn({ err: error }, 'RabbitMQ connection error');
        this.channel = null;
        this.connection = null;
      });

      this.connection = connection;
      this.channel = channel;
      this.logger.log(`Consuming ${AI_SOCIAL_ANALYZE_QUEUE}`);
    } catch (error) {
      this.logger.warn(
        { err: error },
        'RabbitMQ unavailable; social analysis runs in-process',
      );
      this.channel = null;
      this.connection = null;
    }
  }

  private async consume(channel: Channel, message: ConsumeMessage) {
    try {
      const job = JSON.parse(message.content.toString()) as SocialAnalyzeJob;
      await this.worker.handle(job);
      channel.ack(message);
    } catch (error) {
      // First failure: retry once. Second: dead-letter rather than loop forever.
      const alreadyRetried = message.fields.redelivered;
      this.logger.error(
        { err: error, willRetry: !alreadyRetried },
        'Social analyze consumer failed',
      );
      channel.nack(message, false, !alreadyRetried);
    }
  }
}
