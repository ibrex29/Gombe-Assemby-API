import {
  Controller,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CampaignRole } from '@electromon/shared';
import { memoryStorage } from 'multer';
import type { Request } from 'express';
import { Roles } from '../../common/decorators/auth.decorators';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/swagger.config';
import { UploadsService } from './uploads.service';

@ApiTags('uploads')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@Controller('uploads')
export class UploadsController {
  constructor(private uploadsService: UploadsService) {}

  @Post()
  @Roles(
    CampaignRole.CAMPAIGN_DIRECTOR,
    CampaignRole.STATE_COLLATION_OFFICER,
    CampaignRole.LGA_COLLATION_OFFICER,
    CampaignRole.WARD_RA_OFFICER,
    CampaignRole.POLLING_AGENT,
  )
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({ summary: 'Upload EC8A photo or supporting document' })
  @ApiCreatedResponse({ description: 'Uploaded file metadata with public URL' })
  async upload(@UploadedFile() file: Express.Multer.File, @Req() req: Request) {
    return this.uploadsService.saveFile(file, req);
  }
}
