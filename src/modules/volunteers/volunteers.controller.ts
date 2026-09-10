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
  CreateVolunteerDto,
  ListVolunteersQueryDto,
  UpdateVolunteerDto,
} from './dto/volunteer.dto';
import { VolunteerResponseDto } from './dto/volunteer-response.dto';
import { VolunteersService } from './volunteers.service';

@ApiTags('volunteers')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@Controller('volunteers')
export class VolunteersController {
  constructor(private volunteersService: VolunteersService) {}

  @Get()
  @ApiOperation({ summary: 'List volunteers for a campaign' })
  @ApiOkResponse({ type: [VolunteerResponseDto] })
  @ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
  list(@CurrentUser() user: JwtPayload, @Query() query: ListVolunteersQueryDto) {
    return this.volunteersService.list(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get volunteer by ID' })
  @ApiOkResponse({ type: VolunteerResponseDto })
  findOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.volunteersService.findOne(user, id);
  }

  @Post()
  @Roles(
    CampaignRole.CAMPAIGN_DIRECTOR,
    CampaignRole.STATE_COLLATION_OFFICER,
    CampaignRole.LGA_COLLATION_OFFICER,
    CampaignRole.VOLUNTEER_COORDINATOR,
  )
  @AuditAction('volunteer.create')
  @ApiOperation({ summary: 'Register a new volunteer' })
  @ApiCreatedResponse({ type: VolunteerResponseDto })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateVolunteerDto) {
    return this.volunteersService.create(user, dto);
  }

  @Patch(':id')
  @Roles(
    CampaignRole.CAMPAIGN_DIRECTOR,
    CampaignRole.STATE_COLLATION_OFFICER,
    CampaignRole.LGA_COLLATION_OFFICER,
    CampaignRole.VOLUNTEER_COORDINATOR,
  )
  @AuditAction('volunteer.update')
  @ApiOperation({ summary: 'Update a volunteer' })
  @ApiOkResponse({ type: VolunteerResponseDto })
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateVolunteerDto,
  ) {
    return this.volunteersService.update(user, id, dto);
  }

  @Delete(':id')
  @Roles(CampaignRole.CAMPAIGN_DIRECTOR, CampaignRole.STATE_COLLATION_OFFICER)
  @AuditAction('volunteer.delete')
  @ApiOperation({ summary: 'Delete a volunteer' })
  @ApiOkResponse({ type: MessageResponseDto })
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.volunteersService.remove(user, id);
  }
}
