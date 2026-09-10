import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ChatTurnDto {
  @ApiProperty({ enum: ['user', 'assistant'], example: 'user' })
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @ApiProperty({ example: 'Which LGAs are we losing?' })
  @IsString()
  @MaxLength(8000)
  content: string;
}

export class ChatRequestDto {
  @ApiProperty({
    example: 'Which LGAs are we currently losing, and by how much?',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  message: string;

  @ApiPropertyOptional({
    description:
      'Existing thread id. When set, prior turns are loaded from the server and history in the body is ignored.',
  })
  @IsOptional()
  @IsString()
  threadId?: string;

  @ApiPropertyOptional({
    type: [ChatTurnDto],
    description:
      'Prior turns for a brand-new thread without threadId. Max 40; the service uses the last 20.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => ChatTurnDto)
  history?: ChatTurnDto[];

  @ApiPropertyOptional({
    description:
      'Stream NDJSON progress events instead of returning one JSON body.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  stream?: boolean;
}

export class ChatUsageDto {
  @ApiProperty() inputTokens: number;
  @ApiProperty() outputTokens: number;
  @ApiProperty() totalTokens: number;
}

export class ChatToolCallDto {
  @ApiProperty({ example: 'run_sql' }) tool: string;
  @ApiProperty() ok: boolean;
}

export class ChatAttachmentDto {
  @ApiProperty({ description: 'Number the reply cites, e.g. "photo 2".' }) ref: number;
  @ApiProperty({ enum: ['incident', 'ec8a'] }) kind: 'incident' | 'ec8a';
  @ApiProperty() url: string;
  @ApiProperty() caption: string;
  @ApiProperty({ nullable: true }) takenAt: string | null;
}

export class ChartPointDto {
  @ApiProperty() label: string;
  @ApiProperty() value: number;
}

export class ChatChartDto {
  @ApiProperty({ enum: ['bar', 'donut'] }) type: 'bar' | 'donut';
  @ApiProperty() title: string;
  @ApiProperty() unit: string;
  @ApiProperty({ type: [ChartPointDto] }) series: ChartPointDto[];
}

export class ChatResponseDto {
  @ApiProperty() reply: string;

  @ApiProperty({
    nullable: true,
    description: 'Short prose version of the answer, for read-aloud.',
  })
  spoken: string | null;

  @ApiProperty({
    description: 'Every figure in the reply was traced to a tool result.',
  })
  grounded: boolean;

  @ApiProperty({
    description: 'The model answer was withheld and replaced with a fallback.',
  })
  suppressed: boolean;

  @ApiProperty({ example: 'anthropic/claude-sonnet-5' }) model: string;

  @ApiProperty({ type: ChatUsageDto }) usage: ChatUsageDto;

  @ApiProperty({ type: [ChatToolCallDto] }) toolCalls: ChatToolCallDto[];

  @ApiProperty({
    type: [ChatAttachmentDto],
    description: 'Photo evidence. URLs come from the server, never from the model.',
  })
  attachments: ChatAttachmentDto[];

  @ApiProperty({
    type: [ChatChartDto],
    description: 'Charts built from tool results, not from model-authored numbers.',
  })
  charts: ChatChartDto[];

  @ApiProperty({ description: 'Server thread id for follow-up messages.' })
  threadId: string;

  @ApiProperty() userMessageId: string;

  @ApiProperty() assistantMessageId: string;
}
