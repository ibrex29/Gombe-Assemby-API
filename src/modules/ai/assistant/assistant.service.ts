import {
  BadGatewayException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { JwtPayload } from '@electromon/shared';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MetricsService } from '../../../common/metrics/metrics.service';
import { ContestService } from '../../../common/contest/contest.service';
import { CollationBrowseService } from '../../collation/collation-browse.service';
import { OpenRouterClient } from '../core/llm/openrouter.client';
import { LlmError, LlmMessage, LlmToolChoice } from '../core/llm/llm.types';
import { ChatRequestDto } from './dto/chat.dto';
import { ToolOutcome, isGrounded } from './grounding/grounding';
import { ReadonlyDbService } from './sql/readonly-db.service';
import {
  GROUNDING_FALLBACK_MESSAGE,
  buildGroundingRetryMessage,
  buildSystemPrompt,
  SPOKEN_REMINDER,
  splitSpoken,
  stripReasoning,
} from './prompts/system-prompt';
import {
  extractLeakedToolCalls,
  isScaffoldingOnly,
  looksLikeLeakedToolContent,
  sanitizeAssistantText,
} from './sanitize-model-output';
import { ChartSpec } from './charts/chart-builder';
import { EvidencePhoto, EvidenceService } from './evidence/evidence.service';
import { AgentsService } from '../../agents/agents.service';
import { PulseforgeSyncService } from '../social/pulseforge/pulseforge-sync.service';
import { TriageService } from '../triage/triage.service';
import { ChatEvent } from './streaming/ndjson';
import {
  ASSISTANT_TOOL_DEFINITIONS,
  type ContactCard,
  ToolContext,
  ToolContextBase,
  findAssistantTool,
} from './tools/assistant-tools';
import { AssistantThreadsService } from './assistant-threads.service';

/** Turns kept from client history. Matches the reference implementation. */
const MAX_HISTORY_TURNS = 20;
/** Tool round-trips per attempt before the loop gives up. */
const MAX_TOOL_STEPS = 6;

/** User-facing copy when the model call fails before any tool results land. */
function assistantModelFailureText(
  error: unknown,
  outcomes: ToolOutcome[],
): string {
  if (outcomes.length > 0) {
    return 'I ran out of time working through that question. The data I did retrieve is above; try asking for one part of it at a time.';
  }
  if (error instanceof LlmError) {
    if (error.status === 403) {
      return 'The AI provider rejected this request — the OpenRouter API key has hit its usage limit. Update OPENROUTER_API_KEY in the API .env and restart the server.';
    }
    if (
      error.message.includes('timed out') ||
      error.message.includes('TimeoutError')
    ) {
      return 'I could not reach the model in time. Please try that again, or ask for a narrower slice of the data.';
    }
    if (error.message.includes('not configured')) {
      return 'The AI assistant is not configured on this server.';
    }
    if (error.message.includes('unreachable')) {
      return 'I could not reach the AI provider. Check your network connection and try again.';
    }
    if (error.providerDetail) {
      return `The AI provider returned an error: ${error.providerDetail}`;
    }
  }
  return 'I could not reach the model in time. Please try that again, or ask for a narrower slice of the data.';
}

export interface ChatResult {
  reply: string;
  spoken: string | null;
  grounded: boolean;
  suppressed: boolean;
  model: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  toolCalls: Array<{ tool: string; ok: boolean }>;
  attachments: EvidencePhoto[];
  charts: ChartSpec[];
  /** Rendered by the client; the numbers never pass through the model's text. */
  contacts: ContactCard[];
  threadId: string;
  userMessageId: string;
  assistantMessageId: string;
}

type Emit = (event: ChatEvent) => void;

interface AttemptResult {
  text: string;
  outcomes: ToolOutcome[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  model: string;
  attachments: EvidencePhoto[];
  charts: ChartSpec[];
  contacts: ContactCard[];
  /** Set when the model call failed or timed out and the text is a fallback. */
  timedOut?: boolean;
}

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private prisma: PrismaService,
    private llm: OpenRouterClient,
    private browse: CollationBrowseService,
    private contests: ContestService,
    private metrics: MetricsService,
    private readonlyDb: ReadonlyDbService,
    private evidence: EvidenceService,
    private triage: TriageService,
    private agents: AgentsService,
    private social: PulseforgeSyncService,
    private threads: AssistantThreadsService,
  ) {}

  private async assertCampaignAccess(userId: string, campaignId: string) {
    const membership = await this.prisma.campaignMembership.findFirst({
      where: { userId, campaignId, isActive: true },
    });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this campaign');
    }
    return membership;
  }

  async chat(
    user: JwtPayload,
    dto: ChatRequestDto,
    emit: Emit,
  ): Promise<ChatResult> {
    const startedAt = Date.now();

    if (!this.llm.isConfigured() || !this.readonlyDb.isConfigured()) {
      this.metrics.recordAiRequest('not_configured', 0);
      throw new ServiceUnavailableException('AI assistant is not configured');
    }
    if (!user.campaignId) {
      throw new ForbiddenException('Campaign membership required');
    }
    await this.assertCampaignAccess(user.sub, user.campaignId);

    const { threadId, history: storedHistory } =
      await this.threads.resolveThreadForChat(
        user,
        dto.threadId,
        dto.threadId ? undefined : dto.history,
      );
    const userMessage = await this.threads.appendUserMessage(
      threadId,
      dto.message,
    );

    const campaign = await this.prisma.campaign.findUniqueOrThrow({
      where: { id: user.campaignId },
      select: {
        name: true,
        clientPartyCode: true,
        isNational: true,
        state: { select: { name: true } },
      },
    });

    const races = await this.contests.list(user.campaignId);
    const system = buildSystemPrompt({
      stateName: campaign.state.name,
      campaignName: campaign.name,
      clientPartyCode: campaign.clientPartyCode,
      isNational: campaign.isNational,
      races: races.map((race) => ({
        type: race.type,
        slug: race.slug,
        label: race.label,
      })),
    });

    const baseMessages: LlmMessage[] = [
      { role: 'system', content: system },
      ...storedHistory
        .slice(-MAX_HISTORY_TURNS)
        .map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: dto.message },
      { role: 'system', content: SPOKEN_REMINDER },
    ];

    // Collectors are created per attempt inside runAttempt, so a grounding retry
    // starts with a clean slate rather than inheriting the first draft's photos.
    const toolContext: ToolContextBase = {
      user,
      campaignId: user.campaignId,
      browse: this.browse,
      contests: this.contests,
      readonlyDb: this.readonlyDb,
      evidence: this.evidence,
      triage: this.triage,
      agents: this.agents,
      social: this.social,
      emit: (label, tool) => emit({ type: 'status', label, tool }),
    };

    try {
      emit({ type: 'status', label: 'Thinking' });
      let attempt = await this.runAttempt(baseMessages, toolContext, 'auto');
      // attempt.text still contains the spoken section, so checking it here
      // grounds the read-aloud figures as well as the written ones.
      let verdict = isGrounded(attempt.text, attempt.outcomes);
      const usage = { ...attempt.usage };
      const allOutcomes = [...attempt.outcomes];

      // A timed-out attempt has nothing to correct: the fallback text carries no
      // figures, and retrying spends another sixty seconds to say the same
      // thing. Skip straight to returning what we have.
      if (attempt.timedOut) {
        const durationSeconds = (Date.now() - startedAt) / 1000;
        this.metrics.recordAiRequest('error', durationSeconds);
        return this.persistAssistantTurn(threadId, userMessage.id, {
          reply: attempt.text,
          spoken: null,
          grounded: false,
          suppressed: false,
          model: attempt.model,
          usage,
          toolCalls: allOutcomes.map((outcome) => ({
            tool: outcome.tool,
            ok: outcome.ok,
          })),
          attachments: [],
          charts: [],
          contacts: [],
        });
      }

      if (!verdict.grounded) {
        // One corrective pass, forced to call a tool first so the model cannot
        // simply restate the same unverified answer.
        this.metrics.recordAiGrounding('retried');
        emit({ type: 'status', label: 'Verifying figures against the data' });

        const retryMessages: LlmMessage[] = [
          ...baseMessages,
          { role: 'assistant', content: attempt.text },
          {
            role: 'user',
            content: buildGroundingRetryMessage(verdict.missing),
          },
        ];
        const retry = await this.runAttempt(
          retryMessages,
          toolContext,
          'required',
        );

        usage.inputTokens += retry.usage.inputTokens;
        usage.outputTokens += retry.usage.outputTokens;
        usage.totalTokens += retry.usage.totalTokens;
        allOutcomes.push(...retry.outcomes);
        attempt = retry;
        verdict = isGrounded(retry.text, retry.outcomes);
      }

      const suppressed = !verdict.grounded;
      const split = splitSpoken(attempt.text);
      const reply = suppressed ? GROUNDING_FALLBACK_MESSAGE : split.reply;
      // A suppressed answer has nothing verified worth reading aloud, and its
      // photos and charts belonged to the discarded draft.
      const spoken = suppressed ? null : split.spoken;
      const attachments = suppressed ? [] : attempt.attachments;
      const charts = suppressed ? [] : attempt.charts;
      const contacts = suppressed ? [] : attempt.contacts;

      if (suppressed) {
        this.metrics.recordAiGrounding('suppressed');
        await this.auditSuppression(user, dto, attempt, verdict.missing);
      } else {
        this.metrics.recordAiGrounding('grounded');
      }

      const durationSeconds = (Date.now() - startedAt) / 1000;
      this.metrics.recordAiRequest(
        suppressed ? 'suppressed' : 'answered',
        durationSeconds,
      );
      this.metrics.recordAiTokens(usage.inputTokens, usage.outputTokens);

      return this.persistAssistantTurn(threadId, userMessage.id, {
        reply,
        spoken,
        grounded: verdict.grounded,
        suppressed,
        model: attempt.model,
        usage,
        toolCalls: allOutcomes.map((outcome) => ({
          tool: outcome.tool,
          ok: outcome.ok,
        })),
        attachments,
        charts,
        contacts,
      });
    } catch (error) {
      this.metrics.recordAiRequest('error', (Date.now() - startedAt) / 1000);
      if (error instanceof LlmError) {
        this.logger.warn({ err: error }, 'AI assistant provider failure');
        throw new BadGatewayException(error.message);
      }
      throw error;
    }
  }

  private async persistAssistantTurn(
    threadId: string,
    userMessageId: string,
    result: Omit<ChatResult, 'threadId' | 'userMessageId' | 'assistantMessageId'>,
  ): Promise<ChatResult> {
    const assistantMessage = await this.threads.appendAssistantMessage(
      threadId,
      userMessageId,
      result,
    );
    return {
      ...result,
      threadId,
      userMessageId,
      assistantMessageId: assistantMessage.id,
    };
  }

  /**
   * results back, repeat until it answers or the step budget runs out.
   */
  private async runAttempt(
    messages: LlmMessage[],
    base: ToolContextBase,
    initialToolChoice: LlmToolChoice,
  ): Promise<AttemptResult> {
    const conversation = [...messages];
    const outcomes: ToolOutcome[] = [];
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let model = '';

    const attachments: EvidencePhoto[] = [];
    const charts: ChartSpec[] = [];
    const contacts: ContactCard[] = [];
    const toolResults = new Map<string, unknown>();

    const toolContext: ToolContext = {
      ...base,
      toolResults,
      attachPhotos: (photos) => {
        // Renumber so refs stay unique and sequential across several calls.
        const added = photos.map((photo, index) => ({
          ...photo,
          ref: attachments.length + index + 1,
        }));
        attachments.push(...added);
        return added;
      },
      attachChart: (chart) => {
        charts.push(chart);
      },
      attachContacts: (card) => {
        contacts.push(card);
      },
    };

    for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
      let completion: Awaited<ReturnType<typeof this.llm.complete>>;
      try {
        completion = await this.llm.complete('assistant', {
          messages: conversation,
          tools: ASSISTANT_TOOL_DEFINITIONS,
          // Force a tool only on the first step; later steps must be free to
          // answer, otherwise the loop can never terminate.
          toolChoice: step === 0 ? initialToolChoice : 'auto',
          temperature: 0,
        });
      } catch (error) {
        // The model call itself failed — usually the 60s timeout on a question
        // that sent it down a long chain of queries. Only tool failures were
        // caught before, so this escaped the loop and surfaced as a bare 500.
        // A war room needs a sentence it can act on, not a stack trace.
        this.logger.warn(
          `Assistant model call failed on step ${step}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return {
          text: assistantModelFailureText(error, outcomes),
          outcomes,
          usage,
          model,
          attachments,
          charts,
          contacts,
          timedOut: true,
        };
      }

      usage.inputTokens += completion.usage.inputTokens;
      usage.outputTokens += completion.usage.outputTokens;
      usage.totalTokens += completion.usage.totalTokens;
      model = completion.model;

      let toolCalls = completion.toolCalls;
      let answerContent = completion.content;

      if (
        toolCalls.length === 0 &&
        answerContent &&
        looksLikeLeakedToolContent(answerContent)
      ) {
        const leaked = extractLeakedToolCalls(answerContent);
        if (leaked.length > 0) {
          toolCalls = leaked;
          answerContent = null;
        }
      }

      if (toolCalls.length === 0) {
        const text = sanitizeAssistantText(stripReasoning(answerContent?.trim() ?? ''));
        if (
          !text &&
          answerContent &&
          (looksLikeLeakedToolContent(answerContent) ||
            isScaffoldingOnly(answerContent))
        ) {
          conversation.push({
            role: 'user',
            content:
              'Your last message contained tool markup instead of an answer. ' +
              'Use the tools silently, then reply in plain English with the findings.',
          });
          continue;
        }
        return {
          text,
          outcomes,
          usage,
          model,
          attachments,
          charts,
          contacts,
        };
      }

      conversation.push({
        role: 'assistant',
        content: answerContent,
        tool_calls: toolCalls,
      });

      for (const call of toolCalls) {
        const outcome = await this.executeToolCall(
          call.function.name,
          call.function.arguments,
          toolContext,
        );
        outcomes.push(outcome);
        // make_chart builds its series from the real output of an earlier tool.
        if (outcome.ok) toolResults.set(outcome.tool, outcome.output);
        conversation.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify(outcome.output),
        });
      }
    }

    // Out of steps: ask once more with tools withheld so it must summarise.
    const finalCompletion = await this.llm.complete('assistant', {
      messages: conversation,
      temperature: 0,
    });
    usage.inputTokens += finalCompletion.usage.inputTokens;
    usage.outputTokens += finalCompletion.usage.outputTokens;
    usage.totalTokens += finalCompletion.usage.totalTokens;

    return {
      attachments,
      charts,
      contacts,
      text: sanitizeAssistantText(stripReasoning(finalCompletion.content?.trim() ?? '')),
      outcomes,
      usage,
      model: finalCompletion.model || model,
    };
  }

  private async executeToolCall(
    name: string,
    rawArguments: string,
    ctx: ToolContext,
  ): Promise<ToolOutcome> {
    const tool = findAssistantTool(name);
    if (!tool) {
      this.metrics.recordAiToolCall(name, false);
      return {
        tool: name,
        ok: false,
        output: { error: `Unknown tool "${name}".` },
      };
    }

    let args: Record<string, unknown> = {};
    try {
      // Models emit malformed JSON often enough that this must never throw out.
      args = rawArguments
        ? (JSON.parse(rawArguments) as Record<string, unknown>)
        : {};
    } catch {
      this.metrics.recordAiToolCall(name, false);
      return {
        tool: name,
        ok: false,
        output: {
          error:
            'Tool arguments were not valid JSON. Send valid JSON and retry.',
        },
      };
    }

    try {
      const output = await tool.execute(args, ctx);
      this.metrics.recordAiToolCall(name, true);
      return { tool: name, ok: true, output };
    } catch (error) {
      // Validation and query errors are handed to the model so it can retry;
      // they are not request failures.
      const message = error instanceof Error ? error.message : 'Tool failed.';
      this.metrics.recordAiToolCall(name, false);
      return { tool: name, ok: false, output: { error: message } };
    }
  }

  /**
   * A suppressed answer is an incident worth seeing later, so it is recorded
   * directly — the audit interceptor only logs that the request happened.
   */
  private async auditSuppression(
    user: JwtPayload,
    dto: ChatRequestDto,
    attempt: AttemptResult,
    missing: string[],
  ) {
    try {
      await this.prisma.activityLog.create({
        data: {
          userId: user.sub,
          campaignId: user.campaignId,
          action: 'ai.response_suppressed',
          resource: 'ai_assistant',
          metadata: {
            model: attempt.model,
            question: dto.message.slice(0, 200),
            unverifiedFigures: missing.slice(0, 20),
            toolCalls: attempt.outcomes.map((outcome) => ({
              tool: outcome.tool,
              ok: outcome.ok,
            })),
          },
        },
      });
    } catch (error) {
      this.logger.warn(
        { err: error },
        'Failed to audit suppressed AI response',
      );
    }
  }
}
