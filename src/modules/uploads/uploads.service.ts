import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { extname, join } from 'path';
import { Readable } from 'stream';
import { v2 as cloudinary } from 'cloudinary';

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'audio/mp4',
  'audio/m4a',
  'audio/aac',
  'audio/mpeg',
  'audio/webm',
  'audio/ogg',
  'audio/wav',
]);
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const AUDIO_MAX_BYTES = 16 * 1024 * 1024;

export type UploadedFileResult = {
  filename: string;
  url: string;
  mimeType: string;
  size: number;
  provider: 'cloudinary' | 'local';
};

/** Strip WhatsApp codec parameters and map opus to ogg. */
export function normalizeUploadMime(raw: string): string {
  const base = raw.split(';')[0].trim().toLowerCase();
  if (base === 'audio/opus') return 'audio/ogg';
  return base;
}

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  private readonly uploadDir = join(process.cwd(), 'uploads');
  private readonly cloudinaryEnabled: boolean;

  constructor() {
    this.cloudinaryEnabled = this.configureCloudinary();
  }

  ensureUploadDir() {
    if (!existsSync(this.uploadDir)) {
      mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  publicBaseUrl(req?: {
    protocol?: string;
    get?: (name: string) => string | undefined;
    headers?: Record<string, unknown>;
  }) {
    const configured = process.env.API_PUBLIC_URL?.replace(/\/$/, '');
    if (configured) return configured;
    if (!req) {
      return (process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? 3001}`).replace(
        /\/$/,
        '',
      );
    }
    const host = req.get?.('host');
    if (host) {
      const forwarded = req.headers?.['x-forwarded-proto'];
      const proto = String(
        (Array.isArray(forwarded) ? forwarded[0] : forwarded) || req.protocol || 'http',
      ).split(',')[0];
      return `${proto}://${host}`;
    }
    return (process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? 3001}`).replace(
      /\/$/,
      '',
    );
  }

  async saveFile(
    file: Express.Multer.File,
    req?: {
      protocol?: string;
      get?: (name: string) => string | undefined;
      headers?: Record<string, unknown>;
    },
  ): Promise<UploadedFileResult> {
    this.validateFile(file);

    if (this.cloudinaryEnabled) {
      return this.saveToCloudinary(file);
    }

    if (process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException(
        'Cloudinary is not configured. Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET.',
      );
    }

    return this.saveToDisk(file, req);
  }

  async saveBuffer(input: {
    buffer: Buffer;
    mimeType: string;
    originalname?: string;
  }): Promise<UploadedFileResult> {
    const mimeType = normalizeUploadMime(input.mimeType);
    return this.saveFile({
      fieldname: 'file',
      originalname: input.originalname ?? `upload${extensionForMime(mimeType)}`,
      encoding: '7bit',
      mimetype: mimeType,
      size: input.buffer.length,
      buffer: input.buffer,
      stream: null as never,
      destination: '',
      filename: '',
      path: '',
    });
  }

  private validateFile(file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    file.mimetype = normalizeUploadMime(file.mimetype);
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException(
        'Only JPEG, PNG, WebP, GIF, PDF, and common audio formats are allowed',
      );
    }
    const isAudio = file.mimetype.startsWith('audio/');
    const maxBytes = isAudio ? AUDIO_MAX_BYTES : IMAGE_MAX_BYTES;
    if (file.size > maxBytes) {
      throw new BadRequestException(
        isAudio ? 'Audio must be 16 MB or smaller' : 'File must be 5 MB or smaller',
      );
    }
  }

  private configureCloudinary() {
    const cloudinaryUrl = process.env.CLOUDINARY_URL?.trim();
    if (cloudinaryUrl) {
      const parsed = this.parseCloudinaryUrl(cloudinaryUrl);
      if (parsed) {
        cloudinary.config({ ...parsed, secure: true });
        this.logger.log({ cloudName: parsed.cloud_name }, 'Cloudinary uploads enabled via CLOUDINARY_URL');
        return true;
      }
      this.logger.error('CLOUDINARY_URL is set but could not be parsed');
    }

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
    const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
    const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
    if (cloudName && apiKey && apiSecret) {
      cloudinary.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret,
        secure: true,
      });
      this.logger.log({ cloudName }, 'Cloudinary uploads enabled');
      return true;
    }

    this.logger.warn(
      'Cloudinary not configured — falling back to local ./uploads (development only)',
    );
    return false;
  }

  private parseCloudinaryUrl(url: string) {
    const match = url.match(/^cloudinary:\/\/([^:]+):([^@]+)@([^/?#]+)/i);
    if (!match) return null;
    return {
      api_key: decodeURIComponent(match[1]),
      api_secret: decodeURIComponent(match[2]),
      cloud_name: decodeURIComponent(match[3]),
    };
  }

  private async saveToCloudinary(file: Express.Multer.File): Promise<UploadedFileResult> {
    const baseFolder = process.env.CLOUDINARY_FOLDER?.trim() || 'electromon/uploads';
    const publicId = randomUUID();
    const isAudio = file.mimetype.startsWith('audio/');
    const folder = isAudio ? `${baseFolder}/voice` : baseFolder;

    try {
      const result = isAudio
        ? await this.uploadAudioStream(file.buffer, folder, publicId)
        : await cloudinary.uploader.upload(
            `data:${file.mimetype};base64,${file.buffer.toString('base64')}`,
            {
              folder,
              public_id: publicId,
              resource_type: 'auto',
              use_filename: false,
              unique_filename: false,
            },
          );

      return {
        filename: result.public_id,
        url: result.secure_url,
        mimeType: file.mimetype,
        size: file.size,
        provider: 'cloudinary',
      };
    } catch (error) {
      this.logger.error({ err: error }, 'Cloudinary upload failed');
      throw new ServiceUnavailableException('Could not upload file to Cloudinary');
    }
  }

  private uploadAudioStream(
    buffer: Buffer,
    folder: string,
    publicId: string,
  ): Promise<{ public_id: string; secure_url: string }> {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder,
          public_id: publicId,
          resource_type: 'video',
          use_filename: false,
          unique_filename: false,
        },
        (error, result) => {
          if (error) {
            reject(error);
            return;
          }
          if (!result?.secure_url || !result.public_id) {
            reject(new Error('Cloudinary audio upload returned no URL'));
            return;
          }
          resolve({ public_id: result.public_id, secure_url: result.secure_url });
        },
      );
      Readable.from(buffer).pipe(uploadStream);
    });
  }

  private saveToDisk(
    file: Express.Multer.File,
    req?: {
      protocol?: string;
      get?: (name: string) => string | undefined;
      headers?: Record<string, unknown>;
    },
  ): UploadedFileResult {
    this.ensureUploadDir();

    const ext =
      extname(file.originalname) ||
      (file.mimetype === 'application/pdf'
        ? '.pdf'
        : file.mimetype.startsWith('audio/')
          ? audioExtension(file.mimetype)
          : '.jpg');
    const filename = `${randomUUID()}${ext}`;
    writeFileSync(join(this.uploadDir, filename), file.buffer);

    const baseUrl = this.publicBaseUrl(req);
    return {
      filename,
      url: `${baseUrl}/uploads/${filename}`,
      mimeType: file.mimetype,
      size: file.size,
      provider: 'local',
    };
  }
}

function audioExtension(mime: string): string {
  return (
    {
      'audio/mpeg': '.mp3',
      'audio/mp4': '.m4a',
      'audio/m4a': '.m4a',
      'audio/aac': '.aac',
      'audio/webm': '.webm',
      'audio/ogg': '.ogg',
      'audio/wav': '.wav',
    }[mime] ?? '.m4a'
  );
}

function extensionForMime(mime: string): string {
  if (mime === 'application/pdf') return '.pdf';
  if (mime.startsWith('audio/')) return audioExtension(mime);
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  return '.jpg';
}
