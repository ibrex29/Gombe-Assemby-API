import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { MetricsService } from '../metrics/metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<{
      method: string;
      route?: { path?: string };
      url: string;
    }>();
    const response = context.switchToHttp().getResponse<{ statusCode: number }>();
    const started = process.hrtime.bigint();

    return next.handle().pipe(
      tap({
        next: () => this.record(request, response.statusCode, started),
        error: () => this.record(request, response.statusCode || 500, started),
      }),
    );
  }

  private record(
    request: { method: string; route?: { path?: string }; url: string },
    status: number,
    started: bigint,
  ) {
    const route = request.route?.path ?? request.url.split('?')[0];
    const durationSeconds = Number(process.hrtime.bigint() - started) / 1e9;
    this.metrics.recordHttpRequest(request.method, route, status, durationSeconds);
  }
}
