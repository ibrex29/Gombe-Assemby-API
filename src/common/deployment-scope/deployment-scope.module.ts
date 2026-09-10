import { Global, Module } from '@nestjs/common';
import { DeploymentScopeService } from './deployment-scope.service';

@Global()
@Module({
  providers: [DeploymentScopeService],
  exports: [DeploymentScopeService],
})
export class DeploymentScopeModule {}
