import { Injectable, Logger } from '@nestjs/common';
import { CollationLevel } from '@electromon/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Ec8aPhotoReaderService } from './ec8a-photo-reader.service';
import { mergeVisionWithArithmetic } from './ocr-ec8a-parse';
import { arithmeticVerification, persistOcrVerification } from './ocr-verification';
import type { OcrVerifyJob } from './ocr-verify.events';

@Injectable()
export class OcrVerifyWorker {
  private readonly logger = new Logger(OcrVerifyWorker.name);

  constructor(
    private prisma: PrismaService,
    private photoReader: Ec8aPhotoReaderService,
  ) {}

  async handle(job: OcrVerifyJob) {
    const result = await this.prisma.collationResult.findUnique({
      where: { id: job.collationResultId },
    });
    if (!result || result.level !== CollationLevel.POLLING_UNIT) return;

    const arithmetic = arithmeticVerification(result);
    const photos = result.ec8aPhotoUrls ?? [];
    if (photos.length === 0) {
      await this.prisma.collationResult.update({
        where: { id: result.id },
        data: persistOcrVerification(arithmetic),
      });
      return;
    }

    const partyCodes = Object.keys(
      result.partyResults && typeof result.partyResults === 'object' && !Array.isArray(result.partyResults)
        ? (result.partyResults as Record<string, number>)
        : {},
    );

    const vision = await this.photoReader.extractEc8a(photos, partyCodes);
    const merged = mergeVisionWithArithmetic(result, vision, arithmetic);

    await this.prisma.collationResult.update({
      where: { id: result.id },
      data: persistOcrVerification(merged),
    });

    this.logger.log({
      collationResultId: result.id,
      recommendation: merged.recommendation,
      engine: merged.engine,
      aiConfigured: this.photoReader.isConfigured(),
    }, 'EC8A AI photo verification stored');
  }
}
