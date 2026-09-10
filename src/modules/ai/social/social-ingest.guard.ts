import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

/**
 * Bearer-token guard for the ingest endpoint.
 *
 * The fetcher is a headless external process, so it authenticates with a
 * rotatable service token rather than a user JWT — same approach as the metrics
 * endpoint. An unset token disables the endpoint rather than leaving it open.
 */
@Injectable()
export class SocialIngestGuard implements CanActivate {
  constructor(private config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('SOCIAL_INGEST_TOKEN')?.trim();
    if (!expected) {
      throw new ServiceUnavailableException('Social ingest is not configured');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    if (!token || token !== expected) {
      throw new UnauthorizedException('Invalid ingest token');
    }
    return true;
  }
}
