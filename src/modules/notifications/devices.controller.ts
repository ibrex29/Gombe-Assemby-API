import { Body, Controller, Delete, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { JwtPayload } from '@electromon/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/swagger.config';
import { MessageResponseDto } from '../../common/dto/api-response.dto';
import { RegisterDeviceDto, UnregisterDeviceDto } from './dto/notifications.dto';
import { NotificationsService } from './notifications.service';

@ApiTags('devices')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@Controller('devices')
export class DevicesController {
  constructor(private notifications: NotificationsService) {}

  @Put()
  @ApiOperation({ summary: 'Register or refresh this device FCM token' })
  register(@CurrentUser() user: JwtPayload, @Body() dto: RegisterDeviceDto) {
    return this.notifications.registerDevice(user, dto);
  }

  @Delete()
  @ApiOperation({ summary: 'Deactivate this device FCM token' })
  @ApiOkResponse({ type: MessageResponseDto })
  unregister(@CurrentUser() user: JwtPayload, @Body() dto: UnregisterDeviceDto) {
    return this.notifications.unregisterDevice(user, dto);
  }
}
