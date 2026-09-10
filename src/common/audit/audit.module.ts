import { Module } from '@nestjs/common';
import { AuditInterceptor } from './audit.interceptor';

@Module({
  providers: [AuditInterceptor],
  exports: [AuditInterceptor],
})
export class AuditModule {}
