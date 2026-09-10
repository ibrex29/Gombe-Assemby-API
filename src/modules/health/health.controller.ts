import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { SkipAudit } from '../../common/audit/audit.decorators';
import { Public } from '../../common/decorators/auth.decorators';
import { MetricsService } from '../../common/metrics/metrics.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { DeploymentScopeService } from '../../common/deployment-scope/deployment-scope.service';

@ApiTags('health')
@SkipAudit()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private metrics: MetricsService,
    private deploymentScope: DeploymentScopeService,
  ) {}

  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe', description: 'Process is running.' })
  @ApiOkResponse({
    schema: { example: { status: 'ok', timestamp: '2026-07-26T00:00:00.000Z' } },
  })
  live() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      deployment: this.deploymentScope.deploymentMeta(),
    };
  }

  @Public()
  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe',
    description: 'Checks database and Redis before routing traffic.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        status: 'ok',
        timestamp: '2026-07-26T00:00:00.000Z',
        checks: { database: 'connected', redis: 'connected' },
      },
    },
  })
  async ready() {
    const checks = await this.runChecks();
    const healthy = Object.values(checks).every((value) => value === 'connected');

    this.metrics.setDependencyStatus('postgres', checks.database === 'connected');
    this.metrics.setDependencyStatus('redis', checks.redis === 'connected');

    return {
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks,
    };
  }

  @Public()
  @Get()
  @ApiOperation({
    summary: 'Health check (alias for readiness)',
    description: 'Backward-compatible alias used by Docker healthchecks.',
  })
  async check() {
    return this.ready();
  }

  private async runChecks() {
    let database = 'connected';
    let redis = 'connected';

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'disconnected';
    }

    const redisOk = await this.redis.ping();
    if (!redisOk) {
      redis = 'disconnected';
    }

    return { database, redis };
  }
}
