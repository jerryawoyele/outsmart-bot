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
  onTransaction?: (signature: string, accounts: string[]) => void;
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
      // Check if this is a transaction update
      if (data.transaction) {
        const tx = data.transaction;
        const signature = tx.signatures?.[0] || tx.signature || 'unknown';
        
        // Get accounts involved in the transaction
        const involvedAccounts: string[] = [];
        if (tx.account_keys) {
          involvedAccounts.push(...tx.account_keys);
        }

        // Check if any monitored account is involved
        for (const account of involvedAccounts) {
          const tokenMint = this.monitoredAccounts.get(account);
          if (tokenMint) {
            console.log(
              `[LaserStream] ⚡ RUG DETECTED - token: ${tokenMint.slice(0, 12)}... ` +
              `account: ${account.slice(0, 12)}... sig: ${signature.slice(0, 12)}...`
            );
            
            // Trigger the callback
            this.config.onTransaction?.(signature, involvedAccounts);
            return; // Only trigger once per transaction
          }
        }
      }
    } catch (err) {
      console.error('[LaserStream] Failed to handle update:', err);
    }
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
