import { Body, Controller, Get, Post, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/auth.decorators';
import { WhatsAppInboundService } from './whatsapp-inbound.service';
import { WhatsAppClient } from './whatsapp.client';
import { WhatsAppSignatureGuard } from './whatsapp-signature.guard';

@ApiTags('whatsapp')
@ApiExcludeController()
@SkipThrottle()
@Public()
@Controller('whatsapp')
export class WhatsAppController {
  constructor(
    private inbound: WhatsAppInboundService,
    private client: WhatsAppClient,
  ) {}

  @Get('webhook')
  @ApiOperation({ summary: 'Termii webhook URL check' })
  ping() {
    if (!this.client.isConfigured()) {
      throw new ServiceUnavailableException('Termii is not configured');
    }
    return { ok: true, provider: 'termii' };
  }

  @Post('webhook')
  @UseGuards(WhatsAppSignatureGuard)
  @ApiOperation({ summary: 'Termii inbound WhatsApp webhook' })
  async webhook(@Body() payload: unknown) {
    if (!this.client.isConfigured()) {
      throw new ServiceUnavailableException('Termii is not configured');
    }
    await this.inbound.ingestWebhook(payload);
    return { ok: true };
  }
}
