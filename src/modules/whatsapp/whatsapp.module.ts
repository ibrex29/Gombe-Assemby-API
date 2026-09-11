import { Module } from '@nestjs/common';
import { FieldReportsModule } from '../field-reports/field-reports.module';
import { UploadsModule } from '../uploads/uploads.module';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppClient } from './whatsapp.client';
import { WhatsAppInboundService } from './whatsapp-inbound.service';
import { WhatsAppInboundWorker } from './whatsapp-inbound.worker';
import { WhatsAppSignatureGuard } from './whatsapp-signature.guard';

@Module({
  imports: [FieldReportsModule, UploadsModule],
  controllers: [WhatsAppController],
  providers: [
    WhatsAppClient,
    WhatsAppInboundService,
    WhatsAppInboundWorker,
    WhatsAppSignatureGuard,
  ],
})
export class WhatsAppModule {}
