import { Injectable } from '@nestjs/common';

@Injectable()
export class IrevRateLimiter {
  private readonly timestamps: number[] = [];
  private readonly maxPerMinute: number;

  constructor() {
    const configured = Number.parseInt(process.env.IREV_FETCH_RATE_LIMIT ?? '30', 10);
    this.maxPerMinute = Number.isFinite(configured) && configured > 0 ? configured : 30;
  }

  async acquire(): Promise<boolean> {
    const now = Date.now();
    const windowStart = now - 60_000;
    while (this.timestamps.length > 0 && this.timestamps[0]! < windowStart) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.maxPerMinute) {
      return false;
    }
    this.timestamps.push(now);
    return true;
  }

  async waitForSlot(maxWaitMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      if (await this.acquire()) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }
}
