import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CampaignRole, JwtPayload, ScopeType } from '@electromon/shared';
import { SPOKEN_MARKER } from './prompts/system-prompt';
import { AssistantService } from './assistant.service';
import { GROUNDING_FALLBACK_MESSAGE } from './prompts/system-prompt';
import { LlmCompletion } from '../core/llm/llm.types';
import { ChatEvent } from './streaming/ndjson';

/**
 * The agent loop is driven by a scripted fake provider rather than a real model,
 * so grounding, retry, and suppression are exercised with no network and no key.
 */
function completion(partial: Partial<LlmCompletion>): LlmCompletion {
  return {
    content: null,
    toolCalls: [],
    finishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    model: 'test/model',
    ...partial,
  };
}

const user: JwtPayload = {
  sub: 'user-1',
  email: 'director@example.com',
  campaignId: 'campaign-1',
  role: CampaignRole.CAMPAIGN_DIRECTOR,
  scopeType: ScopeType.CAMPAIGN,
};

describe('AssistantService', () => {
  let prisma: any;
  let llm: any;
  let browse: any;
  let metrics: any;
  let readonlyDb: any;
  let evidence: any;
  let triage: any;
  let service: AssistantService;
  let events: ChatEvent[];

  const emit = (event: ChatEvent) => {
    events.push(event);
  };

  beforeEach(() => {
    events = [];
    prisma = {
      campaignMembership: {
        findFirst: jest.fn().mockResolvedValue({ id: 'membership-1' }),
      },
      campaign: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          name: 'Test Campaign',
          clientPartyCode: 'APC',
          state: { name: 'Jigawa' },
        }),
      },
      activityLog: { create: jest.fn().mockResolvedValue({}) },
    };
    llm = {
      isConfigured: jest.fn().mockReturnValue(true),
      getModelId: jest.fn().mockReturnValue('test/model'),
      complete: jest.fn(),
    };
    browse = { getRaceAnalytics: jest.fn(), getIncidentHotspots: jest.fn() };
    metrics = {
      recordAiRequest: jest.fn(),
      recordAiToolCall: jest.fn(),
      recordAiGrounding: jest.fn(),
      recordAiTokens: jest.fn(),
    };
    readonlyDb = {
      isConfigured: jest.fn().mockReturnValue(true),
      runSandboxedQuery: jest.fn(),
    };
    evidence = { findPhotos: jest.fn().mockResolvedValue([]) };
    triage = { overview: jest.fn() };
    const agents = {};
    const social = {};
    const threads = {
      resolveThreadForChat: jest.fn(async (_user, threadId, seedHistory) => ({
        threadId: threadId ?? 'thread-1',
        history: threadId ? [] : (seedHistory ?? []),
      })),
      appendUserMessage: jest.fn().mockResolvedValue({ id: 'user-msg-1' }),
      appendAssistantMessage: jest.fn().mockResolvedValue({ id: 'assistant-msg-1' }),
    };

    service = new AssistantService(
      prisma,
      llm,
      browse,
      metrics,
      readonlyDb,
      evidence,
      triage,
      agents as any,
      social as any,
      threads as any,
    );
  });

  it('refuses when no model is configured', async () => {
    llm.isConfigured.mockReturnValue(false);
    await expect(
      service.chat(user, { message: 'hi' }, emit),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(metrics.recordAiRequest).toHaveBeenCalledWith('not_configured', 0);
  });

  it('refuses when the read-only database is not configured', async () => {
    readonlyDb.isConfigured.mockReturnValue(false);
    await expect(
      service.chat(user, { message: 'hi' }, emit),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('refuses a caller who is not a member of the campaign', async () => {
    prisma.campaignMembership.findFirst.mockResolvedValue(null);
    await expect(
      service.chat(user, { message: 'hi' }, emit),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('answers with figures traced to a tool result', async () => {
    readonlyDb.runSandboxedQuery.mockResolvedValue([{ votes: 12345 }]);
    llm.complete
      .mockResolvedValueOnce(
        completion({
          toolCalls: [
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: 'run_sql',
                arguments: '{"sql":"SELECT id FROM lgas"}',
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        completion({ content: 'APC polled 12,345 votes.' }),
      );

    const result = await service.chat(
      user,
      { message: 'How many votes?' },
      emit,
    );

    expect(result.grounded).toBe(true);
    expect(result.suppressed).toBe(false);
    expect(result.reply).toBe('APC polled 12,345 votes.');
    expect(result.toolCalls).toEqual([{ tool: 'run_sql', ok: true }]);
    expect(result.threadId).toBe('thread-1');
    expect(result.userMessageId).toBe('user-msg-1');
    expect(result.assistantMessageId).toBe('assistant-msg-1');
    expect(events.some((event) => event.type === 'status')).toBe(true);
    expect(metrics.recordAiGrounding).toHaveBeenCalledWith('grounded');
  });

  it('retries once with a forced tool call when the first answer is ungrounded', async () => {
    readonlyDb.runSandboxedQuery.mockResolvedValue([{ votes: 500 }]);
    llm.complete
      // Invents a figure without querying.
      .mockResolvedValueOnce(
        completion({ content: 'Turnout was 98,000 voters.' }),
      )
      .mockResolvedValueOnce(
        completion({
          toolCalls: [
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: 'run_sql',
                arguments: '{"sql":"SELECT id FROM lgas"}',
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        completion({ content: 'Turnout was 500 voters.' }),
      );

    const result = await service.chat(user, { message: 'Turnout?' }, emit);

    expect(metrics.recordAiGrounding).toHaveBeenCalledWith('retried');
    expect(result.grounded).toBe(true);
    expect(result.reply).toBe('Turnout was 500 voters.');
    // The corrective attempt must force a tool call on its first step.
    expect(llm.complete.mock.calls[1][1].toolChoice).toBe('required');
  });

  it('suppresses and audits an answer that stays ungrounded', async () => {
    llm.complete
      .mockResolvedValueOnce(
        completion({ content: 'Turnout was 98,000 voters.' }),
      )
      .mockResolvedValueOnce(completion({ content: 'Still 98,000 voters.' }));

    const result = await service.chat(user, { message: 'Turnout?' }, emit);

    expect(result.suppressed).toBe(true);
    expect(result.grounded).toBe(false);
    expect(result.reply).toBe(GROUNDING_FALLBACK_MESSAGE);
    expect(metrics.recordAiGrounding).toHaveBeenCalledWith('suppressed');

    // The suppression itself has to stay visible after the fact.
    expect(prisma.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'ai.response_suppressed' }),
      }),
    );
  });

  it('hands a rejected query back to the model instead of failing the request', async () => {
    llm.complete
      .mockResolvedValueOnce(
        completion({
          toolCalls: [
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: 'run_sql',
                arguments: '{"sql":"SELECT * FROM users"}',
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        completion({ content: 'I could not read that table.' }),
      );

    const result = await service.chat(user, { message: 'Show me users' }, emit);

    expect(result.toolCalls).toEqual([{ tool: 'run_sql', ok: false }]);
    expect(result.reply).toBe('I could not read that table.');
    expect(readonlyDb.runSandboxedQuery).not.toHaveBeenCalled();
  });

  it('survives malformed tool arguments', async () => {
    llm.complete
      .mockResolvedValueOnce(
        completion({
          toolCalls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'run_sql', arguments: '{not json' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(completion({ content: 'Sorry, I hit an error.' }));

    const result = await service.chat(user, { message: 'x' }, emit);
    expect(result.toolCalls).toEqual([{ tool: 'run_sql', ok: false }]);
  });

  it('sends at most the last 20 history turns', async () => {
    llm.complete.mockResolvedValue(completion({ content: 'Done.' }));
    const history = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `turn ${index}`,
    }));

    await service.chat(user, { message: 'latest', history }, emit);

    const sent = llm.complete.mock.calls[0][1].messages;
    // system + 20 history + the new message + the spoken reminder
    expect(sent).toHaveLength(23);
    expect(sent[0].role).toBe('system');
    expect(sent[sent.length - 2].content).toBe('latest');
    expect(sent[1].content).toBe('turn 10');
  });

  it('restates the spoken-format rule after every question', async () => {
    llm.complete.mockResolvedValue(completion({ content: 'Done.' }));

    await service.chat(user, { message: 'anything' }, emit);

    // Adherence decays with conversation length: the marker was reliably
    // emitted on the first turns and dropped from the third onward, which made
    // read-aloud disappear mid-session. The reminder goes last, after the
    // question, where instruction-following is strongest.
    const sent = llm.complete.mock.calls[0][1].messages;
    const last = sent[sent.length - 1];
    expect(last.role).toBe('system');
    expect(last.content).toContain(SPOKEN_MARKER);
  });

  it('splits the spoken summary out of the reply', async () => {
    llm.complete.mockResolvedValueOnce(
      completion({
        content: `APC leads in 23 states.
===SPOKEN===
We are ahead in 23 states, but it is early.`,
      }),
    );

    const result = await service.chat(
      user,
      { message: 'How are we doing?' },
      emit,
    );

    expect(result.reply).toBe('APC leads in 23 states.');
    expect(result.spoken).toBe('We are ahead in 23 states, but it is early.');
  });

  it('leaves spoken null when the model omits the marker', async () => {
    llm.complete.mockResolvedValueOnce(
      completion({ content: 'Nothing to report.' }),
    );

    const result = await service.chat(user, { message: 'x' }, emit);

    expect(result.reply).toBe('Nothing to report.');
    expect(result.spoken).toBeNull();
  });

  it('grounds the spoken summary too', async () => {
    // The figure appears only in the spoken half - it must still be caught.
    llm.complete
      .mockResolvedValueOnce(
        completion({
          content: `Turnout is early.
===SPOKEN===
About 98,000 people voted.`,
        }),
      )
      .mockResolvedValueOnce(
        completion({
          content: `Turnout is early.
===SPOKEN===
Still about 98,000.`,
        }),
      );

    const result = await service.chat(user, { message: 'Turnout?' }, emit);

    expect(result.suppressed).toBe(true);
    expect(result.spoken).toBeNull();
  });

  it('drops attachments and charts when the answer is suppressed', async () => {
    llm.complete
      .mockResolvedValueOnce(
        completion({ content: 'Turnout was 98,000 voters.' }),
      )
      .mockResolvedValueOnce(completion({ content: 'Still 98,000 voters.' }));

    const result = await service.chat(user, { message: 'Turnout?' }, emit);

    expect(result.suppressed).toBe(true);
    expect(result.attachments).toEqual([]);
    expect(result.charts).toEqual([]);
  });
});
