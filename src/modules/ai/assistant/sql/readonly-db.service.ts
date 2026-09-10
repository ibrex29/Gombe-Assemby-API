import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';
import { SqlValidationError } from './sql-sandbox';

/** Rows larger than this are refused so one query cannot flood the context. */
const MAX_RESULT_CHARS = 30_000;
const STATEMENT_TIMEOUT_MS = 5_000;

/**
 * Executes sandboxed SELECTs as the `electromon_ai_readonly` role.
 *
 * Every query runs inside a read-only transaction that first pins
 * `app.campaign_id`, which is what the RLS policies filter on. Layers, outermost
 * first: sandbox rewrite -> table grants -> role-level read-only -> explicit
 * READ ONLY transaction -> RLS -> statement timeout.
 *
 * This deliberately does not reuse PrismaService: that connects as the owning
 * application role, which bypasses RLS.
 */
@Injectable()
export class ReadonlyDbService implements OnModuleDestroy {
  private readonly logger = new Logger(ReadonlyDbService.name);
  private readonly connectionString: string | null;
  private pool: Pool | null = null;

  constructor(private config: ConfigService) {
    this.connectionString =
      this.config.get<string>('AI_READONLY_DATABASE_URL')?.trim() || null;
    if (!this.connectionString) {
      this.logger.warn(
        'AI_READONLY_DATABASE_URL is not set; the AI assistant cannot query data',
      );
    }
  }

  isConfigured() {
    return this.connectionString != null;
  }

  async onModuleDestroy() {
    await this.pool?.end().catch(() => undefined);
    this.pool = null;
  }

  private getPool(): Pool {
    if (!this.connectionString) {
      throw new SqlValidationError(
        'The AI assistant database connection is not configured.',
      );
    }
    this.pool ??= new Pool({
      connectionString: this.connectionString,
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    return this.pool;
  }

  /**
   * @param safeSql output of sanitizeSql — never raw model text
   * @param campaignId tenant the RLS policies will clamp every row to
   */
  async runSandboxedQuery(
    safeSql: string,
    campaignId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const client: PoolClient = await this.getPool().connect();
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      // set_config() rather than SET LOCAL: only the former takes a bind
      // parameter, so the campaign id is never string-interpolated into SQL.
      await client.query("SELECT set_config('app.campaign_id', $1, true)", [
        campaignId,
      ]);
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        String(STATEMENT_TIMEOUT_MS),
      ]);

      const result = await client.query(safeSql);
      await client.query('COMMIT');

      const rows = result.rows as Array<Record<string, unknown>>;
      if (JSON.stringify(rows).length > MAX_RESULT_CHARS) {
        throw new SqlValidationError(
          'That query returned too much data. Aggregate it (COUNT/SUM/GROUP BY) or add filters, then try again.',
        );
      }
      return rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw this.toModelSafeError(error);
    } finally {
      client.release();
    }
  }

  /**
   * Postgres errors go back to the model so it can fix its SQL, so they are
   * reduced to the message alone — no stack, no connection details.
   */
  private toModelSafeError(error: unknown): Error {
    if (error instanceof SqlValidationError) return error;

    const pgError = error as { code?: string; message?: string };
    if (pgError?.code === '57014') {
      return new SqlValidationError(
        'That query took too long. Narrow it with filters or aggregate it, then try again.',
      );
    }
    if (pgError?.code === '42501') {
      return new SqlValidationError(
        'That table or column is not available to you.',
      );
    }

    this.logger.warn({ err: error }, 'AI read-only query failed');
    const message = pgError?.message?.split('\n')[0] ?? 'query failed';
    return new SqlValidationError(`Query failed: ${message}`);
  }
}
