import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: Redis | null = null;

  async onModuleInit() {
    const url = process.env.REDIS_URL;
    if (!url) return;

    this.client = new Redis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      lazyConnect: true,
    });

    try {
      await this.client.connect();
    } catch {
      this.client = null;
    }
  }

  async onModuleDestroy() {
    await this.client?.quit();
  }

  /**
   * Best-effort distributed lock. Returns false when the lock is already held —
   * and also when Redis is absent, so callers must decide whether "no Redis"
   * means "run anyway" (single instance) or "skip".
   */
  async acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
    if (!this.client) return false;
    try {
      const result = await this.client.set(key, '1', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch {
      return false;
    }
  }

  /** True when a Redis connection is live, so callers can tell it apart from a held lock. */
  isConnected(): boolean {
    return this.client != null;
  }

  async ping(): Promise<boolean> {
    if (!this.client) return false;

    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  /** Best-effort JSON read. Returns null when Redis is down or the key is missing. */
  async getJson<T>(key: string): Promise<T | null> {
    if (!this.client) return null;
    try {
      const raw = await this.client.get(key);
      if (raw == null) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /** Best-effort JSON write with TTL. No-ops when Redis is down. */
  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.client || ttlSeconds <= 0) return;
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {
      // Cache must never break the request path.
    }
  }

  /** Best-effort delete of one or more exact keys. */
  async del(...keys: string[]): Promise<void> {
    if (!this.client || keys.length === 0) return;
    try {
      await this.client.del(...keys);
    } catch {
      // ignore
    }
  }

  /** Best-effort delete of all keys matching a glob pattern (e.g. `sr:v1:map:abc:*`). */
  async delByPattern(pattern: string): Promise<void> {
    if (!this.client) return;
    try {
      let cursor = '0';
      do {
        const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = next;
        if (keys.length > 0) await this.client.del(...keys);
      } while (cursor !== '0');
    } catch {
      // ignore
    }
  }
}
