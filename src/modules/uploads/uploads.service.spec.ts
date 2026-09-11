import { BadRequestException } from '@nestjs/common';
import { PassThrough } from 'stream';
import { UploadsService } from './uploads.service';

const uploadMock = jest.fn();
const uploadStreamMock = jest.fn();
const configMock = jest.fn();

jest.mock('cloudinary', () => ({
  v2: {
    config: (...args: unknown[]) => configMock(...args),
    uploader: {
      upload: (...args: unknown[]) => uploadMock(...args),
      upload_stream: (...args: unknown[]) => uploadStreamMock(...args),
    },
  },
}));

function multerFile(
  overrides: Partial<Express.Multer.File> & Pick<Express.Multer.File, 'mimetype' | 'buffer'>,
): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'test.bin',
    encoding: '7bit',
    size: overrides.buffer.length,
    stream: null as never,
    destination: '',
    filename: '',
    path: '',
    ...overrides,
  };
}

describe('UploadsService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      CLOUDINARY_URL: 'cloudinary://key:secret@test-cloud',
      CLOUDINARY_FOLDER: 'electromon/uploads',
      NODE_ENV: 'test',
    };

    uploadMock.mockResolvedValue({
      public_id: 'electromon/uploads/img-id',
      secure_url: 'https://res.cloudinary.com/test/image/upload/img.jpg',
    });

    uploadStreamMock.mockImplementation((options, callback) => {
      const stream = new PassThrough();
      process.nextTick(() => {
        callback(null, {
          public_id: `${options.folder}/${options.public_id}`,
          secure_url: `https://res.cloudinary.com/test/video/upload/${options.folder}/${options.public_id}.m4a`,
        });
      });
      return stream;
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uploads audio with resource_type video and voice subfolder', async () => {
    const service = new UploadsService();
    const buffer = Buffer.from('fake-audio');
    const file = multerFile({
      mimetype: 'audio/mp4',
      buffer,
      originalname: 'voice.m4a',
    });

    const result = await service.saveFile(file);

    expect(uploadStreamMock).toHaveBeenCalledTimes(1);
    expect(uploadStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        folder: 'electromon/uploads/voice',
        resource_type: 'video',
      }),
      expect.any(Function),
    );
    expect(uploadMock).not.toHaveBeenCalled();
    expect(result.provider).toBe('cloudinary');
    expect(result.url).toContain('res.cloudinary.com');
    expect(result.mimeType).toBe('audio/mp4');
  });

  it('uploads images with resource_type auto in the base folder', async () => {
    const service = new UploadsService();
    const file = multerFile({
      mimetype: 'image/jpeg',
      buffer: Buffer.from('fake-image'),
      originalname: 'photo.jpg',
    });

    const result = await service.saveFile(file);

    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(uploadMock).toHaveBeenCalledWith(
      expect.stringContaining('data:image/jpeg;base64,'),
      expect.objectContaining({
        folder: 'electromon/uploads',
        resource_type: 'auto',
      }),
    );
    expect(uploadStreamMock).not.toHaveBeenCalled();
    expect(result.provider).toBe('cloudinary');
  });

  it('rejects unsupported mime types', async () => {
    const service = new UploadsService();
    const file = multerFile({
      mimetype: 'application/zip',
      buffer: Buffer.from('zip'),
    });

    await expect(service.saveFile(file)).rejects.toBeInstanceOf(BadRequestException);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(uploadStreamMock).not.toHaveBeenCalled();
  });

  it('rejects files larger than 5 MB', async () => {
    const service = new UploadsService();
    const file = multerFile({
      mimetype: 'image/jpeg',
      buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
      size: 5 * 1024 * 1024 + 1,
    });

    await expect(service.saveFile(file)).rejects.toBeInstanceOf(BadRequestException);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(uploadStreamMock).not.toHaveBeenCalled();
  });

  it('accepts WhatsApp ogg/opus voice notes', async () => {
    const service = new UploadsService();
    const result = await service.saveBuffer({
      buffer: Buffer.from('fake-ogg'),
      mimeType: 'audio/ogg; codecs=opus',
      originalname: 'voice.ogg',
    });

    expect(uploadStreamMock).toHaveBeenCalled();
    expect(result.mimeType).toBe('audio/ogg');
  });

  it('rejects audio larger than 16 MB', async () => {
    const service = new UploadsService();
    await expect(
      service.saveBuffer({
        buffer: Buffer.alloc(16 * 1024 * 1024 + 1),
        mimeType: 'audio/ogg',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(uploadStreamMock).not.toHaveBeenCalled();
  });
});
