import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
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
  @ApiOperation({ summary: 'Meta Cloud API webhook verification' })
  verify(
    @Res() res: Response,
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ) {
    const expected = process.env.WHATSAPP_VERIFY_TOKEN?.trim();
    if (!expected) {
      throw new ServiceUnavailableException('WhatsApp verify token is not configured');
    }
    if (mode === 'subscribe' && token === expected && challenge) {
      res.status(200).contentType('text/plain').send(challenge);
      return;
    }
    throw new ForbiddenException('WhatsApp webhook verification failed');
  }

  @Post('webhook')
  @UseGuards(WhatsAppSignatureGuard)
  @ApiOperation({ summary: 'Meta Cloud API inbound webhook' })
  async webhook(@Body() payload: unknown) {
    if (!this.client.isConfigured()) {
      throw new ServiceUnavailableException('WhatsApp is not configured');
    }
    await this.inbound.ingestWebhook(payload);
    return { ok: true };
  }
}
