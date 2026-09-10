import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { promisify } from 'util';
import sharp from 'sharp';
import { OpenRouterClient } from '../ai/core/llm/openrouter.client';
import { LlmError, type LlmContentPart } from '../ai/core/llm/llm.types';
import { parseAiEc8aJson } from './ec8a-ai-parse';
import { FIELD_PATTERNS, type VisionExtract } from './ocr-ec8a-parse';

const IMAGE_MAX_DIMENSION = 2000;
const IREV_LANDSCAPE_MAX_DIMENSION = 2600;
const IMAGE_REENCODE_BYTES = 1_500_000;
const LANDSCAPE_ASPECT_RATIO = 1.15;
const IREV_PDF_DPI = 250;
const execFileAsync = promisify(execFile);

type PrepareImageOptions = {
  /** Official IReV scans are often landscape PDFs — apply stronger normalization. */
  forIrev?: boolean;
};

type ExtractAiOptions = {
  scanKind?: 'agent' | 'irev';
  landscape?: boolean;
};

/** True when the scan is wider than tall (typical INEC IReV PDF layout). */
export function isLandscapeScan(width: number, height: number): boolean {
  return width > 0 && height > 0 && width > height * LANDSCAPE_ASPECT_RATIO;
}

/**
 * Reads EC8A form figures from uploaded photos via the AI module (OpenRouter
 * vision), replacing Google Cloud Vision which was too inaccurate on handwritten
 * sheets. Still returns {@link VisionExtract} so scan + verify workers stay unchanged.
 */
@Injectable()
export class Ec8aPhotoReaderService {
  private readonly logger = new Logger(Ec8aPhotoReaderService.name);

  constructor(private llm: OpenRouterClient) {
    if (this.isConfigured()) {
      this.logger.log(
        `EC8A photo reader ready (AI OCR model: ${this.llm.getModelId('ocr')})`,
      );
    } else {
      this.logger.warn(
        'OPENROUTER_API_KEY is not set; EC8A photo reading is disabled',
      );
    }
  }

  isConfigured() {
    return this.llm.isConfigured() && this.llm.getModelId('ocr') != null;
  }

  async extractEc8aFromUrl(documentUrl: string, partyCodes: string[]): Promise<VisionExtract> {
    if (!this.isConfigured()) {
      return {
        fields: {},
        partyResults: {},
        confidence: null,
        unreadable: true,
        error: 'AI photo reading is not configured — set OPENROUTER_API_KEY',
      };
    }

    const content = await this.downloadRemote(documentUrl);
    if (!content) {
      return {
        fields: {},
        partyResults: {},
        confidence: null,
        unreadable: true,
        error: 'Could not download official IReV scan',
      };
    }

    let imageBuffer = content;
    if (this.isPdfUrl(documentUrl) || this.isPdfBuffer(content)) {
      const converted = await this.pdfFirstPageToImage(content, IREV_PDF_DPI);
      if (!converted) {
        return {
          fields: {},
          partyResults: {},
          confidence: null,
          unreadable: true,
          error: 'Could not render PDF IReV scan for OCR',
        };
      }
      imageBuffer = converted;
    }

    const prepared = await this.prepareImage(imageBuffer, { forIrev: true });
    try {
      return await this.extractWithAi([prepared], partyCodes, {
        scanKind: 'irev',
        landscape: prepared.landscape,
      });
    } catch (error) {
      this.logger.warn({ err: error, documentUrl }, 'IReV EC8A read failed');
      const message =
        error instanceof LlmError
          ? error.message
          : 'AI could not read the official IReV scan';
      return {
        fields: {},
        partyResults: {},
        confidence: null,
        unreadable: true,
        error: message,
      };
    }
  }

  async extractEc8a(photoUrls: string[], partyCodes: string[]): Promise<VisionExtract> {
    if (!this.isConfigured()) {
      return {
        fields: {},
        partyResults: {},
        confidence: null,
        unreadable: true,
        error: 'AI photo reading is not configured — set OPENROUTER_API_KEY',
      };
    }

    const images: Array<{ mime: string; base64: string }> = [];
    for (const url of photoUrls) {
      const file = await this.readPhoto(url);
      if (!file) continue;
      const prepared = await this.prepareImage(file);
      images.push(prepared);
    }

    if (images.length === 0) {
      return {
        fields: {},
        partyResults: {},
        confidence: null,
        unreadable: true,
        error: 'EC8A photo file was not found on disk',
      };
    }

    try {
      return await this.extractWithAi(images, partyCodes);
    } catch (error) {
      this.logger.warn({ err: error }, 'AI EC8A photo read failed');
      const message =
        error instanceof LlmError
          ? error.message
          : 'AI could not read the EC8A photo';
      return {
        fields: {},
        partyResults: {},
        confidence: null,
        unreadable: true,
        error: `${message} — retake with better light or tap Read photo again`,
      };
    }
  }

  private async extractWithAi(
    images: Array<{ mime: string; base64: string }>,
    partyCodes: string[],
    options: ExtractAiOptions = {},
  ): Promise<VisionExtract> {
    const parties = [...new Set(partyCodes.map((c) => c.toUpperCase()).filter(Boolean))];
    const fieldList = FIELD_PATTERNS.map((f) => `- ${f.field}: ${f.label}`).join('\n');
    const partyHint =
      parties.length > 0
        ? parties.join(', ')
        : 'use the party codes printed on the form (e.g. APC, PDP, LP)';

    const system = `You read Nigerian INEC Form EC8A (Statement of Result) photographs for election collation.

Extract ONLY digits written on the form. Ignore printed instructions and location codes.
Handwriting is common — read carefully. Prefer the figure in the "figures" / amount column over serial numbers.

Return JSON only in this exact shape:
{
  "fields": {
    "registeredVoters": number|null,
    "accreditedVoters": number|null,
    "ballotPapersIssued": number|null,
    "unusedBallotPapers": number|null,
    "spoiledBallotPapers": number|null,
    "invalidVotes": number|null,
    "votesCast": number|null,
    "usedBallotPapers": number|null
  },
  "partyResults": { "<PARTY_CODE>": number },
  "confidence": 0..1,
  "unreadable": boolean
}

Field meanings:
${fieldList}

partyResults: votes for each party on the sheet. Known codes for this campaign: ${partyHint}.
Use uppercase party codes. Omit parties with no readable vote total.
confidence: how sure you are overall (0–1). Use ≤0.5 if many fields are unclear.
unreadable: true only if the photo is blank, too blurry, or not an EC8A.

Never invent numbers. Use null for a field you cannot read.${
      options.scanKind === 'irev'
        ? `

Official IReV scans are often landscape (wide). When the sheet is wide or sideways:
- Summary boxes numbered 1–8 are on the RIGHT of the form — read the handwritten figure in the "In figures" column for each numbered box only.
- Party vote rows are in the table — match each party code to its vote in the figures column, not serial numbers or location codes.
- Ignore PU codes, ward codes, and printed form numbers when extracting totals.
- If a summary figure looks implausibly large compared to party votes, re-check you are reading the correct column for that box number.`
        : ''
    }${
      options.landscape
        ? `

This image is landscape-oriented. Read carefully across the wide layout; do not swap columns between summary boxes and party rows.`
        : ''
    }`;

    const parts: LlmContentPart[] = [
      {
        type: 'text',
        text: `Read the EC8A photo${images.length > 1 ? 's' : ''} and return the JSON object described in the system prompt.`,
      },
      ...images.map(
        (img): LlmContentPart => ({
          type: 'image_url',
          image_url: {
            url: `data:${img.mime};base64,${img.base64}`,
            detail: 'high',
          },
        }),
      ),
    ];

    const completion = await this.llm.complete('ocr', {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: parts },
      ],
      temperature: 0,
      maxTokens: 1200,
      jsonResponse: true,
    });

    return this.parseAiExtract(completion.content, parties);
  }

  private parseAiExtract(raw: string | null, partyCodes: string[]): VisionExtract {
    if (!raw?.trim()) {
      return {
        fields: {},
        partyResults: {},
        confidence: null,
        unreadable: true,
        error: 'AI returned an empty EC8A read',
      };
    }
    return parseAiEc8aJson(raw, partyCodes);
  }

  private async prepareImage(
    content: Buffer,
    options: PrepareImageOptions = {},
  ): Promise<{ mime: string; base64: string; landscape: boolean }> {
    try {
      const meta = await sharp(content).metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      const landscape = isLandscapeScan(width, height);
      const maxDimension =
        options.forIrev && landscape ? IREV_LANDSCAPE_MAX_DIMENSION : IMAGE_MAX_DIMENSION;
      const oversized =
        width > maxDimension ||
        height > maxDimension ||
        content.length > IMAGE_REENCODE_BYTES;

      let pipeline = sharp(content).rotate();
      if (options.forIrev && landscape) {
        pipeline = pipeline.normalize().sharpen({ sigma: 1.2 });
      }

      const prepared = oversized
        ? await pipeline
            .resize({
              width: maxDimension,
              height: maxDimension,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .jpeg({ quality: options.forIrev && landscape ? 92 : 85, mozjpeg: true })
            .toBuffer()
        : await pipeline
            .jpeg({ quality: options.forIrev && landscape ? 92 : 90, mozjpeg: true })
            .toBuffer();

      if (oversized || (options.forIrev && landscape)) {
        this.logger.log(
          {
            fromBytes: content.length,
            toBytes: prepared.length,
            fromPx: `${width}x${height}`,
            forIrev: options.forIrev ?? false,
            landscape,
          },
          'EC8A photo prepared for AI OCR',
        );
      }

      return { mime: 'image/jpeg', base64: prepared.toString('base64'), landscape };
    } catch (error) {
      this.logger.warn({ err: error }, 'EC8A photo resize failed; sending original bytes');
      const mime = sniffMime(content);
      return { mime, base64: content.toString('base64'), landscape: false };
    }
  }

  private async readPhoto(url: string): Promise<Buffer | null> {
    if (/^https?:\/\//i.test(url)) {
      return this.downloadRemote(url);
    }
    const filename = this.filenameFromUrl(url);
    if (!filename) return null;
    const fullPath = join(process.cwd(), 'uploads', filename);
    if (!existsSync(fullPath)) return null;
    if (filename.toLowerCase().endsWith('.pdf')) {
      const pdf = await readFile(fullPath);
      return this.pdfFirstPageToImage(pdf);
    }
    return readFile(fullPath);
  }

  private async downloadRemote(url: string): Promise<Buffer | null> {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'image/*,application/pdf,*/*' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        this.logger.warn({ url, status: response.status }, 'Remote EC8A download failed');
        return null;
      }
      const content = Buffer.from(await response.arrayBuffer());
      if (this.isHtmlBuffer(content)) {
        this.logger.warn({ url }, 'Remote EC8A URL returned HTML instead of a scan');
        return null;
      }
      return content;
    } catch (error) {
      this.logger.warn({ err: error, url }, 'Remote EC8A download error');
      return null;
    }
  }

  private isPdfUrl(url: string): boolean {
    return url.toLowerCase().includes('.pdf');
  }

  private isPdfBuffer(content: Buffer): boolean {
    return content.length >= 4 && content.subarray(0, 4).toString('ascii') === '%PDF';
  }

  private isHtmlBuffer(content: Buffer): boolean {
    const head = content.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
    return head.startsWith('<!doctype html') || head.startsWith('<html');
  }

  /** Render page 1 of an IReV PDF to JPEG for vision OCR (requires poppler-utils). */
  private async pdfFirstPageToImage(pdf: Buffer, dpi = 200): Promise<Buffer | null> {
    const dir = await mkdtemp(join(tmpdir(), 'irev-pdf-'));
    const pdfPath = join(dir, 'scan.pdf');
    const outPrefix = join(dir, 'page');
    try {
      await writeFile(pdfPath, pdf);
      await execFileAsync(
        'pdftoppm',
        ['-jpeg', '-f', '1', '-l', '1', '-r', String(dpi), pdfPath, outPrefix],
        { timeout: 60_000 },
      );
      const files = (await readdir(dir)).filter((file) => file.startsWith('page') && file.endsWith('.jpg'));
      if (!files[0]) return null;
      return await readFile(join(dir, files[0]));
    } catch (error) {
      this.logger.warn({ err: error }, 'PDF to image conversion failed');
      return null;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private filenameFromUrl(url: string): string | null {
    const marker = '/uploads/';
    const index = url.lastIndexOf(marker);
    const raw = index >= 0 ? url.slice(index + marker.length) : basename(url);
    const filename = raw.split('?')[0]?.split('#')[0];
    if (
      !filename ||
      filename.includes('..') ||
      filename.includes('/') ||
      filename.includes('\\')
    ) {
      return null;
    }
    return filename;
  }
}

function sniffMime(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return 'image/png';
  }
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46
  ) {
    return 'image/gif';
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'image/jpeg';
}
