import { CallHandler, ExecutionContext, Injectable, NestInterceptor, NotFoundException } from '@nestjs/common';
import { Observable, from, lastValueFrom } from 'rxjs';
import { ContestService } from './contest.service';

@Injectable()
export class ContestInterceptor implements NestInterceptor {
  constructor(private contests: ContestService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{
      user?: { campaignId?: string };
      query?: { contest?: string; seat?: string };
      body?: { contest?: string; contestId?: string; seat?: string };
    }>();
    const campaignId = req.user?.campaignId;
    if (!campaignId) return next.handle();

    const raw = req.query?.contest ?? req.body?.contest ?? req.body?.contestId ?? null;
    const seatRaw = req.query?.seat ?? req.body?.seat ?? null;
    return from(
      this.contests
        .resolve(campaignId, raw)
        .then(async (contest) => {
          const seat =
            contest.type === 'ASSEMBLY' && seatRaw
              ? await this.contests.resolveSeat(campaignId, seatRaw)
              : null;
          return lastValueFrom(this.contests.run(contest, seat, () => next.handle()));
        })
        .catch((err: unknown) => {
          if (err instanceof NotFoundException) throw err;
          return lastValueFrom(next.handle());
        }),
    );
  }
}
