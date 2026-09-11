import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { verifyWhatsAppSignature } from './whatsapp-signature';

@Injectable()
export class WhatsAppSignatureGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const appSecret = process.env.WHATSAPP_APP_SECRET?.trim();
    if (!appSecret) {
      throw new ServiceUnavailableException('WhatsApp is not configured');
    }

    const request = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    const header = request.headers['x-hub-signature-256'];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!verifyWhatsAppSignature(request.rawBody, signature, appSecret)) {
      throw new UnauthorizedException('Invalid WhatsApp signature');
    }
    return true;
  }
}
