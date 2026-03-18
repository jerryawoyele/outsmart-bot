import { LiquidityRemovalEvent } from './types.js';

export interface LiquidityDetectorConfig {
  onLiquidityRemoval: (event: LiquidityRemovalEvent) => void;
}

/**
 * Hot-path liquidity detector.
 *
 * The WebSocket subscription already guarantees relevance by subscribing
 * to specific dev token accounts. Any tx mentioning that account = rug event.
 *
 * No extra RPC calls, no tx parsing, no cross-checking on the hot path.
 */
export class LiquidityDetector {
  private onRemoval: (event: LiquidityRemovalEvent) => void;
  private seenSignatures = new Set<string>();
  private readonly maxCacheSize = 1000;

  constructor(config: LiquidityDetectorConfig) {
    this.onRemoval = config.onLiquidityRemoval;
  }

  /**
   * Process a log notification from Helius WebSocket.
   * This is the hot path - must be as fast as possible.
   *
   * @param signature - Transaction signature
   * @param err - Transaction error (null if success)
   * @param tokenMint - Token mint address (from subscription context)
   * @param poolAddress - Pool address (if known)
   * @param devAddress - Dev address (from subscription context)
   */
  processLogNotification(
    signature: string,
    err: unknown,
    tokenMint: string,
    poolAddress?: string,
    devAddress?: string
  ): LiquidityRemovalEvent | null {
    // Skip failed transactions
    if (err) {
      return null;
    }

    // Deduplicate - skip if we've already processed this signature
    if (this.seenSignatures.has(signature)) {
      return null;
    }
    this.seenSignatures.add(signature);

    // Cleanup old signatures to prevent memory leak
    if (this.seenSignatures.size > this.maxCacheSize) {
      const toDelete = Array.from(this.seenSignatures).slice(0, 500);
      for (const sig of toDelete) {
        this.seenSignatures.delete(sig);
      }
    }

    // Build event directly - no RPC calls, no parsing
    const event: LiquidityRemovalEvent = {
      devAddress: devAddress || 'UNKNOWN',
      tokenMint,
      poolAddress: poolAddress || 'UNKNOWN',
      amountRemoved: 0n,
      timestamp: Date.now(),
      txSignature: signature,
    };

    this.onRemoval(event);
    return event;
  }

  /**
   * Clear the signature cache (for testing or manual reset)
   */
  clearCache(): void {
    this.seenSignatures.clear();
  }
}
