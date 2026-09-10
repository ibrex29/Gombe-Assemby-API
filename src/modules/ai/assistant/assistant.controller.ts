import { Body, Controller, Delete, Get, HttpCode, Logger, Param, Post, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { CampaignRole } from '@electromon/shared';
import type { JwtPayload } from '@electromon/shared';
import { AuditAction } from '../../../common/audit/audit.decorators';
import { Roles } from '../../../common/decorators/auth.decorators';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { SWAGGER_BEARER_AUTH } from '../../../common/swagger/swagger.config';
import { AssistantService } from './assistant.service';
import { AssistantThreadsService } from './assistant-threads.service';
import { ChatRequestDto, ChatResponseDto } from './dto/chat.dto';
import {
  ChatThreadDetailDto,
  ChatThreadListDto,
  CreateChatThreadDto,
} from './dto/chat-thread.dto';
import { createNdjsonWriter } from './streaming/ndjson';
import { MessageResponseDto } from '../../../common/dto/api-response.dto';

@ApiTags('ai')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@Controller('ai/assistant')
export class AssistantController {
  private readonly logger = new Logger(AssistantController.name);

  constructor(
    private assistantService: AssistantService,
    private threadsService: AssistantThreadsService,
  ) {}

  @Get('threads')
  @Roles(
    CampaignRole.CANDIDATE,
    CampaignRole.CAMPAIGN_DIRECTOR,
    CampaignRole.DATA_ANALYST,
  )
  @ApiOperation({ summary: 'List saved chat threads for the current user' })
  @ApiOkResponse({ type: ChatThreadListDto })
  listThreads(@CurrentUser() user: JwtPayload) {
    return this.threadsService.listThreads(user);
  }

  @Post('threads')
  @Roles(
    CampaignRole.CANDIDATE,
    CampaignRole.CAMPAIGN_DIRECTOR,
    CampaignRole.DATA_ANALYST,
  )
  @ApiOperation({ summary: 'Create a new empty chat thread' })
  @ApiOkResponse({ type: ChatThreadDetailDto })
  createThread(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateChatThreadDto,
  ) {
    return this.threadsService.createThread(user, dto);
  }

  @Get('threads/:id')
  @Roles(
    CampaignRole.CANDIDATE,
    CampaignRole.CAMPAIGN_DIRECTOR,
    CampaignRole.DATA_ANALYST,
  )
  @ApiOperation({ summary: 'Load a chat thread with its messages' })
  @ApiOkResponse({ type: ChatThreadDetailDto })
  getThread(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.threadsService.getThread(user, id);
  }

  @Delete('threads/:id')
  @Roles(
    CampaignRole.CANDIDATE,
    CampaignRole.CAMPAIGN_DIRECTOR,
    CampaignRole.DATA_ANALYST,
  )
  @ApiOperation({ summary: 'Delete a chat thread' })
  @ApiOkResponse({ type: MessageResponseDto })
  deleteThread(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.threadsService.deleteThread(user, id);
  }

  @Post('chat')
  @HttpCode(200)
  @Roles(
    CampaignRole.CANDIDATE,
    CampaignRole.CAMPAIGN_DIRECTOR,
    CampaignRole.DATA_ANALYST,
  )
  @AuditAction('ai.chat')
  // A turn costs a model call and several queries, so it is metered far below
  // the global 100/min default.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Ask the campaign assistant a question about live campaign data',
    description:
      'Returns JSON by default. With `stream: true` the response is NDJSON: zero or more ' +
      '`status` events, then a single `final` event. The answer is only sent after the ' +
      'grounding check, so figures are never shown before they are verified.',
  })
  @ApiOkResponse({ type: ChatResponseDto })
  @ApiServiceUnavailableResponse({
    description: 'AI assistant is not configured',
  })
  async chat(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ChatRequestDto,
    @Res() res: Response,
  ) {
    if (!dto.stream) {
      const result = await this.assistantService.chat(
        user,
        dto,
        () => undefined,
      );
      res.status(200).json(result);
      return;
    }

    const writer = createNdjsonWriter(res);
    try {
      const result = await this.assistantService.chat(user, dto, (event) =>
        writer.emit(event),
      );
      writer.emit({ type: 'final', ...result });
    } catch (error) {
      // Before the first byte, let the global filter render the usual error
      // body. After it, headers are already sent and the filter would throw on
      // top of the failure, so the error is delivered as a stream event.
      if (!writer.started) throw error;
      this.logger.warn(
        { err: error },
        'AI assistant stream failed after headers were sent',
      );
      writer.emit({
        type: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'The assistant failed to answer.',
      });
    } finally {
      if (writer.started) writer.end();
    }
  }
}
