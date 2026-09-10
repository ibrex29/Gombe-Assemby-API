import { Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { JwtPayload } from '@electromon/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/swagger.config';
import { ListNotificationsQueryDto } from './dto/notifications.dto';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@Controller('notifications')
export class NotificationsController {
  constructor(private notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'List in-app notifications for the current user' })
  list(@CurrentUser() user: JwtPayload, @Query() query: ListNotificationsQueryDto) {
    return this.notifications.list(user, query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Unread notification count for the current campaign' })
  unreadCount(@CurrentUser() user: JwtPayload) {
    return this.notifications.unreadCount(user);
  }

  @Post('pulse-reminder')
  @ApiOkResponse({ description: 'Current-hour status-update reminder for this user' })
  @ApiOperation({
    summary: 'Ensure this hour’s status-update reminder is in the inbox (first app open)',
  })
  nudgePulseReminder(@CurrentUser() user: JwtPayload) {
    return this.notifications.nudgePulseReminder(user);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark a notification as read' })
  markRead(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.notifications.markRead(user, id);
  }

  @Post('read-all')
  @ApiOkResponse({ description: 'All notifications marked read' })
  @ApiOperation({ summary: 'Mark all notifications in this campaign as read' })
  markAllRead(@CurrentUser() user: JwtPayload) {
    return this.notifications.markAllRead(user);
  }
}
