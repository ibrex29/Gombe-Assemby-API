import { Module } from '@nestjs/common';
import { CollationCommonModule } from '../../common/collation/collation-common.module';
import { DevicesController } from './devices.controller';
import { FcmService } from './fcm.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsListener } from './notifications.listener';
import { NotificationsService } from './notifications.service';
import { RecipientResolverService } from './recipient-resolver.service';

@Module({
  imports: [CollationCommonModule],
  controllers: [DevicesController, NotificationsController],
  providers: [NotificationsService, RecipientResolverService, FcmService, NotificationsListener],
  exports: [NotificationsService],
})
export class NotificationsModule {}
