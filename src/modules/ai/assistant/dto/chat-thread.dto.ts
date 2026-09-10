import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ChatAttachmentDto, ChatChartDto } from './chat.dto';

export class ChatThreadSummaryDto {
  @ApiProperty() id: string;
  @ApiProperty() title: string;
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
}

export class ChatMessageDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ['user', 'assistant'] }) role: 'user' | 'assistant';
  @ApiProperty() content: string;
  @ApiPropertyOptional({ nullable: true }) replyTo?: string | null;
  @ApiPropertyOptional({ nullable: true }) spoken?: string | null;
  @ApiPropertyOptional() meta?: {
    grounded: boolean;
    suppressed: boolean;
    model: string;
  } | null;
  @ApiPropertyOptional({ type: [ChatAttachmentDto] }) attachments?: ChatAttachmentDto[];
  @ApiPropertyOptional({ type: [ChatChartDto] }) charts?: ChatChartDto[];
  @ApiPropertyOptional() contacts?: unknown[];
  @ApiProperty() createdAt: string;
}

export class ChatThreadDetailDto extends ChatThreadSummaryDto {
  @ApiProperty({ type: [ChatMessageDto] }) messages: ChatMessageDto[];
}

export class CreateChatThreadDto {
  @ApiPropertyOptional({ example: 'Race pressure briefing' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;
}

export class ChatThreadListDto {
  @ApiProperty({ type: [ChatThreadSummaryDto] }) threads: ChatThreadSummaryDto[];
}

export class ChatMessageMetaDto {
  @ApiProperty() grounded: boolean;
  @ApiProperty() suppressed: boolean;
  @ApiProperty() model: string;
}

export class PersistedChatResponseFieldsDto {
  @ApiProperty({ description: 'Server thread id — send on subsequent turns.' })
  threadId: string;

  @ApiProperty({ description: 'Persisted user message id for this turn.' })
  userMessageId: string;

  @ApiProperty({ description: 'Persisted assistant message id for this turn.' })
  assistantMessageId: string;
}
