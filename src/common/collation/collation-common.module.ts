import { Module } from '@nestjs/common';
import { ScopeResolverService } from './scope-resolver.service';

@Module({
  providers: [ScopeResolverService],
  exports: [ScopeResolverService],
})
export class CollationCommonModule {}
