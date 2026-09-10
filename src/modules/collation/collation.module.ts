import { Module } from '@nestjs/common';
import { CollationCommonModule } from '../../common/collation/collation-common.module';
import { CollationController } from './collation.controller';
import { CollationService } from './collation.service';
import { CollationBrowseService } from './collation-browse.service';
import { CollationReadinessService } from './collation-readiness.service';
import { Ec8aPhotoReaderService } from './ec8a-photo-reader.service';
import { OcrQueueService } from './ocr-queue.service';
import { OcrVerifyWorker } from './ocr-verify.worker';
import { UploadsModule } from '../uploads/uploads.module';
import { SituationRoomModule } from '../situation-room/situation-room.module';

@Module({
  imports: [CollationCommonModule, UploadsModule, SituationRoomModule],
  controllers: [CollationController],
  providers: [
    CollationService,
    CollationBrowseService,
    CollationReadinessService,
    Ec8aPhotoReaderService,
    OcrVerifyWorker,
    OcrQueueService,
  ],
  exports: [CollationService, CollationBrowseService, Ec8aPhotoReaderService],
})
export class CollationModule {}
