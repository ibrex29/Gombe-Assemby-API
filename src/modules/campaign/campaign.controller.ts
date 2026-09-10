import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CampaignService } from './campaign.service';
import { CampaignListItemDto } from '../structure/dto/structure-response.dto';
import { ApiErrorResponseDto } from '../../common/dto/api-response.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/swagger.config';
import type { JwtPayload } from '@electromon/shared';

@ApiTags('campaigns')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@Controller('campaigns')
export class CampaignController {
  constructor(private campaignService: CampaignService) {}

  @Get()
  @ApiOperation({
    summary: 'List campaigns for current user',
    description: 'Returns all campaigns the authenticated user is a member of.',
  })
  @ApiOkResponse({ type: [CampaignListItemDto] })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  list(@CurrentUser() user: JwtPayload) {
    return this.campaignService.listForUser(user.sub);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get campaign details',
    description: 'Returns campaign with full geographic tree (state, LGAs, wards, polling unit counts).',
  })
  @ApiParam({ name: 'id', description: 'Campaign ID', example: 'cms147z3t001www9ktkqgluw0' })
  @ApiOkResponse({ type: CampaignListItemDto })
  @ApiNotFoundResponse({ type: ApiErrorResponseDto })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  getOne(@Param('id') id: string) {
    return this.campaignService.findById(id);
  }
}
