import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { networkInterfaces } from 'os';
import { join } from 'path';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import {
  buildSwaggerDocument,
  swaggerCustomOptions,
} from './common/swagger/swagger.config';

function lanOriginUrls(port: number): string[] {
  const urls: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        urls.push(`http://${addr.address}:${port}`);
      }
    }
  }
  return urls;
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads/' });

  app.setGlobalPrefix('api/v1');

  // Temporary: reflect any Origin (Vercel preview + localhost). Tighten via CORS_ORIGIN later.
  const corsRaw = (process.env.CORS_ORIGIN ?? '*').trim();
  const corsOrigins = corsRaw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowAllOrigins = corsOrigins.length === 0 || corsOrigins.includes('*');

  app.enableCors({
    origin: (origin, callback) => {
      if (allowAllOrigins || !origin || corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} not allowed by CORS`), false);
    },
    credentials: true,
    exposedHeaders: ['X-Request-Id'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = Number(process.env.API_PORT ?? 3001);
  const lanUrls = lanOriginUrls(port);
  const document = SwaggerModule.createDocument(
    app,
    buildSwaggerDocument(lanUrls.map((url) => ({ url, description: 'LAN — phones on this Wi-Fi' }))),
  );
  SwaggerModule.setup('docs', app, document, swaggerCustomOptions);

  await app.listen(port, '0.0.0.0');

  const logger = app.get(Logger);
  logger.log(`A4A National API running on http://0.0.0.0:${port}`);
  logger.log(`Swagger docs at http://localhost:${port}/docs`);
  logger.log(`OpenAPI JSON at http://localhost:${port}/docs/json`);
  for (const url of lanUrls) {
    logger.log(`LAN (mobile) ${url}/api/v1  ·  docs ${url}/docs`);
  }
  logger.log(`Metrics at http://localhost:${port}/api/v1/metrics`);
}

bootstrap();
