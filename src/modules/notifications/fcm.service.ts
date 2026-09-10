import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationPriority } from '@electromon/shared';
import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, Messaging } from 'firebase-admin/messaging';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MetricsService } from '../../common/metrics/metrics.service';

export type FcmSendInput = {
  tokens: string[];
  title: string;
  body: string;
  data: Record<string, string>;
  priority: NotificationPriority;
};

@Injectable()
export class FcmService implements OnModuleInit {
  private readonly logger = new Logger(FcmService.name);
  private messaging: Messaging | null = null;
  private dryRun = false;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private metrics: MetricsService,
  ) {}

  onModuleInit() {
    this.dryRun = this.config.get('FCM_DRY_RUN') === 'true';
    const json = this.config.get<string>('FCM_SERVICE_ACCOUNT_JSON');
    const path = this.config.get<string>('FCM_SERVICE_ACCOUNT_PATH');

    if (!json && !path) {
      this.logger.warn('FCM is not configured; push delivery is disabled');
      return;
    }

    try {
      const app: App = getApps()[0] ?? initializeApp({
        credential: json
          ? cert(JSON.parse(json) as Parameters<typeof cert>[0])
          : cert(path!),
      });
      this.messaging = getMessaging(app);
      this.logger.log('FCM initialized');
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to initialize FCM');
    }
  }

  isEnabled() {
    return this.messaging != null && !this.dryRun;
  }

  async send(input: FcmSendInput) {
    if (input.tokens.length === 0) return;
    if (this.dryRun) {
      this.logger.debug({ count: input.tokens.length }, 'FCM dry-run skip');
      this.metrics.recordNotificationPush('dry_run', input.tokens.length);
      return;
    }
    if (!this.messaging) {
      this.metrics.recordNotificationPush('skipped', input.tokens.length);
      return;
    }

    const high = input.priority === NotificationPriority.HIGH;
    const chunks = chunk(input.tokens, 500);
    const invalidTokens: string[] = [];

    for (const tokens of chunks) {
      try {
        const response = await this.messaging.sendEachForMulticast({
          tokens,
          notification: { title: input.title, body: input.body },
          data: input.data,
          android: {
            priority: high ? 'high' : 'normal',
            notification: { sound: high ? 'default' : undefined, channelId: 'electromon_alerts' },
          },
          apns: {
            payload: {
              aps: {
                sound: high ? 'default' : undefined,
                contentAvailable: true,
              },
            },
          },
        });

        this.metrics.recordNotificationPush('sent', response.successCount);
        this.metrics.recordNotificationPush('failed', response.failureCount);

        response.responses.forEach((result, index) => {
          if (result.success) return;
          const code = result.error?.code;
          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token'
          ) {
            invalidTokens.push(tokens[index]);
          }
        });
      } catch (error) {
        this.logger.error({ err: error }, 'FCM multicast failed');
        this.metrics.recordNotificationPush('failed', tokens.length);
      }
    }

    if (invalidTokens.length > 0) {
      await this.deactivateTokens(invalidTokens);
      this.metrics.recordNotificationPush('invalid_token', invalidTokens.length);
    }
  }

  async tokensForUsers(userIds: string[]) {
    if (userIds.length === 0) return [];
    return this.prisma.deviceToken.findMany({
      where: { userId: { in: userIds }, isActive: true },
      select: { userId: true, token: true, platform: true },
    });
  }

  private async deactivateTokens(tokens: string[]) {
    await this.prisma.deviceToken.updateMany({
      where: { token: { in: tokens } },
      data: { isActive: false },
    });
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
