import { subscribe, CommitmentLevel, LaserstreamConfig, SubscribeRequest, StreamHandle } from 'helius-laserstream';
import { TokenPosition } from './types.js';

export interface LaserStreamConfig {
  apiKey: string;
  endpoint: string;
  onTransaction?: (signature: string, filterName: string, tokenMint: string) => void;
  onError?: (error: Error) => void;
  onConnect?: () => void;
}

export interface LaserStreamSubscription {
  accounts: string[];
  position: TokenPosition;
}

/**
 * LaserStream gRPC client for fast rug detection.
 * Uses the official helius-laserstream npm package.
 */
export class LaserStreamClient {
  private config: LaserStreamConfig;
  private subscriptions: Map<string, LaserStreamSubscription> = new Map(); // tokenMint -> subscription
  private monitoredAccounts: Map<string, string> = new Map(); // account -> tokenMint
  private isRunning = false;
  private streamHandle: StreamHandle | null = null;

  constructor(config: LaserStreamConfig) {
    this.config = config;
  }

  /**
   * Add accounts to monitor for a token position.
   * Both fastDetectionAccount and devTokenAccount will be monitored.
   */
  addPosition(
    fastDetectionAccount: string,
    devTokenAccount: string,
    position: TokenPosition
  ): void {
    const accounts = [fastDetectionAccount, devTokenAccount];
    
    this.subscriptions.set(position.tokenMint, {
      accounts,
      position,
    });

    // Map each account to the token mint for quick lookup
    for (const account of accounts) {
      this.monitoredAccounts.set(account, position.tokenMint);
    }

    console.log(
      `[LaserStream] Added position ${position.tokenMint.slice(0, 8)}... ` +
      `accounts: ${fastDetectionAccount.slice(0, 8)}..., ${devTokenAccount.slice(0, 8)}...`
    );

    // If already running, restart with new subscription
    if (this.isRunning) {
      this.restartSubscription();
    }
  }

  /**
   * Remove a position from monitoring.
   */
  removePosition(tokenMint: string): void {
    const sub = this.subscriptions.get(tokenMint);
    if (sub) {
      for (const account of sub.accounts) {
        this.monitoredAccounts.delete(account);
      }
      this.subscriptions.delete(tokenMint);
      
      if (this.isRunning && this.subscriptions.size > 0) {
        this.restartSubscription();
      }
    }
  }

  /**
   * Connect to LaserStream and start monitoring.
   */
  async connect(): Promise<void> {
    console.log(`[LaserStream] Connected to ${this.config.endpoint}`);
    this.config.onConnect?.();
  }

  /**
   * Start the subscription stream.
   */
  async start(): Promise<void> {
    if (this.monitoredAccounts.size === 0) {
      console.log('[LaserStream] No accounts to monitor yet - will subscribe when positions added');
      this.isRunning = true;
      return;
    }

    this.isRunning = true;
    await this.startSubscription();
  }

  /**
   * Start or restart the gRPC subscription with current accounts.
   */
  private async startSubscription(): Promise<void> {
    if (this.subscriptions.size === 0) {
      console.log('[LaserStream] No subscriptions to monitor');
      return;
    }

    const accounts = Array.from(this.monitoredAccounts.keys());
    console.log(`[LaserStream] Starting subscription for ${accounts.length} accounts`);

    // Build transactions filter with each token mint as a separate filter name
    const transactionsFilter: Record<string, any> = {};
    for (const [tokenMint, sub] of this.subscriptions) {
      transactionsFilter[tokenMint] = {
        vote: false,
        failed: false,
        accountInclude: sub.accounts,
        accountExclude: [],
        accountRequired: [],
      };
    }

    const subscriptionRequest: SubscribeRequest = {
      transactions: transactionsFilter,
      commitment: CommitmentLevel.PROCESSED,
      accounts: {},
      slots: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
    };

    const laserstreamConfig: LaserstreamConfig = {
      apiKey: this.config.apiKey,
      endpoint: this.config.endpoint,
    };

    try {
      this.streamHandle = await subscribe(
        laserstreamConfig,
        subscriptionRequest,
        (data: any) => this.handleUpdate(data),
        (error: Error) => {
          console.error('[LaserStream] Stream error:', error.message);
          this.config.onError?.(error);
        }
      );

      console.log(`[LaserStream] Updated subscription for ${this.subscriptions.size} positions (${accounts.length} accounts)`);
    } catch (error) {
      console.error('[LaserStream] Failed to start subscription:', error);
      this.config.onError?.(error as Error);
    }
  }

  /**
   * Restart subscription with current accounts.
   */
  private restartSubscription(): void {
    // Cancel current stream
    if (this.streamHandle) {
      this.streamHandle.cancel();
      this.streamHandle = null;
    }

    // Small delay to allow cleanup, then restart
    setTimeout(() => {
      if (this.isRunning && this.subscriptions.size > 0) {
        this.startSubscription().catch(err => {
          console.error('[LaserStream] Failed to restart subscription:', err);
        });
      }
    }, 100);
  }

  /**
   * Handle incoming update from stream.
   */
  private handleUpdate(data: any): void {
    try {
      // Check if this is a transaction update - trigger sell immediately
      if (data.transaction) {
        const tx = data.transaction;
        const signature = tx.signature || 'unknown';
        const slot = tx.slot || 0;

        // Get the filter that matched (tells us which position)
        const filters = data.filters || [];

        console.log(
          `[LaserStream] ⚡ TX DETECTED - slot: ${slot} sig: ${signature.slice(0, 12)}... filters: ${filters.join(',')}`
        );

        // Find the position that matched and trigger sell
        for (const filterName of filters) {
          const subscription = this.subscriptions.get(filterName);
          if (subscription) {
            const tokenMint = subscription.position.tokenMint;
            console.log(
              `[LaserStream] ⚡ RUG DETECTED - token: ${tokenMint.slice(0, 12)}... - TRIGGERING SELL`
            );
            
            // Trigger the callback with the specific token mint
            this.config.onTransaction?.(signature, filterName, tokenMint);
            
            // Remove this position from monitoring after detection
            this.removePosition(tokenMint);
            return; // Only handle one match
          }
        }
      }
    } catch (err) {
      console.error('[LaserStream] Failed to handle update:', err);
    }
  }

  /**
   * Disconnect from LaserStream.
   */
  disconnect(): void {
    if (this.streamHandle) {
      this.streamHandle.cancel();
      this.streamHandle = null;
    }
    this.isRunning = false;
    console.log('[LaserStream] Disconnected');
  }

  /**
   * Get number of monitored positions.
   */
  getPositionCount(): number {
    return this.subscriptions.size;
  }
}
