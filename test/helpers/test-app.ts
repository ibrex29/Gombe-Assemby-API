import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { E2eTestModule } from './e2e.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { RedisService } from '../../src/common/redis/redis.service';
import { MetricsService } from '../../src/common/metrics/metrics.service';
import { createMockPrismaService } from './prisma.mock';

export async function createE2eApp(
  prismaOverride = createMockPrismaService(),
): Promise<{ app: INestApplication; prisma: ReturnType<typeof createMockPrismaService> }> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [E2eTestModule],
  })
    .overrideProvider(PrismaService)
    .useValue(prismaOverride)
    .overrideProvider(RedisService)
    .useValue({
      onModuleInit: jest.fn(),
      onModuleDestroy: jest.fn(),
      ping: jest.fn().mockResolvedValue(true),
    })
    .overrideProvider(MetricsService)
    .useValue({
      onModuleInit: jest.fn(),
      setDependencyStatus: jest.fn(),
      recordHttpRequest: jest.fn(),
      metrics: jest.fn().mockResolvedValue(''),
    })
    .compile();

  const app = moduleFixture.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();

  return { app, prisma: prismaOverride };
}
