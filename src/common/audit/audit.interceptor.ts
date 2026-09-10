import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtPayload } from '@electromon/shared';
import { Request } from 'express';
import { Observable, tap } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { AUDIT_ACTION_KEY, SKIP_AUDIT_KEY } from './audit.decorators';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private prisma: PrismaService,
    private reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const skipAudit = this.reflector.getAllAndOverride<boolean>(SKIP_AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipAudit) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<
      Request & { user?: JwtPayload; route?: { path?: string } }
    >();

    if (!MUTATING_METHODS.has(request.method) || !request.user?.sub) {
      return next.handle();
    }

    const auditAction = this.reflector.getAllAndOverride<string>(AUDIT_ACTION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    return next.handle().pipe(
      tap({
        next: () => {
          void this.writeLog(request, auditAction);
        },
      }),
    );
  }

  private async writeLog(
    request: Request & { user?: JwtPayload; route?: { path?: string } },
    auditAction?: string,
  ) {
    const user = request.user;
    if (!user?.sub) return;

    const route = request.route?.path ?? request.url.split('?')[0];
    const resource = route.split('/').filter(Boolean)[0] ?? 'unknown';

    try {
      await this.prisma.activityLog.create({
        data: {
          userId: user.sub,
          campaignId: user.campaignId,
          action: auditAction ?? `${request.method} ${route}`,
          resource,
          metadata: {
            method: request.method,
            path: route,
          },
          ipAddress: request.ip,
        },
      });
    } catch {
      // Audit failures must not break user requests
    }
  }
}
