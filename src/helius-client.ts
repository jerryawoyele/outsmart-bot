import WebSocket from 'ws';
import { TokenPosition } from './types.js';
import { rpcRateLimiter } from './rpc-rate-limiter.js';

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000,
  name: string = 'operation'
): Promise<T> {
  let lastError: Error | undefined;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.log(`[Helius] Retry ${attempt}/${maxRetries} for ${name} in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }
  
  throw lastError;
}

export interface HeliusWsConfig {
  wsUrl: string;
  rpcUrl: string;
  walletAddress?: string;
  onLiquidityRemoval?: (tokenMint: string, signature: string) => void;
  onNewToken?: (tokenMint: string, signature: string) => void;
  onUserTokenBalanceChange?: (tokenAccount: string, amount: bigint) => void;
  onError?: (error: Error) => void;
  onConnect?: () => void;
}

export interface LogNotification {
  result: {
    context: { slot: number };
    value: {
      signature: string;
      err: any;
      logs: string[];
    };
  };
  subscription: number;
}

export interface AccountNotification {
  result: {
    context: { slot: number };
    value: {
      data: [string, string];
      executable: boolean;
      owner: string;
      lamports: number;
    };
  };
  subscription: number;
}

// SPL Token Account layout (165 bytes)
// mint: 32 bytes offset 0
// owner: 32 bytes offset 32
// amount: 8 bytes offset 64
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;

function decodeTokenAmount(data: string): bigint | null {
  try {
    const buf = Buffer.from(data, 'base64');
    if (buf.length < 72) return null;
    // amount is u64 at offset 64
    return buf.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET);
  } catch {
    return null;
  }
}

/**
 * Helius WebSocket client for monitoring dev token accounts
 * Uses logsSubscribe to detect ANY transaction involving the account
 * Also uses accountSubscribe to cache user token balances
 */
export class HeliusWsClient {
  private ws: WebSocket | null = null;
  private config: HeliusWsConfig;
  private requestId = 0;
  
  // logsSubscribe for dev token accounts
  private subscriptions: Map<number, { tokenAccount: string; position: TokenPosition }> = new Map();
  private tokenAccountToSubId: Map<string, number> = new Map();
  
  // logsSubscribe for fast-detection accounts (receives notifications faster)
  private fastDetectionSubscriptions: Map<number, { account: string; position: TokenPosition }> = new Map();
  private fastDetectionToSubId: Map<string, number> = new Map(); // tokenMint -> subId
  
  // accountSubscribe for user token balance caching
  private balanceSubscriptions: Map<number, string> = new Map(); // subId -> tokenAccount
  private pendingBalanceSubs: Map<number, string> = new Map(); // requestId -> tokenAccount (placeholder)
  private tokenAccountToBalanceSubId: Map<string, number> = new Map(); // tokenAccount -> subId
  
  // Wallet logs subscription for new token buys
  private walletLogsSubId: number | null = null;
  
  // Cached balances: tokenAccount -> amount
  private cachedBalances: Map<string, bigint> = new Map();
  
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private isReconnecting = false;

  constructor(config: HeliusWsConfig) {
    this.config = config;
  }

  /**
   * Get cached balance for a token account
   */
  getCachedBalance(tokenAccount: string): bigint | undefined {
    return this.cachedBalances.get(tokenAccount);
  }

  private async waitForHttpSlot(): Promise<void> {
    await rpcRateLimiter.waitForSlot();
  }

  private async rpcJson<T>(body: unknown, name: string): Promise<T> {
    return retryWithBackoff(
      async () => {
        await this.waitForHttpSlot();

        const response = await fetch(this.config.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (response.status === 429) {
          throw new Error(`HTTP 429 Too Many Requests`);
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return response.json() as Promise<T>;
      },
      4,
      500,
      name
    );
  }

  private async httpJson<T>(url: string, name: string): Promise<T> {
    return retryWithBackoff(
      async () => {
        await this.waitForHttpSlot();

        const response = await fetch(url);

        if (response.status === 429) {
          throw new Error(`HTTP 429 Too Many Requests`);
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return response.json() as Promise<T>;
      },
      4,
      500,
      name
    );
  }

  /**
   * Connect to Helius WebSocket
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.config.wsUrl);

      this.ws.on('open', () => {
        console.log('[Helius] WebSocket connected');
        this.reconnectAttempts = 0;
        this.config.onConnect?.();
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const response = JSON.parse(data.toString());
          
          // Handle subscription confirmation
          if (response.result !== undefined && response.id !== undefined) {
            const requestId = response.id;
            const subId = response.result;
            
            // Check if this is a balance subscription
            const balanceTokenAccount = this.pendingBalanceSubs.get(requestId);
            if (balanceTokenAccount) {
              this.pendingBalanceSubs.delete(requestId);
              
              // Check if this is a wallet subscription
              if (balanceTokenAccount.startsWith('wallet:')) {
                this.walletLogsSubId = subId;
                console.log('[Helius] Subscribed to wallet logs');
              } else {
                this.balanceSubscriptions.set(subId, balanceTokenAccount);
                this.tokenAccountToBalanceSubId.set(balanceTokenAccount, subId);
              }
              return;
            }
            
            // Otherwise it's a logs subscription
            const subInfo = this.subscriptions.get(requestId);
            if (subInfo) {
              this.subscriptions.delete(requestId);
              this.subscriptions.set(subId, subInfo);
              this.tokenAccountToSubId.set(subInfo.tokenAccount, subId);
              return;
            }
            
            // Check if this is a fast-detection subscription
            const fastInfo = this.fastDetectionSubscriptions.get(requestId);
            if (fastInfo) {
              this.fastDetectionSubscriptions.delete(requestId);
              this.fastDetectionSubscriptions.set(subId, fastInfo);
              this.fastDetectionToSubId.set(fastInfo.position.tokenMint, subId);
              console.log(`[Helius] ✅ Fast-detection subscription confirmed: subId=${subId} for ${fastInfo.position.tokenMint.slice(0, 8)}...`);
              return;
            }
            return;
          }

          // Handle logs notifications
          if (response.method === 'logsNotification') {
            const subId = response.params?.subscription;
            console.log(`[Helius] 📨 logsNotification received: subId=${subId}, walletSub=${this.walletLogsSubId}, fastSubs=${this.fastDetectionSubscriptions.size}, devSubs=${this.subscriptions.size}`);
            
            // Check if this is wallet logs notification
            if (subId === this.walletLogsSubId) {
              const signature = response.params?.result?.value?.signature;
              const logs = response.params?.result?.value?.logs || [];
              this.handleWalletLogsNotification(signature, logs);
            } else if (this.fastDetectionSubscriptions.has(subId)) {
              // Fast-detection logs notification - trigger sell immediately
              console.log(`[Helius] ⚡ FAST RUG DETECTED via logsSubscribe: subId=${subId}`);
              this.handleFastDetectionNotification(response);
            } else {
              console.log(`[Helius] 📌 Routing to dev token account handler`);
              this.handleLogsNotification(response);
            }
          }
          
          // Handle account notifications (for balance caching only)
          if (response.method === 'accountNotification') {
            this.handleAccountNotification(response);
          }
        } catch (err) {
          console.error('[Helius] Failed to parse message:', err);
        }
      });

      this.ws.on('error', (error: Error) => {
        console.error('[Helius] WebSocket error:', error.message);
        this.config.onError?.(error);
        reject(error);
      });

      this.ws.on('close', () => {
        console.log('[Helius] WebSocket closed');
        this.attemptReconnect();
      });
    });
  }

  /**
   * Handle account notification - update cached balance
   */
  private handleAccountNotification(response: { params: AccountNotification; subscription: number }): void {
    const subId = response.params?.subscription;
    const tokenAccount = this.balanceSubscriptions.get(subId);
    
    if (!tokenAccount) return;
    
    const accountData = response.params?.result?.value?.data;
    if (accountData && Array.isArray(accountData)) {
      const [data, encoding] = accountData;
      if (encoding === 'base64' && data) {
        const amount = decodeTokenAmount(data);
        if (amount !== null) {
          this.cachedBalances.set(tokenAccount, amount);
          this.config.onUserTokenBalanceChange?.(tokenAccount, amount);
        }
      }
    }
  }

  /**
   * Handle logs notification - ANY transaction = SELL
   */
  private handleLogsNotification(response: { params: LogNotification; subscription: number }): void {
    const subId = response.params?.subscription;
    const subInfo = this.subscriptions.get(subId);
    
    if (!subInfo) return;
    
    const { position } = subInfo;
    const signature = response.params?.result?.value?.signature;
    const err = response.params?.result?.value?.err;
    
    // Skip failed transactions
    if (err) {
      console.log(`[Helius] Failed tx for ${position.tokenMint.slice(0, 8)}...: ${signature?.slice(0, 12)}...`);
      return;
    }
    
    console.log(
      `[Helius] 🚨 LIQUIDITY REMOVAL DETECTED - token: ${position.tokenMint.slice(0, 12)}... ` +
      `sig: ${signature?.slice(0, 12)}...`
    );
    
    // Trigger sell - don't unsubscribe here, let caller handle after sell
    this.config.onLiquidityRemoval?.(position.tokenMint, signature || '');
  }

  /**
   * Handle fast-detection logs notification - ANY log = SELL immediately.
   * This is the fastest way to detect rug pulls.
   */
  private handleFastDetectionNotification(response: { params: LogNotification; subscription: number }): void {
    const subId = response.params?.subscription;
    const subInfo = this.fastDetectionSubscriptions.get(subId);
    
    if (!subInfo) return;
    
    const { position } = subInfo;
    const signature = response.params?.result?.value?.signature;
    const err = response.params?.result?.value?.err;
    
    // Skip failed transactions
    if (err) {
      console.log(`[Helius] Failed tx (fast-detect) for ${position.tokenMint.slice(0, 8)}...: ${signature?.slice(0, 12)}...`);
      return;
    }
    
    console.log(
      `[Helius] ⚡ FAST RUG DETECTED - token: ${position.tokenMint.slice(0, 12)}... ` +
      `sig: ${signature?.slice(0, 12)}...`
    );
    
    // Trigger sell immediately - any log mentioning the account = rug
    this.config.onLiquidityRemoval?.(position.tokenMint, signature || '');
  }

  /**
   * Subscribe to fast-detection account for rug monitoring.
   * Uses logsSubscribe to detect ANY transaction mentioning the account.
   * When any log is detected, sell immediately.
   */
  subscribeToFastDetectionAccount(account: string, position: TokenPosition): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    // Check if already subscribed for this token
    if (this.fastDetectionToSubId.has(position.tokenMint)) {
      return;
    }

    this.requestId++;
    const request = {
      jsonrpc: '2.0',
      id: this.requestId,
      method: 'logsSubscribe',
      params: [
        {
          mentions: [account],
        },
        {
          commitment: 'processed',
        },
      ],
    };

    this.ws.send(JSON.stringify(request));
    
    // Store with requestId as placeholder, will be replaced with actual subId
    this.fastDetectionSubscriptions.set(this.requestId, { account, position });
    console.log(`[Helius] Subscribed to fast-detection logs: ${account.slice(0, 12)}... for ${position.tokenMint.slice(0, 8)}...`);
  }

  /**
   * Subscribe to user's token account balance changes via accountSubscribe
   */
  subscribeToUserTokenBalance(tokenAccount: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    // Check if already subscribed
    if (this.tokenAccountToBalanceSubId.has(tokenAccount)) {
      return;
    }

    this.requestId++;
    const request = {
      jsonrpc: '2.0',
      id: this.requestId,
      method: 'accountSubscribe',
      params: [
        tokenAccount,
        {
          encoding: 'base64',
          commitment: 'processed',
        },
      ],
    };

    this.ws.send(JSON.stringify(request));
    
    // Store with requestId as placeholder
    this.pendingBalanceSubs.set(this.requestId, tokenAccount);
  }

  /**
   * Subscribe to logs mentioning the dev's token account
   */
  subscribeToTokenAccount(tokenAccount: string, position: TokenPosition): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    this.requestId++;
    const request = {
      jsonrpc: '2.0',
      id: this.requestId,
      method: 'logsSubscribe',
      params: [
        {
          mentions: [tokenAccount],
        },
        {
          commitment: 'processed',
        },
      ],
    };

    this.ws.send(JSON.stringify(request));
    
    // Store with requestId as placeholder, will be replaced with actual subId
    this.subscriptions.set(this.requestId, { tokenAccount, position });
    this.tokenAccountToSubId.set(tokenAccount, this.requestId);
  }

  /**
   * Unsubscribe from a specific token account (when position is sold)
   */
  unsubscribeFromTokenAccount(tokenAccount: string, tokenMint?: string): void {
    // Unsubscribe from logs
    for (const [actualSubId, info] of this.subscriptions) {
      if (info.tokenAccount === tokenAccount) {
        this.unsubscribeLogs(actualSubId);
        this.tokenAccountToSubId.delete(tokenAccount);
        break;
      }
    }
    
    // Unsubscribe from fast-detection account if tokenMint provided
    if (tokenMint) {
      const fastSubId = this.fastDetectionToSubId.get(tokenMint);
      if (fastSubId) {
        this.unsubscribeFastDetection(fastSubId);
        this.fastDetectionToSubId.delete(tokenMint);
      }
    }
    
    // Unsubscribe from balance
    const balanceSubId = this.tokenAccountToBalanceSubId.get(tokenAccount);
    if (balanceSubId) {
      this.unsubscribeAccount(balanceSubId);
      this.balanceSubscriptions.delete(balanceSubId);
      this.tokenAccountToBalanceSubId.delete(tokenAccount);
      this.cachedBalances.delete(tokenAccount);
    }
  }

  /**
   * Unsubscribe from fast-detection logs subscription
   */
  private unsubscribeFastDetection(subscriptionId: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.requestId++;
    const request = {
      jsonrpc: '2.0',
      id: this.requestId,
      method: 'logsUnsubscribe',
      params: [subscriptionId],
    };

    this.ws.send(JSON.stringify(request));
    this.fastDetectionSubscriptions.delete(subscriptionId);
  }

  /**
   * Unsubscribe from logs
   */
  private unsubscribeLogs(subscriptionId: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.requestId++;
    const request = {
      jsonrpc: '2.0',
      id: this.requestId,
      method: 'logsUnsubscribe',
      params: [subscriptionId],
    };

    this.ws.send(JSON.stringify(request));
    this.subscriptions.delete(subscriptionId);
  }

  /**
   * Subscribe to wallet logs to detect new token buys
   */
  subscribeToWalletLogs(walletAddress: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    this.requestId++;
    const request = {
      jsonrpc: '2.0',
      id: this.requestId,
      method: 'logsSubscribe',
      params: [
        {
          mentions: [walletAddress],
        },
        {
          commitment: 'processed',
        },
      ],
    };

    this.ws.send(JSON.stringify(request));
    
    // Store requestId as placeholder for wallet sub
    this.pendingBalanceSubs.set(this.requestId, `wallet:${walletAddress}`);
  }

  /**
   * Handle wallet logs notification to detect new token buys
   */
  private handleWalletLogsNotification(signature: string, logs: string[]): void {
    // Look for SPL token mint or transfer to wallet indicating a buy
    // Parse logs to find new token mints
    for (const log of logs) {
      // Match "Program log: Mint: <address>" or similar patterns
      const mintMatch = log.match(/Program log: Mint:\s*([A-Za-z0-9]{32,44})/i);
      if (mintMatch) {
        const tokenMint = mintMatch[1];
        // Skip SOL mint
        if (tokenMint !== 'So11111111111111111111111111111111111111112') {
          this.config.onNewToken?.(tokenMint, signature);
          return;
        }
      }
      
      // Also detect via TokenkegQfeZyiNwAJbNbGKPFXCWuBf9F2sTMzSt8
      // Program TokenkegQfeZyiNwAJbNbGKPFXCWuBf9F2sTMzSt8 invoke
      // Look for new token account creation
      if (log.includes('TokenkegQfeZyiNwAJbNbGKPFXCWuBf9F2sTMzSt8') || 
          log.includes('TokenzQdBNbL2PyPQvZsLMjJqLmzT2ULi6pUgqHmNp')) {
        // Check for InitializeAccount3 or similar - indicates new token account
        if (log.includes('InitializeAccount') || log.includes('InitializeMint')) {
          // Extract mint from subsequent logs
          const mintInLogs = logs.find(l => 
            l.includes('Program log:') && 
            l.match(/[A-Za-z0-9]{32,44}/)
          );
          if (mintInLogs) {
            const possibleMint = mintInLogs.match(/([A-Za-z0-9]{32,44})/g);
            if (possibleMint) {
              // Filter out known program IDs and find the mint
              for (const addr of possibleMint) {
                if (addr.length >= 32 && addr !== 'So11111111111111111111111111111111111111112') {
                  // This could be a token mint - trigger callback
                  this.config.onNewToken?.(addr, signature);
                  return;
                }
              }
            }
          }
        }
      }
    }
  }

  /**
   * Unsubscribe from account
   */
  private unsubscribeAccount(subscriptionId: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.requestId++;
    const request = {
      jsonrpc: '2.0',
      id: this.requestId,
      method: 'accountUnsubscribe',
      params: [subscriptionId],
    };

    this.ws.send(JSON.stringify(request));
    this.balanceSubscriptions.delete(subscriptionId);
  }

  /**
   * Get user's token account for a specific mint via Helius HTTP RPC
   */
  async getUserTokenAccount(walletAddress: string, tokenMint: string): Promise<string | null> {
    try {
      const data = await this.rpcJson<{
        result?: { token_accounts?: Array<{ address: string; amount?: number }> };
      }>(
        {
          jsonrpc: '2.0',
          id: '1',
          method: 'getTokenAccounts',
          params: {
            owner: walletAddress,
            mint: tokenMint,
          },
        },
        `getUserTokenAccount(${tokenMint.slice(0, 8)}...)` 
      );
      
      if (data.result?.token_accounts?.length) {
        const acc = data.result.token_accounts[0];
        if (acc.amount !== undefined) {
          this.cachedBalances.set(acc.address, BigInt(acc.amount));
        }
        return acc.address;
      }

      return null;
    } catch (error) {
      console.error(`[Helius] Failed to get user token account: ${error}`);
      return null;
    }
  }

  /**
   * Get dev's token account via Helius HTTP RPC
   */
  async getDevTokenAccount(devAddress: string, tokenMint: string): Promise<string | null> {
    try {
      const data = await this.rpcJson<{
        result?: { token_accounts?: Array<{ address: string }> };
      }>(
        {
          jsonrpc: '2.0',
          id: '1',
          method: 'getTokenAccounts',
          params: {
            owner: devAddress,
            mint: tokenMint,
          },
        },
        `getDevTokenAccount(${tokenMint.slice(0, 8)}...)` 
      );
      
      if (data.result?.token_accounts?.length) {
        return data.result.token_accounts[0].address;
      }

      return null;
    } catch (error) {
      console.error(`[Helius] Failed to get dev token account: ${error}`);
      return null;
    }
  }

  /**
   * Get CLMM pool address from dev token account's CLOSE_ACCOUNT transaction
   * The pool address is the toUserAccount in the first tokenTransfer
   */
  async getPoolFromDevTokenAccount(devTokenAccount: string): Promise<string | null> {
    try {
      const heliusApiKey = this.config.rpcUrl.split('api-key=')[1];
      if (!heliusApiKey) return null;

      const url =
        `https://api-mainnet.helius-rpc.com/v0/addresses/${devTokenAccount}/transactions` +
        `?token-accounts=none&sort-order=asc&api-key=${heliusApiKey}` +
        `&type=CLOSE_ACCOUNT&source=SOLANA_PROGRAM_LIBRARY`;

      const transactions = await this.httpJson<
        Array<{
          type: string;
          tokenTransfers?: Array<{
            fromTokenAccount: string;
            toTokenAccount: string;
            fromUserAccount: string;
            toUserAccount: string;
            mint: string;
          }>;
        }>
      >(url, `getPoolFromDevTokenAccount(${devTokenAccount.slice(0, 8)}...)`);

      for (const tx of transactions) {
        if (tx.tokenTransfers?.length) {
          const poolAddress = tx.tokenTransfers[0].toUserAccount;
          if (poolAddress) {
            console.log(`[Helius] Found CLMM pool: ${poolAddress.slice(0, 12)}...`);
            return poolAddress;
          }
        }
      }

      return null;
    } catch (error) {
      console.error(`[Helius] Failed to get pool from dev token account: ${error}`);
      return null;
    }
  }

  /**
   * Get the fast-detection account for rug monitoring.
   * This account receives notifications faster than the dev token account.
   * 
   * Algorithm:
   * 1. Fetch the latest transaction for the dev token account (usually CREATE_POOL)
   * 2. Parse accountData array
   * 3. Find the LAST account with non-zero nativeBalanceChange
   * 4. Return that account address for logsSubscribe monitoring
   */
  async getFastDetectionAccount(devTokenAccount: string): Promise<string | null> {
    try {
      const heliusApiKey = this.config.rpcUrl.split('api-key=')[1];
      if (!heliusApiKey) {
        console.warn('[Helius] No API key found for fast detection account lookup');
        return null;
      }

      // Fetch the latest transaction (limit=1, sort-order=desc)
      const url =
        `https://api-mainnet.helius-rpc.com/v0/addresses/${devTokenAccount}/transactions` +
        `?token-accounts=none&sort-order=desc&api-key=${heliusApiKey}&limit=1`;

      const transactions = await this.httpJson<
        Array<{
          type: string;
          accountData?: Array<{
            account: string;
            nativeBalanceChange: number;
            tokenBalanceChanges?: unknown[];
          }>;
        }>
      >(url, `getFastDetectionAccount(${devTokenAccount.slice(0, 8)}...)`);

      if (!transactions.length || !transactions[0].accountData) {
        console.warn(`[Helius] No transaction data found for ${devTokenAccount.slice(0, 8)}...`);
        return null;
      }

      const accountData = transactions[0].accountData;
      
      // Find the LAST account with non-zero nativeBalanceChange
      // Iterate in reverse to find the last one
      for (let i = accountData.length - 1; i >= 0; i--) {
        const acc = accountData[i];
        if (acc.nativeBalanceChange !== 0) {
          console.log(
            `[Helius] Found fast-detection account: ${acc.account.slice(0, 12)}... ` +
            `(balance change: ${acc.nativeBalanceChange})`
          );
          return acc.account;
        }
      }

      console.warn(`[Helius] No account with non-zero balance change found for ${devTokenAccount.slice(0, 8)}...`);
      return null;
    } catch (error) {
      console.error(`[Helius] Failed to get fast detection account: ${error}`);
      return null;
    }
  }

  /**
   * Get token accounts for wallet via Helius HTTP RPC
   */
  async getWalletTokenAccounts(walletAddress: string): Promise<Array<{ tokenAccount: string; mint: string; amount: string; decimals: number }>> {
    try {
      const data = await this.rpcJson<{
        result?: {
          token_accounts?: Array<{
            address: string;
            mint: string;
            amount: number;
          }>;
        };
      }>(
        {
          jsonrpc: '2.0',
          id: '1',
          method: 'getTokenAccounts',
          params: {
            owner: walletAddress,
          },
        },
        'getWalletTokenAccounts'
      );

      if (data.result?.token_accounts) {
        return data.result.token_accounts.map((acc) => ({
          tokenAccount: acc.address,
          mint: acc.mint,
          amount: acc.amount.toString(),
          decimals: 6,
        }));
      }

      return [];
    } catch (error) {
      console.error(`[Helius] Failed to get wallet token accounts: ${error}`);
      return [];
    }
  }

  /**
   * Get token account balance via RPC
   */
  async getTokenAccountBalance(tokenAccount: string): Promise<{ value: { amount: string } } | null> {
    try {
      const cached = this.cachedBalances.get(tokenAccount);
      if (cached !== undefined) {
        return { value: { amount: cached.toString() } };
      }

      const data = await this.rpcJson<{ result?: { value: { amount: string } } }>(
        {
          jsonrpc: '2.0',
          id: '1',
          method: 'getTokenAccountBalance',
          params: [tokenAccount, { commitment: 'processed' }],
        },
        `getTokenAccountBalance(${tokenAccount.slice(0, 8)}...)` 
      );

      return data.result ?? null;
    } catch (error) {
      console.error(`[Helius] Failed to get token account balance: ${error}`);
      return null;
    }
  }

  /**
   * Attempt to reconnect with exponential backoff
   */
  private async attemptReconnect(): Promise<void> {
    if (this.isReconnecting || this.reconnectAttempts >= this.maxReconnectAttempts) {
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    console.log(`[Helius] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      await this.connect();
      
      // Re-subscribe to logs
      const toResubscribe = Array.from(this.subscriptions.values());
      this.subscriptions.clear();
      this.tokenAccountToSubId.clear();
      for (const { tokenAccount, position } of toResubscribe) {
        this.subscribeToTokenAccount(tokenAccount, position);
      }
      
      // Re-subscribe to balance accounts
      const balanceAccounts = Array.from(this.balanceSubscriptions.values());
      this.balanceSubscriptions.clear();
      this.tokenAccountToBalanceSubId.clear();
      for (const tokenAccount of balanceAccounts) {
        this.subscribeToUserTokenBalance(tokenAccount);
      }
      
      this.isReconnecting = false;
    } catch (err) {
      this.isReconnecting = false;
      console.error('[Helius] Reconnect failed:', err);
    }
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Get WSOL vault address and initial SOL amount from token account's latest transaction.
   * Used to find the CLMM pool's WSOL vault for rug detection.
   * 
   * Process:
   * 1. Get latest transaction for the token account
   * 2. Find the WSOL vault from tokenTransfers (first transfer with WSOL mint)
   * 3. Get initial SOL amount from tokenAmount field
   * 
   * @param tokenAccount - The token account to look up
   * @returns Object with wsolVault address and initialSolRaw (in lamports), or null if not found
   */
  async getWsolVaultFromTokenAccount(tokenAccount: string): Promise<{ wsolVault: string; initialSolRaw: bigint } | null> {
    try {
      // Build proper URL for Helius enhanced API
      // Extract base URL and API key from rpcUrl
      const rpcUrlParts = this.config.rpcUrl.split('?');
      const baseUrl = rpcUrlParts[0].replace('/v0/addresses', '');
      const apiKeyMatch = this.config.rpcUrl.match(/api-key=([^&]+)/);
      const apiKey = apiKeyMatch ? apiKeyMatch[1] : '';
      
      const txUrl = `${baseUrl}/v0/addresses/${tokenAccount}/transactions?sort-order=desc&limit=1&api-key=${apiKey}`;
      
      const transactions = await this.httpJson<any[]>(txUrl, 'getWsolVaultFromTokenAccount');
      
      if (!transactions || transactions.length === 0) {
        console.log(`[Helius] No transactions found for token account ${tokenAccount.slice(0, 8)}...`);
        return null;
      }

      const tx = transactions[0];
      
      // Look for WSOL vault in tokenTransfers - find the first transfer with WSOL mint
      // This gives us both the vault address (toTokenAccount) and initial SOL amount (tokenAmount)
      if (tx.tokenTransfers && Array.isArray(tx.tokenTransfers)) {
        for (const tokenTransfer of tx.tokenTransfers) {
          // Check if this is a WSOL transfer (mint is WSOL)
          if (tokenTransfer.mint === 'So11111111111111111111111111111111111111112') {
            const wsolVault = tokenTransfer.toTokenAccount;
            const tokenAmount = tokenTransfer.tokenAmount; // This is in SOL (e.g., 279.999996104)
            
            // Convert SOL amount to lamports (multiply by 1e9)
            const initialSolRaw = BigInt(Math.floor(tokenAmount * 1_000_000_000));
            
            console.log(
              `[Helius] Found WSOL vault ${wsolVault.slice(0, 12)}... ` +
              `with initial SOL: ${tokenAmount} (${initialSolRaw} lamports) ` +
              `for token account ${tokenAccount.slice(0, 8)}...`
            );
            
            return { wsolVault, initialSolRaw };
          }
        }
      }

      // Fallback: Look in accountData for WSOL token balance changes
      if (tx.accountData && Array.isArray(tx.accountData)) {
        for (const acc of tx.accountData) {
          if (acc.tokenBalanceChanges) {
            for (const tokenChange of acc.tokenBalanceChanges) {
              if (tokenChange.mint === 'So11111111111111111111111111111111111111112') {
                // Found WSOL vault
                const wsolVault = acc.account;
                // Get initial balance from rawTokenAmount
                const rawAmount = tokenChange.rawTokenAmount?.tokenAmount;
                if (rawAmount) {
                  const initialSolRaw = BigInt(rawAmount);
                  console.log(
                    `[Helius] Found WSOL vault (fallback) ${wsolVault.slice(0, 12)}... ` +
                    `with initial SOL: ${initialSolRaw} lamports ` +
                    `for token account ${tokenAccount.slice(0, 8)}...`
                  );
                  return { wsolVault, initialSolRaw };
                }
              }
            }
          }
        }
      }

      console.log(`[Helius] Could not find WSOL vault in transaction for ${tokenAccount.slice(0, 8)}...`);
      return null;
    } catch (error) {
      console.error(`[Helius] Failed to get WSOL vault: ${error}`);
      return null;
    }
  }

  /**
   * Get WSOL balance of a vault account via RPC
   */
  async getWsolBalance(vaultAddress: string): Promise<bigint | null> {
    try {
      const data = await this.rpcJson<{ result?: { value: { amount: string } } }>(
        {
          jsonrpc: '2.0',
          id: '1',
          method: 'getTokenAccountBalance',
          params: [vaultAddress, { commitment: 'processed' }],
        },
        `getWsolBalance(${vaultAddress.slice(0, 8)}...)`
      );

      if (data.result?.value?.amount) {
        return BigInt(data.result.value.amount);
      }
      return null;
    } catch (error) {
      console.error(`[Helius] Failed to get WSOL balance: ${error}`);
      return null;
    }
  }
}
