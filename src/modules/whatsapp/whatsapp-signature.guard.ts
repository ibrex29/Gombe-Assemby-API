import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { termiiSigningSecret, verifyWhatsAppSignature } from './whatsapp-signature';

@Injectable()
export class WhatsAppSignatureGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const secret = termiiSigningSecret();
    if (!secret) {
      throw new ServiceUnavailableException('Termii is not configured');
    }

    const request = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    const header = request.headers['x-termii-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!verifyWhatsAppSignature(request.rawBody, signature, secret)) {
      throw new UnauthorizedException('Invalid Termii signature');
    }
    return true;
  }
}
