import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CampaignRole } from '@electromon/shared';
import type { JwtPayload } from '@electromon/shared';
import { AuditAction } from '../../common/audit/audit.decorators';
import { Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiErrorResponseDto, MessageResponseDto } from '../../common/dto/api-response.dto';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/swagger.config';
import {
  CreateCommitmentDto,
  ListCommitmentsQueryDto,
  UpdateCommitmentDto,
} from './dto/commitment.dto';
import { CommitmentResponseDto } from './dto/commitment-response.dto';
import { CommitmentsService } from './commitments.service';

@ApiTags('commitments')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@Controller('commitments')
export class CommitmentsController {
  constructor(private commitmentsService: CommitmentsService) {}

  @Get()
  @ApiOperation({ summary: 'List commitments for a campaign' })
  @ApiOkResponse({ type: [CommitmentResponseDto] })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  list(@CurrentUser() user: JwtPayload, @Query() query: ListCommitmentsQueryDto) {
    return this.commitmentsService.list(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get commitment by ID' })
  @ApiOkResponse({ type: CommitmentResponseDto })
  findOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.commitmentsService.findOne(user, id);
  }

  @Post()
  @Roles(
    CampaignRole.CAMPAIGN_DIRECTOR,
    CampaignRole.STATE_COLLATION_OFFICER,
    CampaignRole.LGA_COLLATION_OFFICER,
    CampaignRole.SUPPORT_GROUP_LEADER,
  )
  @AuditAction('commitment.create')
  @ApiOperation({ summary: 'Create a new commitment' })
  @ApiCreatedResponse({ type: CommitmentResponseDto })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateCommitmentDto) {
    return this.commitmentsService.create(user, dto);
  }

  @Patch(':id')
  @Roles(
    CampaignRole.CAMPAIGN_DIRECTOR,
    CampaignRole.STATE_COLLATION_OFFICER,
    CampaignRole.LGA_COLLATION_OFFICER,
    CampaignRole.SUPPORT_GROUP_LEADER,
  )
  @AuditAction('commitment.update')
  @ApiOperation({ summary: 'Update a commitment' })
  @ApiOkResponse({ type: CommitmentResponseDto })
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateCommitmentDto,
  ) {
    return this.commitmentsService.update(user, id, dto);
  }

  @Delete(':id')
  @Roles(CampaignRole.CAMPAIGN_DIRECTOR, CampaignRole.STATE_COLLATION_OFFICER)
  @AuditAction('commitment.delete')
  @ApiOperation({ summary: 'Delete a commitment' })
  @ApiOkResponse({ type: MessageResponseDto })
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.commitmentsService.remove(user, id);
  }
}
