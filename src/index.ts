import 'dotenv/config';
import { HeliusWsClient } from './helius-client.js';
import { PositionTracker } from './position-tracker.js';
import { ClmmSeller } from './clmm-seller.js';
import { TokenPosition } from './types.js';

interface BotConfig {
  heliusWsUrl: string;
  rpcUrl: string;
  heliusApiKey: string;
  walletAddress: string;
  privateKey: string;
  defaultSlippageBps?: number;
  priorityFeeMicroLamports?: number;
  computeUnits?: number;
  tipLamports?: number;
  confirmAfterSend?: boolean;
  blockhashRefreshMs?: number;
  tokenBalancePollFallbackMs?: number;
  staleBlockhashMs?: number;
  staleTokenBalanceMs?: number;
}

/**
 * Main Rug Defense Bot
 * Monitors dev token accounts for ANY balance change and auto-sells positions immediately
 * Also detects new token buys and auto-monitors them
 */
class RugDefenseBot {
  private heliusClient: HeliusWsClient;
  private positionTracker: PositionTracker;
  private seller: ClmmSeller;
  private config: BotConfig;
  private isRunning = false;
  private pendingSells: Map<string, Promise<void>> = new Map();
  private knownTokens: Set<string> = new Set(); // Tokens currently being monitored
  private checkedTokens: Set<string> = new Set(); // All tokens that have been checked (prevents rechecking)
  private pollInterval: NodeJS.Timeout | null = null;

  constructor(config: BotConfig) {
    this.config = config;

    // Initialize components
    this.heliusClient = new HeliusWsClient({
      wsUrl: config.heliusWsUrl,
      rpcUrl: config.rpcUrl,
      walletAddress: config.walletAddress,
      onLiquidityRemoval: this.handleLiquidityRemoval.bind(this),
      onNewToken: this.handleNewToken.bind(this),
      onError: this.handleError.bind(this),
      onConnect: this.handleConnect.bind(this),
    });

    this.positionTracker = new PositionTracker({
      rpcUrl: config.rpcUrl,
      walletAddress: config.walletAddress,
    });

    this.seller = new ClmmSeller({
      rpcUrl: config.rpcUrl,
      heliusApiKey: config.heliusApiKey,
      privateKey: config.privateKey,
      defaultSlippageBps: config.defaultSlippageBps,
      priorityFeeMicroLamports: config.priorityFeeMicroLamports,
      computeUnits: config.computeUnits,
      tipLamports: config.tipLamports,
      confirmAfterSend: config.confirmAfterSend,
      blockhashRefreshMs: config.blockhashRefreshMs,
      tokenBalancePollFallbackMs: config.tokenBalancePollFallbackMs,
      staleBlockhashMs: config.staleBlockhashMs,
      staleTokenBalanceMs: config.staleTokenBalanceMs,
    });
  }

  /**
   * Start the bot
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[Bot] Already running');
      return;
    }

    console.log('[Bot] Starting Rug Defense Bot...');
    console.log(`[Bot] Wallet: ${this.config.walletAddress}`);

    // Initialize seller
    console.log('[Bot] Initializing seller...');
    await this.seller.initialize();
    
    // Start blockhash refresh loop for fast sells
    await this.seller.startBlockhashLoop();

    // Load existing positions from wallet
    console.log('[Bot] Loading existing positions...');
    await this.positionTracker.loadPositionsFromWallet();

    // Get positions
    const positions = this.positionTracker.getPositions();
    console.log(`[Bot] Found ${positions.length} positions`);

    // Track known tokens
    for (const position of positions) {
      this.knownTokens.add(position.tokenMint);
      this.checkedTokens.add(position.tokenMint);
    }

    // Connect to Helius WebSocket
    await this.heliusClient.connect();

    // Subscribe to wallet logs for immediate new token detection
    this.heliusClient.subscribeToWalletLogs(this.config.walletAddress);

    // For each position, get dev's token account and subscribe
    for (const position of positions) {
      await this.subscribeToDevTokenAccount(position);
    }

    // Start polling for new token buys (backup)
    this.startPollingForNewBuys();

    this.isRunning = true;
    console.log('[Bot] 🛡️ Rug Defense Bot is now active!');
  }

  /**
   * Handle new token detected from wallet logs (immediate detection)
   */
  private async handleNewToken(tokenMint: string, signature: string): Promise<void> {
    // Skip if already known or checked
    if (this.knownTokens.has(tokenMint) || this.checkedTokens.has(tokenMint)) {
      return;
    }

    console.log(`[Bot] 🆕 New token detected via WS: ${tokenMint.slice(0, 8)}... (sig: ${signature.slice(0, 8)}...)`);
    
    // Mark as checked to prevent re-processing
    this.checkedTokens.add(tokenMint);
    this.knownTokens.add(tokenMint);

    // Get user's token account for this mint
    const userTokenAccount = await this.heliusClient.getUserTokenAccount(
      this.config.walletAddress,
      tokenMint
    );

    if (!userTokenAccount) {
      console.warn(`[Bot] No token account found for ${tokenMint.slice(0, 8)}...`);
      return;
    }

    // Get balance
    const balance = await this.heliusClient.getTokenAccountBalance(userTokenAccount);
    const amount = BigInt(balance?.value?.amount || '0');

    if (amount <= 0n) {
      console.warn(`[Bot] Zero balance for ${tokenMint.slice(0, 8)}...`);
      return;
    }

    // Start monitoring this new position
    await this.handleNewBuy(tokenMint, amount, userTokenAccount);
  }

  /**
   * Start polling for new token buys (every 30 seconds)
   */
  private startPollingForNewBuys(): void {
    this.pollInterval = setInterval(async () => {
      await this.checkForNewBuys();
    }, 30000); // Poll every 30 seconds
  }

  /**
   * Check for new token buys by comparing wallet tokens
   * Also checks for sold positions and unsubscribes from monitoring
   */
  private async checkForNewBuys(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const tokenAccounts = await this.heliusClient.getWalletTokenAccounts(this.config.walletAddress);
      
      // Get current wallet tokens
      const currentTokens = new Set<string>();
      
      for (const account of tokenAccounts) {
        currentTokens.add(account.mint);
        
        // Skip if already checked (prevents rechecking)
        if (this.checkedTokens.has(account.mint)) continue;
        
        // Mark as checked
        this.checkedTokens.add(account.mint);
        
        // Skip SOL (native)
        if (account.mint === 'So11111111111111111111111111111111111111112') continue;
        
        // New token detected!
        console.log(`[Bot] 🆕 New token detected: ${account.mint.slice(0, 8)}...`);
        this.knownTokens.add(account.mint);
        
        // Trigger new buy handler with wallet token account
        const amount = BigInt(account.amount);
        if (amount > 0n) {
          await this.handleNewBuy(account.mint, amount, account.tokenAccount);
        }
      }
      
      // Check for sold positions (tokens we were monitoring but no longer have)
      for (const knownToken of this.knownTokens) {
        if (!currentTokens.has(knownToken)) {
          console.log(`[Bot] 📤 Position sold: ${knownToken.slice(0, 8)}...`);
          
          // Get position to find dev token account
          const position = this.positionTracker.getPosition(knownToken);
          if (position?.devTokenAccount) {
            // Unsubscribe from dev token account monitoring
            this.heliusClient.unsubscribeFromTokenAccount(position.devTokenAccount);
          }
          
          // Remove from tracking
          this.positionTracker.removePosition(knownToken);
          this.knownTokens.delete(knownToken);
          // Keep in checkedTokens to prevent rechecking
        }
      }
    } catch (error) {
      console.error('[Bot] Error checking for new buys - skipping sold position detection:', error);
    }
  }

  /**
   * Handle new token buy - set up monitoring
   */
  private async handleNewBuy(tokenMint: string, amount: bigint, walletTokenAccount?: string): Promise<void> {
    console.log(`[Bot] Setting up monitoring for new token: ${tokenMint.slice(0, 8)}...`);
    
    // Get dev address for this token
    const devAddress = await this.positionTracker.findTokenDev(tokenMint);
    if (!devAddress) {
      console.warn(`[Bot] Could not find dev for ${tokenMint.slice(0, 8)}...`);
      return;
    }

    // Add position with dev address and wallet token account
    await this.positionTracker.addPositionWithDev(tokenMint, devAddress, amount, 6, walletTokenAccount);
    
    const position = this.positionTracker.getPosition(tokenMint);
    if (position) {
      await this.subscribeToDevTokenAccount(position);
    }
  }

  /**
   * Subscribe to dev's token account for balance change detection
   * Also pre-fetches pool address and pool keys for instant sell on detection
   */
  private async subscribeToDevTokenAccount(position: TokenPosition): Promise<void> {
    // Get dev's token account via Helius HTTP RPC
    const devTokenAccount = await this.heliusClient.getDevTokenAccount(
      position.devAddress,
      position.tokenMint
    );

    if (devTokenAccount) {
      position.devTokenAccount = devTokenAccount;
      
      // Get user's token account for this mint and subscribe to balance changes
      if (!position.walletTokenAccount) {
        const userTokenAccount = await this.heliusClient.getUserTokenAccount(
          this.config.walletAddress,
          position.tokenMint
        );
        if (userTokenAccount) {
          position.walletTokenAccount = userTokenAccount;
          // Subscribe to balance changes for user's token account
          this.heliusClient.subscribeToUserTokenBalance(userTokenAccount);
        }
      } else {
        // Already have wallet token account, just subscribe to balance
        this.heliusClient.subscribeToUserTokenBalance(position.walletTokenAccount);
      }
      
      // Prepare emergency sell context for fast trigger
      if (position.walletTokenAccount && position.poolAddress) {
        try {
          const prepKey = await this.seller.prepareEmergencySell({
            inputMint: position.tokenMint,
            poolId: position.poolAddress,
            tokenAccount: position.walletTokenAccount,
          });
          position.prepKey = prepKey;
        } catch (error) {
          console.error(`[Bot] Failed to prepare sell context: ${error}`);
        }
      }
      
      this.heliusClient.subscribeToTokenAccount(devTokenAccount, position);
    } else {
      // Dev token account not found - token may already be rugged or has no liquidity
      
      // Mark as no liquidity so we don't try to sell
      position.hasLiquidity = false;
      
      // Remove from tracking since we can't monitor it
      this.knownTokens.delete(position.tokenMint);
      this.positionTracker.removePosition(position.tokenMint);
    }
  }

  /**
   * Handle liquidity removal event - TRIGGER SELL
   */
  private async handleLiquidityRemoval(tokenMint: string, _signature: string): Promise<void> {
    const position = this.positionTracker.getPosition(tokenMint);
    if (!position || !position.hasLiquidity) return;

    // Avoid duplicate sell attempts
    if (this.pendingSells.has(tokenMint)) {
      return;
    }

    // Start emergency sell
    const sellPromise = this.executeEmergencySell(position);
    this.pendingSells.set(tokenMint, sellPromise);

    try {
      await sellPromise;
    } finally {
      this.pendingSells.delete(tokenMint);
    }
  }

  /**
   * Execute emergency sell for a position
   */
  private async executeEmergencySell(position: TokenPosition): Promise<void> {
    // Need wallet token account and pool address for sell
    if (!position.walletTokenAccount) {
      console.error(`[Bot] ❌ No wallet token account`);
      this.positionTracker.markLiquidityRemoved(position.tokenMint);
      return;
    }

    if (!position.poolAddress) {
      console.error(`[Bot] ❌ No pool address`);
      this.positionTracker.markLiquidityRemoved(position.tokenMint);
      return;
    }

    // Use prepared context if available for fast trigger
    let result;
    if (position.prepKey) {
      result = await this.seller.emergencySellPrepared({
        prepKey: position.prepKey,
        sellPercent: 100,
        slippageBps: this.config.defaultSlippageBps,
        forceMinOutZero: true,
      });
    } else {
      // Fallback to legacy method (will auto-prepare)
      result = await this.seller.emergencySell({
        inputMint: position.tokenMint,
        poolId: position.poolAddress,
        tokenAccount: position.walletTokenAccount,
        sellPercent: 100,
        slippageBps: this.config.defaultSlippageBps,
        priorityFeeMicroLamports: this.config.priorityFeeMicroLamports,
        computeUnits: this.config.computeUnits,
        tipLamports: this.config.tipLamports,
        forceMinOutZero: true,
      });
    }

    // Unsubscribe after sell attempt (success or fail)
    if (position.devTokenAccount) {
      this.heliusClient.unsubscribeFromTokenAccount(position.devTokenAccount);
    }

    if (result.success) {
      console.log(`[Bot] ✅ ${result.txSignature}`);

      // Remove position from tracking
      this.positionTracker.removePosition(position.tokenMint);
      this.knownTokens.delete(position.tokenMint);
    } else {
      console.error(`[Bot] ❌ ${result.error}`);
      // Mark as liquidity removed so we don't try again
      this.positionTracker.markLiquidityRemoved(position.tokenMint);
    }
  }

  /**
   * Handle WebSocket connection
   */
  private handleConnect(): void {
    console.log('[Bot] Connected to Helius');
  }

  /**
   * Handle errors
   */
  private handleError(error: Error): void {
    console.error('[Bot] Error:', error.message);
  }

  /**
   * Stop the bot
   */
  stop(): void {
    console.log('[Bot] Stopping...');
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.seller.shutdown();
    this.heliusClient.disconnect();
    this.isRunning = false;
  }
}

// Main entry point
async function main() {
  // Validate environment variables
  const requiredEnvVars = ['HELIUS_WS_URL', 'MAINNET_ENDPOINT', 'PRIVATE_KEY', 'HELIUS_API_KEY'];
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
  }

  const walletAddress = process.env.WALLET_ADDRESS || '';

  if (!walletAddress) {
    throw new Error('WALLET_ADDRESS environment variable is required');
  }

  const bot = new RugDefenseBot({
    heliusWsUrl: process.env.HELIUS_WS_URL!,
    rpcUrl: process.env.MAINNET_ENDPOINT!,
    heliusApiKey: process.env.HELIUS_API_KEY!,
    walletAddress,
    privateKey: process.env.PRIVATE_KEY!,
    defaultSlippageBps: parseInt(process.env.DEFAULT_SLIPPAGE_BPS || '10000'),
    priorityFeeMicroLamports: parseInt(process.env.PRIORITY_FEE_MICRO_LAMPORTS || '500000'),
    computeUnits: parseInt(process.env.COMPUTE_UNITS || '1000000'),
    tipLamports: parseInt(process.env.TIP_LAMPORTS || '200000'),
    confirmAfterSend: process.env.CONFIRM_AFTER_SEND === 'true',
    blockhashRefreshMs: parseInt(process.env.BLOCKHASH_REFRESH_MS || '1500'),
    tokenBalancePollFallbackMs: parseInt(process.env.TOKEN_BALANCE_POLL_FALLBACK_MS || '10000'),
    staleBlockhashMs: parseInt(process.env.STALE_BLOCKHASH_MS || '10000'),
    staleTokenBalanceMs: parseInt(process.env.STALE_TOKEN_BALANCE_MS || '20000'),
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[Bot] Shutting down...');
    bot.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    bot.stop();
    process.exit(0);
  });

  // Start the bot
  await bot.start();
}

main().catch((error) => {
  console.error('[Bot] Fatal error:', error);
  process.exit(1);
});
