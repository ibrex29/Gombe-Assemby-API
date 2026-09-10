import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { MetricsService } from '../../common/metrics/metrics.service';
import { createMockPrismaService } from '../../../test/helpers/prisma.mock';

describe('HealthController', () => {
  let controller: HealthController;
  let prisma: ReturnType<typeof createMockPrismaService>;

  beforeEach(async () => {
    prisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        {
          provide: RedisService,
          useValue: { ping: jest.fn().mockResolvedValue(true) },
        },
        {
          provide: MetricsService,
          useValue: { setDependencyStatus: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get(HealthController);
  });

  describe('live', () => {
    it('returns ok status', () => {
      const result = controller.live();
      expect(result.status).toBe('ok');
      expect(result.timestamp).toBeDefined();
    });
  });

  describe('ready', () => {
    it('returns ok when database and redis are connected', async () => {
      prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const result = await controller.ready();

      expect(result.status).toBe('ok');
      expect(result.checks.database).toBe('connected');
      expect(result.checks.redis).toBe('connected');
    });

    it('returns degraded when database is down', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('db down'));

      const result = await controller.ready();

      expect(result.status).toBe('degraded');
      expect(result.checks.database).toBe('disconnected');
    });
  });
});
