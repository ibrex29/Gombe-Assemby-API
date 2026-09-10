import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry = new Registry();

  private readonly httpRequestsTotal: Counter<string>;
  private readonly httpRequestDuration: Histogram<string>;
  readonly activeSessions: Gauge<string>;
  readonly dbPoolTotal: Gauge<string>;
  readonly dbPoolWaiting: Gauge<string>;
  readonly dependencyUp: Gauge<string>;
  private readonly notificationPushTotal: Counter<string>;
  private readonly aiRequestsTotal: Counter<string>;
  private readonly aiRequestDuration: Histogram<string>;
  private readonly aiToolCallsTotal: Counter<string>;
  private readonly aiGroundingTotal: Counter<string>;
  private readonly aiTokensTotal: Counter<string>;
  private readonly irevFetchTotal: Counter<string>;
  private readonly irevOcrFailuresTotal: Counter<string>;
  private readonly irevVerificationTotal: Counter<string>;

  constructor(private prisma: PrismaService) {
    collectDefaultMetrics({ register: this.registry });

    this.httpRequestsTotal = new Counter({
      name: 'electromon_http_requests_total',
      help: 'Total HTTP requests',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });

    this.httpRequestDuration = new Histogram({
      name: 'electromon_http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers: [this.registry],
    });

    this.activeSessions = new Gauge({
      name: 'electromon_active_sessions',
      help: 'Active refresh token sessions',
      registers: [this.registry],
    });

    this.dbPoolTotal = new Gauge({
      name: 'electromon_db_pool_total',
      help: 'Total database pool connections',
      registers: [this.registry],
    });

    this.dbPoolWaiting = new Gauge({
      name: 'electromon_db_pool_waiting',
      help: 'Requests waiting for a database connection',
      registers: [this.registry],
    });

    this.dependencyUp = new Gauge({
      name: 'electromon_dependency_up',
      help: 'Dependency health (1=up, 0=down)',
      labelNames: ['dependency'],
      registers: [this.registry],
    });

    this.notificationPushTotal = new Counter({
      name: 'electromon_notification_push_total',
      help: 'Push notification delivery attempts',
      labelNames: ['result'],
      registers: [this.registry],
    });

    this.aiRequestsTotal = new Counter({
      name: 'electromon_ai_requests_total',
      help: 'AI assistant turns by outcome',
      labelNames: ['outcome'],
      registers: [this.registry],
    });

    this.aiRequestDuration = new Histogram({
      name: 'electromon_ai_request_duration_seconds',
      help: 'AI assistant turn duration in seconds',
      buckets: [0.5, 1, 2, 5, 10, 20, 45, 90],
      registers: [this.registry],
    });

    this.aiToolCallsTotal = new Counter({
      name: 'electromon_ai_tool_calls_total',
      help: 'AI assistant tool executions',
      labelNames: ['tool', 'status'],
      registers: [this.registry],
    });

    // Watch the suppressed series after launch: a rising rate means the model
    // is asserting figures it did not query.
    this.aiGroundingTotal = new Counter({
      name: 'electromon_ai_grounding_total',
      help: 'AI assistant grounding verdicts',
      labelNames: ['result'],
      registers: [this.registry],
    });

    this.aiTokensTotal = new Counter({
      name: 'electromon_ai_tokens_total',
      help: 'AI assistant token usage',
      labelNames: ['type'],
      registers: [this.registry],
    });

    this.irevFetchTotal = new Counter({
      name: 'electromon_irev_fetch_total',
      help: 'IReV fetch attempts by outcome',
      labelNames: ['result'],
      registers: [this.registry],
    });

    this.irevOcrFailuresTotal = new Counter({
      name: 'electromon_irev_ocr_failures_total',
      help: 'IReV scan OCR failures',
      registers: [this.registry],
    });

    this.irevVerificationTotal = new Counter({
      name: 'electromon_irev_verification_total',
      help: 'IReV verification outcomes',
      labelNames: ['status'],
      registers: [this.registry],
    });
  }

  onModuleInit() {
    setInterval(() => void this.refreshInternalMetrics(), 15_000);
  }

  recordHttpRequest(
    method: string,
    route: string,
    status: number,
    durationSeconds: number,
  ) {
    const labels = { method, route, status: String(status) };
    this.httpRequestsTotal.inc(labels);
    this.httpRequestDuration.observe(labels, durationSeconds);
  }

  setDependencyStatus(dependency: string, up: boolean) {
    this.dependencyUp.set({ dependency }, up ? 1 : 0);
  }

  recordNotificationPush(
    result: 'sent' | 'failed' | 'invalid_token' | 'skipped' | 'dry_run',
    count = 1,
  ) {
    this.notificationPushTotal.inc({ result }, count);
  }

  recordAiRequest(
    outcome: 'answered' | 'suppressed' | 'error' | 'not_configured',
    durationSeconds: number,
  ) {
    this.aiRequestsTotal.inc({ outcome });
    if (durationSeconds > 0) this.aiRequestDuration.observe(durationSeconds);
  }

  recordAiToolCall(tool: string, ok: boolean) {
    this.aiToolCallsTotal.inc({ tool, status: ok ? 'ok' : 'error' });
  }

  recordAiGrounding(result: 'grounded' | 'retried' | 'suppressed') {
    this.aiGroundingTotal.inc({ result });
  }

  recordAiTokens(inputTokens: number, outputTokens: number) {
    if (inputTokens > 0) this.aiTokensTotal.inc({ type: 'input' }, inputTokens);
    if (outputTokens > 0) this.aiTokensTotal.inc({ type: 'output' }, outputTokens);
  }

  recordIrevFetch(result: 'success' | 'missing' | 'error' | 'rate_limited') {
    this.irevFetchTotal.inc({ result });
  }

  recordIrevOcrFailure() {
    this.irevOcrFailuresTotal.inc();
  }

  recordIrevVerification(
    status: 'MATCH' | 'MISMATCH' | 'IREV_MISSING' | 'PENDING' | 'UNREADABLE' | 'REPLACED',
  ) {
    this.irevVerificationTotal.inc({ status });
  }

  async metrics(): Promise<string> {
    await this.refreshInternalMetrics();
    return this.registry.metrics();
  }

  private async refreshInternalMetrics() {
    try {
      const sessions = await this.prisma.refreshToken.count({
        where: { expiresAt: { gt: new Date() } },
      });
      this.activeSessions.set(sessions);
    } catch {
      this.activeSessions.set(0);
    }

    const pool = this.prisma.getPoolStats();
    this.dbPoolTotal.set(pool.total);
    this.dbPoolWaiting.set(pool.waiting);
  }
}
