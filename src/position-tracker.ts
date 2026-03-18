import { TokenPosition, DevWallet, RAYDIUM_CLMM_PROGRAM_ID } from './types.js';
import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

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
        console.log(`[Tracker] Retry ${attempt}/${maxRetries} for ${name} in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

export interface PositionTrackerConfig {
  rpcUrl: string;
  walletAddress: string;
  heliusApiKeys?: string[]; // Available API keys for pool discovery
}

/**
 * Tracks token positions and their associated dev wallets
 * Fetches dev addresses from on-chain data for Raydium CLMM pools
 */
export class PositionTracker {
  private connection: Connection;
  private walletAddress: string;
  private positions: Map<string, TokenPosition> = new Map(); // tokenMint -> position
  private devWallets: Map<string, DevWallet> = new Map(); // devAddress -> DevWallet
  private heliusApiKeys: string[] = []; // Available API keys for pool discovery
  private currentKeyIndex: number = 0; // Current API key index for round-robin

  constructor(config: PositionTrackerConfig) {
    this.connection = new Connection(config.rpcUrl, 'processed');
    this.walletAddress = config.walletAddress;
    this.heliusApiKeys = config.heliusApiKeys || [];
  }

  /**
   * Get next available API key (round-robin)
   */
  private getNextApiKey(): string | null {
    if (this.heliusApiKeys.length === 0) return null;
    const key = this.heliusApiKeys[this.currentKeyIndex];
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.heliusApiKeys.length;
    return key;
  }

  /**
   * Check if API keys are available
   */
  hasApiKeys(): boolean {
    return this.heliusApiKeys.length > 0;
  }

  /**
   * Get all tracked positions
   */
  getPositions(): TokenPosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get all dev wallet addresses being monitored
   */
  getDevAddresses(): string[] {
    return Array.from(this.devWallets.keys());
  }

  /**
   * Add a new token position
   * Fetches dev address from pool creator or initial liquidity provider
   */
  async addPosition(
    tokenMint: string,
    poolAddress: string,
    amountHeld: bigint,
    decimals: number
  ): Promise<TokenPosition> {
    // Check if already tracking
    const existing = this.positions.get(tokenMint);
    if (existing) {
      // Update amount
      existing.amountHeld += amountHeld;
      return existing;
    }

    // Fetch dev address from pool
    const devAddress = await this.fetchPoolCreator(poolAddress);

    const position: TokenPosition = {
      tokenMint,
      poolAddress,
      dex: 'raydium-clmm',
      devAddress,
      amountHeld,
      decimals,
      addedAt: Date.now(),
      hasLiquidity: true,
      txCount: 0,
    };

    this.positions.set(tokenMint, position);

    // Track dev wallet
    if (!this.devWallets.has(devAddress)) {
      this.devWallets.set(devAddress, {
        address: devAddress,
        tokens: new Set([tokenMint]),
      });
    } else {
      this.devWallets.get(devAddress)!.tokens.add(tokenMint);
    }

    console.log(`[Tracker] Added position: ${tokenMint.slice(0, 8)}... (dev: ${devAddress.slice(0, 8)}...)`);
    return position;
  }

  /**
   * Remove a position after selling
   */
  removePosition(tokenMint: string): void {
    const position = this.positions.get(tokenMint);
    if (position) {
      // Remove from dev wallet tracking
      const devWallet = this.devWallets.get(position.devAddress);
      if (devWallet) {
        devWallet.tokens.delete(tokenMint);
        if (devWallet.tokens.size === 0) {
          this.devWallets.delete(position.devAddress);
        }
      }
      this.positions.delete(tokenMint);
      console.log(`[Tracker] ⚠️  Removed position: ${tokenMint.slice(0, 8)}...`);
    }
  }

  /**
   * Mark position as having no liquidity (dev rug detected)
   */
  markLiquidityRemoved(tokenMint: string): void {
    const position = this.positions.get(tokenMint);
    if (position) {
      position.hasLiquidity = false;
    }
  }

  /**
   * Get position by token mint
   */
  getPosition(tokenMint: string): TokenPosition | undefined {
    return this.positions.get(tokenMint);
  }

  /**
   * Get all tokens for a dev wallet
   */
  getDevTokens(devAddress: string): string[] {
    const devWallet = this.devWallets.get(devAddress);
    return devWallet ? Array.from(devWallet.tokens) : [];
  }

  /**
   * Fetch pool creator/first LP from on-chain data
   * This is the dev address we'll monitor for liquidity removal
   */
  private async fetchPoolCreator(poolAddress: string): Promise<string> {
    try {
      const pubkey = new PublicKey(poolAddress);
      const accountInfo = await this.connection.getAccountInfo(pubkey);

      if (!accountInfo) {
        throw new Error(`Pool account not found: ${poolAddress}`);
      }

      // For Raydium CLMM, fetch pool creation transaction to find creator
      const signatures = await this.connection.getSignaturesForAddress(pubkey, {
        limit: 1,
      });

      if (signatures.length === 0) {
        throw new Error(`No transactions found for pool: ${poolAddress}`);
      }

      // Get the first transaction (pool creation)
      const tx = await this.connection.getParsedTransaction(signatures[0].signature, {
        maxSupportedTransactionVersion: 0,
      });

      if (tx?.transaction) {
        // Extract the fee payer or first signer as the dev
        const message = tx.transaction.message;
        if ('accountKeys' in message) {
          // Parsed transaction
          const creator = message.accountKeys.find((key: { signer: boolean; pubkey: PublicKey }) => key.signer);
          if (creator) {
            return creator.pubkey.toBase58();
          }
        }
      }

      // Fallback: use the pool's owner field if available
      // Raydium CLMM pools have specific layout
      console.warn(`[Tracker] Could not find pool creator for ${poolAddress}, using fallback`);
      return 'UNKNOWN';
    } catch (error) {
      console.error(`[Tracker] Error fetching pool creator: ${error}`);
      throw error;
    }
  }

  /**
   * Check if a pool still has liquidity
   * Queries the pool's token reserves
   */
  async checkPoolLiquidity(poolAddress: string): Promise<boolean> {
    try {
      // Use getTokenAccountsByOwner to check LP token balance
      // If dev has no LP tokens, they've removed liquidity
      const position = Array.from(this.positions.values()).find((p) => p.poolAddress === poolAddress);
      if (!position) return false;

      // Query pool state for liquidity info
      const pubkey = new PublicKey(poolAddress);
      const accountInfo = await this.connection.getAccountInfo(pubkey);

      // Basic check: if account exists and has data, pool is active
      // More sophisticated: parse CLMM pool state for liquidity amounts
      return accountInfo !== null && accountInfo.data.length > 0;
    } catch (error) {
      console.error(`[Tracker] Error checking pool liquidity: ${error}`);
      return false;
    }
  }

  /**
   * Load positions from wallet's token accounts
   * Useful for initial load on startup
   */
  async loadPositionsFromWallet(): Promise<void> {
    try {
      const trimmedAddress = this.walletAddress.trim();
      const walletPubkey = new PublicKey(trimmedAddress);
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(walletPubkey, {
        programId: TOKEN_PROGRAM_ID,
      });

      console.log(`[Tracker] Found ${tokenAccounts.value.length} token accounts in wallet`);

      for (const account of tokenAccounts.value) {
        const info = account.account.data.parsed.info;
        const mint = info.mint;
        const amount = BigInt(info.tokenAmount.amount);
        const decimals = info.tokenAmount.decimals;
        const tokenAccountAddress = account.pubkey.toBase58(); // Wallet's token account

        // Skip if amount is 0
        if (amount === 0n) continue;

        // Find the dev address for this token
        const devAddress = await this.findTokenDev(mint);
        if (devAddress) {
          // Add position with dev address and wallet token account
          await this.addPositionWithDev(mint, devAddress, amount, decimals, tokenAccountAddress);
        }
      }
    } catch (error) {
      const err = error as Error;
      console.error(`[Tracker] Error loading positions from wallet: ${err.message}`);
      console.error(`[Tracker] Stack: ${err.stack}`);
    }
  }

  /**
   * Add a position with known dev address (public for new buy detection)
   */
  async addPositionWithDev(
    tokenMint: string,
    devAddress: string,
    amountHeld: bigint,
    decimals: number,
    walletTokenAccount?: string,
  ): Promise<void> {
    // Check if already tracking
    const existing = this.positions.get(tokenMint);
    if (existing) {
      existing.amountHeld += amountHeld;
      if (walletTokenAccount) {
        existing.walletTokenAccount = walletTokenAccount;
      }
      return;
    }

    const position: TokenPosition = {
      tokenMint,
      poolAddress: '', // Will be fetched from dev token account tx
      dex: 'raydium-clmm',
      devAddress,
      walletTokenAccount,
      amountHeld,
      decimals,
      addedAt: Date.now(),
      hasLiquidity: true,
      txCount: 0,
    };

    this.positions.set(tokenMint, position);

    // Track dev wallet
    if (!this.devWallets.has(devAddress)) {
      this.devWallets.set(devAddress, {
        address: devAddress,
        tokens: new Set([tokenMint]),
      });
    } else {
      this.devWallets.get(devAddress)!.tokens.add(tokenMint);
    }

    console.log(`[Tracker] Added position: ${tokenMint.slice(0, 8)}... (dev: ${devAddress.slice(0, 8)}...)`);
  }

  /**
   * Find token dev address from first transaction via Helius API (public for new buy detection)
   */
  async findTokenDev(tokenMint: string): Promise<string | null> {
    try {
      // Get next available API key
      const heliusApiKey = this.getNextApiKey();
      
      if (!heliusApiKey) {
        console.warn(`[Tracker] No Helius API key available for pool discovery`);
        return null;
      }

      // Use Helius API to get first transaction for this token (the mint tx)
      // sort-order=asc gets the oldest tx (mint), token-accounts=none reduces response size
      const url = `https://api-mainnet.helius-rpc.com/v0/addresses/${tokenMint}/transactions?api-key=${heliusApiKey}&limit=1&sort-order=asc&token-accounts=none`;
      
      // Use retry with backoff for network resilience
      const response = await retryWithBackoff(
        async () => {
          const res = await fetch(url);
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          }
          return res;
        },
        3, // max retries
        1000, // base delay
        `findTokenDev(${tokenMint.slice(0, 8)}...)`
      );

      const transactions = await response.json() as HeliusTransaction[];
      
      if (!transactions || transactions.length === 0) {
        console.log(`[Tracker] No transactions found for token ${tokenMint.slice(0, 8)}...`);
        return null;
      }

      // The first transaction is the token mint - extract dev from feePayer
      const mintTx = transactions[0];
      const devAddress = mintTx.feePayer;
      
      console.log(`[Tracker] Found dev for ${tokenMint.slice(0, 8)}...: ${devAddress}`);
      
      // Return the dev address - we'll use this to monitor for liquidity removal
      // Note: For CLMM pools, we need to find the actual pool separately
      // For now, store dev and find pool when needed
      return devAddress;
    } catch (error) {
      console.error(`[Tracker] Error finding dev for ${tokenMint}:`, error);
      return null;
    }
  }
}

interface HeliusTransaction {
  signature: string;
  feePayer: string;
  type: string;
  description: string;
  tokenTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    tokenAmount: number;
    mint: string;
  }>;
}

interface PoolInfo {
  id: string;
  programId: string;
  baseMint: string;
  quoteMint: string;
  tvl?: number;
}
