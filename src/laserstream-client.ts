import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { TokenPosition } from './types.js';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Yellowstone gRPC proto definitions
const PROTO_PATH = path.join(__dirname, '..', 'proto', 'geyser.proto');

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
 * Uses Helius' Yellowstone-based gRPC streaming service.
 */
export class LaserStreamClient {
  private config: LaserStreamConfig;
  private client: grpc.Client | null = null;
  private stream: grpc.ClientDuplexStream<any, any> | null = null;
  private subscriptions: Map<string, LaserStreamSubscription> = new Map(); // tokenMint -> subscription
  private monitoredAccounts: Map<string, string> = new Map(); // account -> tokenMint
  private isRunning = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private pendingRestart = false;

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

    // If stream is active, just write an updated request (don't restart)
    if (this.isRunning && this.stream && typeof this.stream.write === 'function') {
      this.writeSubscriptionRequest();
    } else if (this.isRunning) {
      // No active stream, start one
      this.startSubscription().catch(err => {
        console.error('[LaserStream] Failed to start subscription:', err);
      });
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
      
      if (this.isRunning) {
        this.restartSubscription();
      }
    }
  }

  /**
   * Connect to LaserStream and start monitoring.
   */
  async connect(): Promise<void> {
    try {
      // Create gRPC client - load proto definition
      const packageDefinition = await protoLoader.load(PROTO_PATH, {
        keepCase: false, // Use camelCase for generated client
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      });

      const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
      const Geyser = (protoDescriptor as any).geyser.Geyser;

      // Create client with API key in metadata
      const metadata = new grpc.Metadata();
      metadata.add('x-token', this.config.apiKey);

      this.client = new Geyser(
        this.config.endpoint,
        grpc.credentials.createSsl(),
        { 'grpc.max_receive_message_length': 1024 * 1024 * 16 } // 16MB max message
      );

      console.log(`[LaserStream] Connected to ${this.config.endpoint}`);
      this.reconnectAttempts = 0;
      this.config.onConnect?.();

    } catch (error) {
      console.error('[LaserStream] Connection failed:', error);
      throw error;
    }
  }

  /**
   * Write subscription request to the stream (for updating filters without restart).
   */
  private writeSubscriptionRequest(): void {
    if (!this.stream || typeof this.stream.write !== 'function') {
      return;
    }

    const accounts = Array.from(this.monitoredAccounts.keys());
    const request = {
      accounts: {},
      slots: {},
      transactions: {
        rugWatch: {
          vote: false,
          failed: false,
          accountInclude: accounts,
          accountExclude: [],
          accountRequired: [],
        },
      },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: 0, // PROCESSED
    };

    this.stream.write(request);
    console.log(`[LaserStream] Updated subscription for ${accounts.length} accounts`);
  }

  /**
   * Start the subscription stream.
   */
  async start(): Promise<void> {
    if (!this.client) {
      await this.connect();
    }

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
    if (!this.client) {
      console.error('[LaserStream] No client connection');
      return;
    }

    const accounts = Array.from(this.monitoredAccounts.keys());
    console.log(`[LaserStream] Starting subscription for ${accounts.length} accounts`);

    try {
      const metadata = new grpc.Metadata();
      metadata.add('x-token', this.config.apiKey);

      // Create bidirectional stream
      const stream = (this.client as any).subscribe(metadata);
      this.stream = stream;

      stream.on('data', (data: any) => {
        this.handleUpdate(data);
      });

      stream.on('error', (error: Error) => {
        console.error('[LaserStream] Stream error:', error.message);
        this.config.onError?.(error);
      });

      stream.on('end', () => {
        console.log('[LaserStream] Stream ended');
        if (this.isRunning && !this.pendingRestart) {
          this.attemptReconnect();
        }
      });

      // Send initial subscription request
      this.writeSubscriptionRequest();

    } catch (error) {
      console.error('[LaserStream] Failed to start subscription:', error);
      this.attemptReconnect();
    }
  }

  /**
   * Handle incoming update from stream.
   */
  private handleUpdate(data: any): void {
    try {
      // Check if this is a transaction update - trigger sell immediately
      // Structure: { transaction: { transaction: { signature: Buffer, ... }, slot: number }, filters: string[] }
      if (data.transaction) {
        const txWrapper = data.transaction;
        const txInfo = txWrapper.transaction;
        
        if (!txInfo) return;

        // Skip vote transactions
        if (txInfo.isVote) return;

        // Signature is a Buffer, convert to base58
        const signature = txInfo.signature ? this.bufferToBase58(txInfo.signature) : 'unknown';
        const slot = txWrapper.slot || 0;

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
   * Convert Buffer to base58 string.
   */
  private bufferToBase58(buf: Buffer | Uint8Array): string {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    
    let num = BigInt('0x' + bytes.toString('hex'));
    let result = '';
    
    while (num > 0n) {
      const remainder = Number(num % 58n);
      result = ALPHABET[remainder] + result;
      num = num / 58n;
    }
    
    // Add leading zeros
    for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
      result = '1' + result;
    }
    
    return result;
  }

  /**
   * Restart subscription with current accounts.
   */
  private restartSubscription(): void {
    if (this.pendingRestart) return; // Already pending restart
    this.pendingRestart = true;

    // Cancel current stream
    if (this.stream) {
      this.stream.cancel();
      this.stream = null;
    }

    // Small delay to allow cleanup, then restart
    setTimeout(() => {
      this.pendingRestart = false;
      if (this.isRunning && this.monitoredAccounts.size > 0) {
        this.startSubscription().catch(err => {
          console.error('[LaserStream] Failed to restart subscription:', err);
        });
      }
    }, 100);
  }

  /**
   * Attempt to reconnect with exponential backoff.
   */
  private async attemptReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[LaserStream] Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    console.log(`[LaserStream] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      await this.start();
    } catch (err) {
      console.error('[LaserStream] Reconnect failed:', err);
    }
  }

  /**
   * Disconnect from LaserStream.
   */
  disconnect(): void {
    if (this.client) {
      this.client.close();
      this.client = null;
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
