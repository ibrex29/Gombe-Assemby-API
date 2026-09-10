import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true, singleLine: true } }
            : undefined,
        genReqId: (req, res) => {
          const existing = req.headers['x-request-id'];
          const requestId = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
          res.setHeader('X-Request-Id', requestId);
          return requestId;
        },
        customProps: (req) => ({
          requestId: req.id,
        }),
        redact: {
          paths: ['req.headers.authorization', 'req.body.password', 'req.body.refreshToken'],
          remove: true,
        },
        serializers: {
          req: (req) => ({
            id: req.id,
            method: req.method,
            url: req.url,
          }),
          res: (res) => ({
            statusCode: res.statusCode,
          }),
        },
      },
    }),
  ],
})
export class LoggingModule {}
