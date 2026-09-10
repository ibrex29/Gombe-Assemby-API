import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import amqplib, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import { OcrVerifyWorker } from './ocr-verify.worker';
import {
  OCR_VERIFY_EVENT,
  OCR_VERIFY_QUEUE,
  type OcrVerifyJob,
} from './ocr-verify.events';

@Injectable()
export class OcrQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OcrQueueService.name);
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;

  constructor(
    private events: EventEmitter2,
    private worker: OcrVerifyWorker,
  ) {}

  async onModuleInit() {
    this.events.on(OCR_VERIFY_EVENT, (job: OcrVerifyJob) => {
      void this.worker.handle(job);
    });
    if (process.env.DISABLE_BACKGROUND_WORKERS === 'true') {
      this.logger.log('Background workers disabled; not consuming RabbitMQ');
      return;
    }
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

  async publish(job: OcrVerifyJob) {
    if (this.channel) {
      try {
        this.channel.sendToQueue(OCR_VERIFY_QUEUE, Buffer.from(JSON.stringify(job)), {
          persistent: true,
          contentType: 'application/json',
        });
        return;
      } catch (error) {
        this.logger.warn({ err: error }, 'RabbitMQ publish failed; running OCR in-process');
      }
    }
    this.events.emit(OCR_VERIFY_EVENT, job);
  }

  private async connectRabbit() {
    const url = process.env.RABBITMQ_URL;
    if (!url) {
      this.logger.warn('RABBITMQ_URL is not set; EC8A OCR jobs run in-process');
      return;
    }

    try {
      const connection = await amqplib.connect(url, { timeout: 4000 });
      const channel = await connection.createChannel();
      await channel.assertQueue(OCR_VERIFY_QUEUE, { durable: true });
      await channel.prefetch(1);
      await channel.consume(OCR_VERIFY_QUEUE, (message) => {
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
      this.logger.log(`Consuming ${OCR_VERIFY_QUEUE}`);
    } catch (error) {
      this.logger.warn({ err: error }, 'RabbitMQ unavailable; EC8A OCR jobs run in-process');
      this.channel = null;
      this.connection = null;
    }
  }

  private async consume(channel: Channel, message: ConsumeMessage) {
    try {
      const job = JSON.parse(message.content.toString()) as OcrVerifyJob;
      await this.worker.handle(job);
      channel.ack(message);
    } catch (error) {
      this.logger.error({ err: error }, 'OCR verify consumer failed');
      channel.ack(message);
    }
  }
}
