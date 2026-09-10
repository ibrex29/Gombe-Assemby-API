import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../../src/common/guards/roles.guard';
import { MetricsModule } from '../../src/common/metrics/metrics.module';
import { PrismaModule } from '../../src/common/prisma/prisma.module';
import { RedisModule } from '../../src/common/redis/redis.module';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { HealthModule } from '../../src/modules/health/health.module';
import { SupportGroupsModule } from '../../src/modules/support-groups/support-groups.module';

/** Slim module graph for HTTP e2e tests — avoids ConfigModule / logging / audit stack. */
@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET ?? 'test-access-secret',
      signOptions: { expiresIn: 900 },
    }),
    PrismaModule,
    RedisModule,
    MetricsModule,
    AuthModule,
    HealthModule,
    SupportGroupsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class E2eTestModule {}
