import { Module } from '@nestjs/common';
import { CommitmentsController } from './commitments.controller';
import { CommitmentsService } from './commitments.service';

@Module({
  controllers: [CommitmentsController],
  providers: [CommitmentsService],
})
export class CommitmentsModule {}
