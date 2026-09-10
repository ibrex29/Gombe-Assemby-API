import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  NOTIFICATION_DISPATCH_EVENT,
  NotificationDispatchPayload,
} from './notification.events';
import { NotificationsService } from './notifications.service';

@Injectable()
export class NotificationsListener {
  private readonly logger = new Logger(NotificationsListener.name);

  constructor(private notifications: NotificationsService) {}

  @OnEvent(NOTIFICATION_DISPATCH_EVENT, { async: true })
  async handleDispatch(payload: NotificationDispatchPayload) {
    // In-process dispatch. Move this handler behind RabbitMQ if FCM starts
    // blocking the event loop on election-day spikes.
    try {
      await this.notifications.dispatch(payload);
    } catch (error) {
      this.logger.error({ err: error, type: payload?.type }, 'Notification dispatch failed');
    }
  }
}
