/**
 * Centralized rate limiter for all RPC calls.
 * Ensures we stay under Helius free tier limit of 10 RPS.
 */

class RpcRateLimiter {
  private static instance: RpcRateLimiter;
  private nextRequestAt = 0;
  private queue: Array<() => void> = [];
  private isProcessing = false;

  // 120ms interval = ~8.3 RPS max (staying under 10 RPS limit with safety margin)
  private readonly minIntervalMs: number;

  private constructor(maxRps: number = 8) {
    this.minIntervalMs = 1000 / maxRps;
  }

  static getInstance(maxRps?: number): RpcRateLimiter {
    if (!RpcRateLimiter.instance) {
      RpcRateLimiter.instance = new RpcRateLimiter(maxRps);
    }
    return RpcRateLimiter.instance;
  }

  /**
   * Wait for a slot before making an RPC call.
   * Call this before every RPC request.
   */
  async waitForSlot(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.isProcessing || this.queue.length === 0) return;

    const now = Date.now();
    const waitMs = Math.max(0, this.nextRequestAt - now);

    if (waitMs > 0) {
      this.isProcessing = true;
      setTimeout(() => {
        this.isProcessing = false;
        this.processQueue();
      }, waitMs);
      return;
    }

    const resolve = this.queue.shift();
    if (resolve) {
      this.nextRequestAt = now + this.minIntervalMs;
      resolve();
      // Process next in queue on next tick
      setImmediate(() => this.processQueue());
    }
  }

  /**
   * Get current stats for monitoring.
   */
  getStats(): { queueLength: number; nextRequestIn: number } {
    return {
      queueLength: this.queue.length,
      nextRequestIn: Math.max(0, this.nextRequestAt - Date.now()),
    };
  }
}

export const rpcRateLimiter = RpcRateLimiter.getInstance(8);
