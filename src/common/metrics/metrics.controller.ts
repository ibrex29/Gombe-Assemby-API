import {
  Controller,
  Get,
  Header,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { SkipAudit } from '../audit/audit.decorators';
import { Public } from '../decorators/auth.decorators';
import { MetricsService } from '../metrics/metrics.service';

@ApiExcludeController()
@SkipAudit()
@Controller('metrics')
export class MetricsController {
  constructor(private metrics: MetricsService) {}

  @Public()
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(@Req() req: Request, @Res() res: Response) {
    const token = process.env.METRICS_TOKEN?.trim();
    if (token) {
      const header = req.headers.authorization;
      const bearer =
        typeof header === 'string' && header.startsWith('Bearer ')
          ? header.slice('Bearer '.length).trim()
          : undefined;
      const queryToken =
        typeof req.query.token === 'string' ? req.query.token : undefined;
      if (bearer !== token && queryToken !== token) {
        throw new UnauthorizedException('Invalid metrics token');
      }
    }

    res.send(await this.metrics.metrics());
  }
}
