import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ContestInterceptor } from './contest.interceptor';
import { ContestService } from './contest.service';

@Global()
@Module({
  providers: [
    ContestService,
    { provide: APP_INTERCEPTOR, useClass: ContestInterceptor },
  ],
  exports: [ContestService],
})
export class ContestModule {}
