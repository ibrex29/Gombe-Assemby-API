import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createE2eApp } from './helpers/test-app';
import { createMockPrismaService } from './helpers/prisma.mock';
import { testUserRecord } from './helpers/fixtures';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const prisma = createMockPrismaService();
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    ({ app } = await createE2eApp(prisma));
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/v1/health/live returns ok', () => {
    return request(app.getHttpServer())
      .get('/api/v1/health/live')
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('ok');
      });
  });

  it('GET /api/v1/health/ready returns dependency checks', () => {
    return request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(200)
      .expect((res) => {
        expect(res.body.checks.database).toBe('connected');
        expect(res.body.checks.redis).toBe('connected');
      });
  });
});

describe('Auth (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const prisma = createMockPrismaService();
    prisma.user.findUnique.mockResolvedValue(testUserRecord);
    prisma.refreshToken.create.mockResolvedValue({ id: 'rt-1' });
    prisma.activityLog.create.mockResolvedValue({ id: 'log-1' });
    ({ app } = await createE2eApp(prisma));
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /api/v1/auth/login returns tokens for valid credentials', () => {
    return request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ phoneNumber: '+2348000000001', password: 'ChangeMe123!' })
      .expect(201)
      .expect((res) => {
        expect(res.body.accessToken).toBeDefined();
        expect(res.body.refreshToken).toBeDefined();
        expect(res.body.user.email).toBe('director@electromon.ng');
      });
  });

  it('POST /api/v1/auth/login rejects invalid credentials', () => {
    return request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ phoneNumber: '+2348000000001', password: 'WrongPass123!' })
      .expect(401);
  });
});

describe('Protected routes (e2e)', () => {
  let app: INestApplication;
  let accessToken: string;

  beforeEach(async () => {
    const prisma = createMockPrismaService();
    prisma.user.findUnique.mockResolvedValue(testUserRecord);
    prisma.refreshToken.create.mockResolvedValue({ id: 'rt-1' });
    prisma.activityLog.create.mockResolvedValue({ id: 'log-1' });
    prisma.campaignMembership.findFirst.mockResolvedValue({ id: 'mem-1' });
    prisma.supportGroup.findMany.mockResolvedValue([]);

    ({ app } = await createE2eApp(prisma));

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ phoneNumber: '+2348000000001', password: 'ChangeMe123!' });

    accessToken = login.body.accessToken;
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 401 without authorization header', () => {
    return request(app.getHttpServer())
      .get('/api/v1/support-groups?campaignId=campaign-test-001')
      .expect(401);
  });

  it('returns 200 with valid bearer token', () => {
    return request(app.getHttpServer())
      .get('/api/v1/support-groups?campaignId=campaign-test-001')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect((res) => {
        expect(Array.isArray(res.body)).toBe(true);
      });
  });
});
