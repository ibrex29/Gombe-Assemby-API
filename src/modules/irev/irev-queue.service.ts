import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import amqplib, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import { IrevFetchWorker } from './irev-fetch.worker';
import {
  IREV_FETCH_EVENT,
  IREV_FETCH_QUEUE,
  type IrevFetchJob,
} from './irev-fetch.events';

@Injectable()
export class IrevQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IrevQueueService.name);
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;

  constructor(
    private events: EventEmitter2,
    private worker: IrevFetchWorker,
  ) {}

  async onModuleInit() {
    this.events.on(IREV_FETCH_EVENT, (job: IrevFetchJob) => {
      void this.runJob(job);
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

  async getDepth() {
    if (!this.channel) {
      return { connected: false, messages: 0, consumers: 0 };
    }
    try {
      const info = await this.channel.checkQueue(IREV_FETCH_QUEUE);
      return {
        connected: true,
        messages: info.messageCount,
        consumers: info.consumerCount,
      };
    } catch {
      return { connected: false, messages: 0, consumers: 0 };
    }
  }

  publish(job: IrevFetchJob) {
    if (this.channel) {
      try {
        this.channel.sendToQueue(IREV_FETCH_QUEUE, Buffer.from(JSON.stringify(job)), {
          persistent: true,
          contentType: 'application/json',
        });
        return;
      } catch (error) {
        this.logger.warn({ err: error }, 'RabbitMQ publish failed; running IReV fetch in-process');
      }
    }
    this.events.emit(IREV_FETCH_EVENT, job);
  }

  private async connectRabbit() {
    const url = process.env.RABBITMQ_URL;
    if (!url) {
      this.logger.warn('RABBITMQ_URL is not set; IReV fetch jobs run in-process');
      return;
    }

    try {
      const connection = await amqplib.connect(url, { timeout: 4000 });
      const channel = await connection.createChannel();
      await channel.assertQueue(IREV_FETCH_QUEUE, { durable: true });
      await channel.prefetch(1);
      await channel.consume(IREV_FETCH_QUEUE, (message) => {
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
      this.logger.log(`Consuming ${IREV_FETCH_QUEUE}`);
    } catch (error) {
      this.logger.warn({ err: error }, 'RabbitMQ unavailable; IReV fetch jobs run in-process');
      this.channel = null;
      this.connection = null;
    }
  }

  private async consume(channel: Channel, message: ConsumeMessage) {
    try {
      const job = JSON.parse(message.content.toString()) as IrevFetchJob;
      await this.runJob(job);
      channel.ack(message);
    } catch (error) {
      this.logger.error({ err: error }, 'IReV fetch consumer failed');
      channel.ack(message);
    }
  }

  private async runJob(job: IrevFetchJob) {
    const attempt = job.attempt ?? 1;
    try {
      await this.worker.handle(job);
    } catch (error) {
      if (this.worker.shouldRetry(error, attempt)) {
        const delayMs = Math.min(60_000, 2_000 * attempt);
        setTimeout(() => {
          this.publish({ ...job, attempt: attempt + 1 });
        }, delayMs);
        return;
      }
      this.logger.error({ err: error, job }, 'IReV fetch job failed permanently');
    }
  }
}
