import { subscribe, CommitmentLevel, LaserstreamConfig, SubscribeRequest, StreamHandle } from 'helius-laserstream';
import { AccountLayout } from '@solana/spl-token';
import bs58 from 'bs58';

export interface LaserStreamConfig {
  apiKey: string;
  endpoint: string;
  onRugDetected?: (tokenMint: string, removedRaw: bigint, removedPct: number) => void;
  onError?: (error: Error) => void;
  onConnect?: () => void;
}

/**
 * Pool tracker for monitoring WSOL vault balance
 */
export interface PoolTracker {
  tokenMint: string;
  wsolVault: string;
  initialWsolRaw: bigint;
  highestSeenWsolRaw: bigint;
  rugged: boolean;
}

/**
 * LaserStream gRPC client for fast rug detection.
 * Uses account subscriptions to monitor WSOL vault balances directly.
 * Triggers sell when vault balance drops significantly (rug detection).
 */
export class LaserStreamClient {
  private config: LaserStreamConfig;
  private trackers: Map<string, PoolTracker> = new Map(); // wsolVault -> tracker
  private tokenToVault: Map<string, string> = new Map(); // tokenMint -> wsolVault
  private isRunning = false;
  private streamHandle: StreamHandle | null = null;

  constructor(config: LaserStreamConfig) {
    this.config = config;
  }

  /**
   * Add a position to monitor by its WSOL vault.
   * This is the key method - we monitor the WSOL vault balance directly.
   */
  addPosition(
    tokenMint: string,
    wsolVault: string,
    initialWsolRaw: bigint
  ): void {
    const tracker: PoolTracker = {
      tokenMint,
      wsolVault,
      initialWsolRaw,
      highestSeenWsolRaw: initialWsolRaw,
      rugged: false,
    };

    this.trackers.set(wsolVault, tracker);
    this.tokenToVault.set(tokenMint, wsolVault);

    console.log(
      `[LaserStream] Added vault watch for ${tokenMint.slice(0, 8)}... ` +
      `vault: ${wsolVault.slice(0, 8)}... initial: ${initialWsolRaw} lamports`
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
    const wsolVault = this.tokenToVault.get(tokenMint);
    if (wsolVault) {
      this.trackers.delete(wsolVault);
      this.tokenToVault.delete(tokenMint);
      
      if (this.isRunning && this.trackers.size > 0) {
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
    if (this.trackers.size === 0) {
      console.log('[LaserStream] No vaults to monitor yet - will subscribe when positions added');
      this.isRunning = true;
      return;
    }

    this.isRunning = true;
    await this.startSubscription();
  }

  /**
   * Start or restart the gRPC subscription with current vaults.
   */
  private async startSubscription(): Promise<void> {
    if (this.trackers.size === 0) {
      console.log('[LaserStream] No vaults to monitor');
      return;
    }

    const vaults = Array.from(this.trackers.keys());
    console.log(`[LaserStream] Starting account subscription for ${vaults.length} WSOL vaults`);

    // Build accounts filter for WSOL vault monitoring
    const accountsFilter: Record<string, any> = {
      rugVaultWatch: {
        account: vaults,
        owner: [],
        filters: [{ tokenAccountState: true }],
      },
    };

    const subscriptionRequest: SubscribeRequest = {
      accounts: accountsFilter,
      commitment: CommitmentLevel.PROCESSED,
      transactions: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      slots: {},
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
        (data: any) => this.handleAccountUpdate(data),
        (error: Error) => {
          console.error('[LaserStream] Stream error:', error.message);
          this.config.onError?.(error);
        }
      );

      console.log(`[LaserStream] Monitoring ${this.trackers.size} WSOL vaults for rug detection`);
    } catch (error) {
      console.error('[LaserStream] Failed to start subscription:', error);
      this.config.onError?.(error as Error);
    }
  }

  /**
   * Restart subscription with current vaults.
   */
  private restartSubscription(): void {
    // Cancel current stream
    if (this.streamHandle) {
      this.streamHandle.cancel();
      this.streamHandle = null;
    }

    // Small delay to allow cleanup, then restart
    setTimeout(() => {
      if (this.isRunning && this.trackers.size > 0) {
        this.startSubscription().catch(err => {
          console.error('[LaserStream] Failed to restart subscription:', err);
        });
      }
    }, 100);
  }

  /**
   * Handle incoming account update from stream.
   * This is where we detect rugs by monitoring WSOL vault balance changes.
   */
  private handleAccountUpdate(data: any): void {
    try {
      // Check if this is an account update
      if (!data.account) return;

      const accountUpdate = data.account;
      const accountInfo = accountUpdate.account;
      if (!accountInfo) return;

      // Get the pubkey (vault address)
      const pubkey = this.extractPubkey(accountInfo.pubkey);
      if (!pubkey) return;

      const tracker = this.trackers.get(pubkey);
      if (!tracker || tracker.rugged) return;

      // Decode the account data to get WSOL balance
      const rawData = this.extractData(accountInfo.data);
      if (!rawData) return;

      const currentRaw = this.decodeSplAmount(rawData);

      // Update highest seen if balance increased
      if (currentRaw > tracker.highestSeenWsolRaw) {
        tracker.highestSeenWsolRaw = currentRaw;
      }

      // Check for rug
      const { trigger, removedRaw, removedPct } = this.shouldRug(currentRaw, tracker);

      console.log(
        `[VaultWatch] ${tracker.tokenMint.slice(0, 8)}... current=${currentRaw} ` +
        `removed=${removedRaw} (${removedPct.toFixed(1)}%)`
      );

      if (!trigger) return;

      // Mark as rugged to prevent duplicate triggers
      tracker.rugged = true;
      console.log(
        `[LaserStream] ⚡ RUG DETECTED - token: ${tracker.tokenMint.slice(0, 12)}... ` +
        `removed=${removedRaw} lamports (${removedPct.toFixed(1)}%)`
      );

      // Trigger the callback
      this.config.onRugDetected?.(tracker.tokenMint, removedRaw, removedPct);

      // Remove from monitoring
      this.removePosition(tracker.tokenMint);
    } catch (err) {
      console.error('[LaserStream] Failed to handle account update:', err);
    }
  }

  /**
   * Extract pubkey from various formats.
   * Returns base58-encoded string for Solana addresses.
   */
  private extractPubkey(pubkey: any): string | null {
    if (typeof pubkey === 'string') {
      return pubkey;
    }
    if (pubkey instanceof Uint8Array || Buffer.isBuffer(pubkey)) {
      return bs58.encode(Buffer.from(pubkey));
    }
    return null;
  }

  /**
   * Extract account data from various formats.
   */
  private extractData(data: any): Uint8Array | null {
    if (data instanceof Uint8Array) {
      return data;
    }
    if (Buffer.isBuffer(data)) {
      return data;
    }
    if (typeof data === 'string') {
      // Base64 encoded
      return Buffer.from(data, 'base64');
    }
    return null;
  }

  /**
   * Decode SPL token account amount from raw data.
   */
  private decodeSplAmount(data: Uint8Array | Buffer): bigint {
    const buf = Buffer.from(data);
    try {
      const decoded = AccountLayout.decode(buf);
      return decoded.amount;
    } catch {
      // Fallback: amount is at offset 64 for token accounts
      return buf.readBigUInt64LE(64);
    }
  }

  /**
   * Determine if a rug has occurred based on balance drop.
   * Triggers when current balance drops below the initial SOL deposited by the dev.
   * This is a clear rug signal - the dev removed their initial liquidity.
   */
  private shouldRug(currentRaw: bigint, tracker: PoolTracker): {
    trigger: boolean;
    removedRaw: bigint;
    removedPct: number;
  } {
    const baseline = tracker.initialWsolRaw;

    if (baseline <= 0n) {
      return { trigger: false, removedRaw: 0n, removedPct: 0 };
    }

    // If current balance is at or above initial, no rug
    if (currentRaw >= baseline) {
      return { trigger: false, removedRaw: 0n, removedPct: 0 };
    }

    // Balance dropped below initial SOL - RUG DETECTED
    const removedRaw = baseline - currentRaw;
    const removedPct = Number((removedRaw * 10_000n) / baseline) / 100;

    return {
      trigger: true, // Always trigger when below initial
      removedRaw,
      removedPct,
    };
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
   * Get number of monitored vaults.
   */
  getPositionCount(): number {
    return this.trackers.size;
  }
}
