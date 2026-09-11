import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditInterceptor } from './common/audit/audit.interceptor';
import { AuditModule } from './common/audit/audit.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { MetricsInterceptor } from './common/interceptors/metrics.interceptor';
import { LoggingModule } from './common/logging/logging.module';
import { MetricsController } from './common/metrics/metrics.controller';
import { MetricsModule } from './common/metrics/metrics.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { AgentsModule } from './modules/agents/agents.module';
import { AuthModule } from './modules/auth/auth.module';
import { CampaignModule } from './modules/campaign/campaign.module';
import { CollationModule } from './modules/collation/collation.module';
import { HealthModule } from './modules/health/health.module';
import { StructureModule } from './modules/structure/structure.module';
import { CommitmentsModule } from './modules/commitments/commitments.module';
import { SupportGroupsModule } from './modules/support-groups/support-groups.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { FieldReportsModule } from './modules/field-reports/field-reports.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { PollingUnitsModule } from './modules/polling-units/polling-units.module';
import { SituationRoomModule } from './modules/situation-room/situation-room.module';
import { VolunteersModule } from './modules/volunteers/volunteers.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AiModule } from './modules/ai/ai.module';
import { IrevModule } from './modules/irev/irev.module';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { DeploymentScopeModule } from './common/deployment-scope/deployment-scope.module';
import { ContestModule } from './common/contest/contest.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
    }),
    DeploymentScopeModule,
    ContestModule,
    LoggingModule,
    EventEmitterModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    PrismaModule,
    RedisModule,
    MetricsModule,
    AuditModule,
    AuthModule,
    AgentsModule,
    CampaignModule,
    CollationModule,
    StructureModule,
    SupportGroupsModule,
    CommitmentsModule,
    VolunteersModule,
    PollingUnitsModule,
    SituationRoomModule,
    FieldReportsModule,
    NotificationsModule,
    UploadsModule,
    AnalyticsModule,
    AiModule,
    IrevModule,
    WhatsAppModule,
    HealthModule,
  ],
  controllers: [MetricsController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
