import "dotenv/config";
import { Connection, PublicKey, Commitment } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Raydium, PoolUtils } from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import { HeliusWsClient } from "./helius-client.js";
import { PositionTracker } from "./position-tracker.js";
import { ClmmSeller, PrecomputedSellContext } from "./clmm-seller.js";
import { TokenPosition } from "./types.js";

const DEFAULT_WSOL_MINT = "So11111111111111111111111111111111111111112";

interface BotConfig {
  heliusWsBaseUrl: string; // Base WS URL without API key
  heliusHttpBaseUrl: string; // Base HTTP URL without API key
  walletAddress: string;
  privateKey: string;

  // Helius plan: "free" or "paid"
  // - free: Each position gets its own API key (max 5 positions)
  // - paid: Single API key handles all positions
  heliusPlan: "free" | "paid";
  heliusApiKeys: string[]; // Array of API keys for free plan

  flashblockApiKey: string;
  flashblockUrl: string;
  flashblockBackupUrl?: string;
  heliusSenderUrl?: string; // Helius Sender endpoint for parallel broadcast

  defaultSlippageBps?: number;
  priorityFeeMicroLamports?: number;
  computeUnits?: number;
  tipLamports?: number;
  confirmAfterSend?: boolean;
  commitment?: Commitment;

  // Refresh intervals
  blockhashRefreshMs?: number;
  poolSnapshotRefreshMs?: number;
  lamportsBalanceRefreshMs?: number;
  tokenBalancePollMs?: number;

  // Stale thresholds
  staleBlockhashMs?: number;
  stalePoolSnapshotMs?: number;
  staleTokenBalanceMs?: number;
}

// Extended context with timers for continuous updates
interface MonitoredPosition {
  ctx: PrecomputedSellContext;
  poolSnapshotTimer?: NodeJS.Timeout;
  tokenBalanceTimer?: NodeJS.Timeout;
  poolRefreshInFlight?: boolean;
  tokenRefreshInFlight?: boolean;
  templateRefreshInFlight?: boolean;
  templateRefreshQueued?: boolean;
  heliusApiKeyIndex?: number; // Which API key is assigned to this position (for free plan)
}

/**
 * Main Rug Defense Bot
 *
 * Handles all pre-computation and monitoring:
 * - Blockhash refresh loop
 * - Pool snapshot refresh per position
 * - Lamports balance monitoring
 * - Token balance monitoring
 *
 * At trigger time, builds PrecomputedSellContext and calls ClmmSeller.emergencySell()
 */
class RugDefenseBot {
  private heliusClient: HeliusWsClient;
  private positionTracker: PositionTracker;
  private seller: ClmmSeller;
  private connection: Connection;
  private raydium: Awaited<ReturnType<typeof Raydium.load>> | null = null;
  private config: Required<BotConfig>;

  private isRunning = false;
  private pendingSells: Map<string, Promise<void>> = new Map();
  private knownTokens: Set<string> = new Set();
  private checkedTokens: Set<string> = new Set();
  private pollInterval: NodeJS.Timeout | null = null;

  // Global caches
  private blockhashCache: {
    blockhash: string;
    lastValidBlockHeight: number;
    updatedAt: number;
  } | null = null;
  private blockhashTimer: NodeJS.Timeout | null = null;
  private lamportsBalance: number = 0;
  private lamportsBalanceUpdatedAt: number = 0;
  private lamportsBalanceTimer: NodeJS.Timeout | null = null;
  private epochInfoCache: any = null;
  private epochInfoUpdatedAt: number = 0;
  private epochInfoTimer: NodeJS.Timeout | null = null;

  // Per-position pre-computed contexts (continuously updated)
  private monitoredPositions: Map<string, MonitoredPosition> = new Map();

  // API key assignment tracking (for free plan)
  private usedApiKeys: Set<number> = new Set(); // Indices of used API keys
  private positionToApiKey: Map<string, number> = new Map(); // tokenMint -> apiKeyIndex

  /**
   * Assign an available API key to a position.
   * Returns the index of the assigned key, or -1 if none available.
   */
  private assignApiKey(tokenMint: string): number {
    if (this.config.heliusPlan === "paid") {
      return 0; // Paid plan uses single key
    }

    // Find first available key
    for (let i = 0; i < this.config.heliusApiKeys.length; i++) {
      if (!this.usedApiKeys.has(i)) {
        this.usedApiKeys.add(i);
        this.positionToApiKey.set(tokenMint, i);
        console.log(`[Bot] Assigned API key #${i + 1} to ${tokenMint.slice(0, 8)}...`);
        return i;
      }
    }

    return -1; // No keys available
  }

  /**
   * Release an API key when a position is sold.
   */
  private releaseApiKey(tokenMint: string): void {
    const index = this.positionToApiKey.get(tokenMint);
    if (index !== undefined) {
      this.usedApiKeys.delete(index);
      this.positionToApiKey.delete(tokenMint);
      console.log(`[Bot] Released API key #${index + 1} from ${tokenMint.slice(0, 8)}...`);
    }
  }

  /**
   * Get the API key assigned to a position.
   */
  private getApiKeyForPosition(tokenMint: string): string | undefined {
    const index = this.positionToApiKey.get(tokenMint);
    if (index === undefined) return undefined;
    return this.config.heliusApiKeys[index];
  }

  /**
   * Check if we have capacity for a new position.
   * For free plan: must have unused API keys.
   */
  private hasCapacityForNewPosition(): boolean {
    if (this.config.heliusPlan === "paid") {
      return true; // Paid plan has no limit
    }
    return this.usedApiKeys.size < this.config.heliusApiKeys.length;
  }

  /**
   * Get HTTP RPC URL for a specific position (with its assigned API key).
   * For paid plan, uses the first API key.
   */
  private getHttpUrlForPosition(tokenMint: string): string {
    const apiKey = this.getApiKeyForPosition(tokenMint) || this.config.heliusApiKeys[0];
    if (!apiKey) {
      throw new Error("No API key available");
    }
    return `${this.config.heliusHttpBaseUrl}/?api-key=${apiKey}`;
  }

  /**
   * Get WS URL for a specific position (with its assigned API key).
   * For paid plan, uses the first API key.
   */
  private getWsUrlForPosition(tokenMint: string): string {
    const apiKey = this.getApiKeyForPosition(tokenMint) || this.config.heliusApiKeys[0];
    if (!apiKey) {
      throw new Error("No API key available");
    }
    return `${this.config.heliusWsBaseUrl}/?api-key=${apiKey}`;
  }

  /**
   * Get HTTP URL using first API key (for general operations before positions are assigned).
   */
  private getInitialHttpUrl(): string {
    const apiKey = this.config.heliusApiKeys[0];
    if (!apiKey) {
      throw new Error("No API key available");
    }
    return `${this.config.heliusHttpBaseUrl}/?api-key=${apiKey}`;
  }

  constructor(config: BotConfig) {
    this.config = {
      ...config,
      defaultSlippageBps: config.defaultSlippageBps ?? 10_000,
      priorityFeeMicroLamports: config.priorityFeeMicroLamports ?? 200_000,
      computeUnits: config.computeUnits ?? 1_000_000,
      tipLamports: config.tipLamports ?? 200_000,
      confirmAfterSend: config.confirmAfterSend ?? false,
      commitment: config.commitment ?? "processed",
      blockhashRefreshMs: config.blockhashRefreshMs ?? 1_500,
      poolSnapshotRefreshMs: config.poolSnapshotRefreshMs ?? 10_000,
      lamportsBalanceRefreshMs: config.lamportsBalanceRefreshMs ?? 15_000,
      tokenBalancePollMs: config.tokenBalancePollMs ?? 60_000,
      staleBlockhashMs: config.staleBlockhashMs ?? 10_000,
      stalePoolSnapshotMs: config.stalePoolSnapshotMs ?? 15_000,
      staleTokenBalanceMs: config.staleTokenBalanceMs ?? 90_000,
      flashblockBackupUrl: config.flashblockBackupUrl ?? "",
      heliusSenderUrl: config.heliusSenderUrl ?? "",
    };

    // Build initial HTTP URL with first API key
    const initialHttpUrl = this.getInitialHttpUrl();
    this.connection = new Connection(initialHttpUrl, this.config.commitment);

    // Build initial WS URL with first API key
    const initialWsUrl = `${config.heliusWsBaseUrl}/?api-key=${config.heliusApiKeys[0] || ""}`;

    this.heliusClient = new HeliusWsClient({
      wsUrl: initialWsUrl,
      rpcUrl: initialHttpUrl,
      walletAddress: config.walletAddress,
      onLiquidityRemoval: this.handleLiquidityRemoval.bind(this),
      onNewToken: this.handleNewToken.bind(this),
      onUserTokenBalanceChange: this.handleUserTokenBalanceChange.bind(this),
      onError: this.handleError.bind(this),
      onConnect: this.handleConnect.bind(this),
    });

    this.positionTracker = new PositionTracker({
      rpcUrl: initialHttpUrl,
      walletAddress: config.walletAddress,
      heliusApiKeys: config.heliusApiKeys,
    });

    this.seller = new ClmmSeller({
      rpcUrl: initialHttpUrl,
      privateKey: config.privateKey,
      flashblockApiKey: config.flashblockApiKey,
      flashblockUrl: config.flashblockUrl,
      flashblockBackupUrl: config.flashblockBackupUrl,
      heliusSenderUrl: config.heliusSenderUrl,
      defaultSlippageBps: this.config.defaultSlippageBps,
      priorityFeeMicroLamports: this.config.priorityFeeMicroLamports,
      computeUnits: this.config.computeUnits,
      tipLamports: this.config.tipLamports,
      confirmAfterSend: this.config.confirmAfterSend,
      commitment: this.config.commitment,
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log("[Bot] Already running");
      return;
    }

    console.log("[Bot] Starting Rug Defense Bot...");
    console.log(`[Bot] Wallet: ${this.config.walletAddress}`);

    // Initialize Raydium
    console.log("[Bot] Initializing Raydium...");
    await this.initializeRaydium();

    // Initialize seller
    console.log("[Bot] Initializing seller...");
    await this.seller.initialize();

    // Start global refresh loops
    await this.startBlockhashLoop();
    await this.startEpochInfoLoop();
    await this.startLamportsBalanceLoop();

    // Load existing positions
    console.log("[Bot] Loading existing positions...");
    await this.positionTracker.loadPositionsFromWallet();

    const positions = this.positionTracker.getPositions();
    console.log(`[Bot] Found ${positions.length} positions`);

    for (const position of positions) {
      this.knownTokens.add(position.tokenMint);
      this.checkedTokens.add(position.tokenMint);
    }

    // Connect to Helius WebSocket
    await this.heliusClient.connect();
    this.heliusClient.subscribeToWalletLogs(this.config.walletAddress);

    // Set up monitoring for each position with API key assignment
    for (const position of positions) {
      // Check if we have capacity for this position
      if (!this.hasCapacityForNewPosition()) {
        console.warn(
          `[Bot] ⚠️ No API keys available for existing position ${position.tokenMint.slice(0, 8)}... - NOT monitoring`,
        );
        continue;
      }

      // Get dev token account to verify CLMM pool
      const devTokenAccount = await this.heliusClient.getDevTokenAccount(
        position.devAddress,
        position.tokenMint,
      );

      if (!devTokenAccount) {
        console.log(`[Bot] No CLMM pool for existing position ${position.tokenMint.slice(0, 8)}... - skipping`);
        continue;
      }

      // Assign API key to this position
      const keyIndex = this.assignApiKey(position.tokenMint);
      if (keyIndex < 0) {
        console.warn(`[Bot] ⚠️ Failed to assign API key to existing position ${position.tokenMint.slice(0, 8)}...`);
        continue;
      }

      position.devTokenAccount = devTokenAccount;

      // Get pool address if not already set
      if (!position.poolAddress) {
        const poolAddress = await this.heliusClient.getPoolFromDevTokenAccount(devTokenAccount);
        if (poolAddress) {
          position.poolAddress = poolAddress;
          console.log(`[Bot] Found pool for ${position.tokenMint.slice(0, 8)}...: ${poolAddress.slice(0, 12)}...`);
        }
      }

      // Get user token account if not already set
      if (!position.walletTokenAccount) {
        const userTokenAccount = await this.heliusClient.getUserTokenAccount(
          this.config.walletAddress,
          position.tokenMint,
        );
        if (userTokenAccount) {
          position.walletTokenAccount = userTokenAccount;
        }
      }

      // Start monitoring if we have all required data
      if (position.walletTokenAccount && position.poolAddress) {
        await this.startPositionMonitoring(position);

        // Use dev token account for fast-detection via logsSubscribe
        // Any transaction mentioning the dev's token account = rug detected
        position.fastDetectionAccount = devTokenAccount;
        this.heliusClient.subscribeToFastDetectionAccount(devTokenAccount, position);
        console.log(`[Bot] Using dev token account for fast-detection: ${devTokenAccount.slice(0, 12)}...`);
      } else {
        console.warn(
          `[Bot] Cannot monitor existing position ${position.tokenMint.slice(0, 8)}... - missing data`,
        );
        this.releaseApiKey(position.tokenMint);
      }
    }

    // Start polling for new token buys
    this.startPollingForNewBuys();

    this.isRunning = true;
    console.log("[Bot] 🛡️ Rug Defense Bot is now active!");
  }

  private async initializeRaydium(): Promise<void> {
    if (this.raydium) return;

    const owner = new PublicKey(this.config.walletAddress);

    const tokenAccountResp = await this.connection.getTokenAccountsByOwner(
      owner,
      {
        programId: TOKEN_PROGRAM_ID,
      },
    );

    const token2022Resp = await this.connection.getTokenAccountsByOwner(owner, {
      programId: TOKEN_2022_PROGRAM_ID,
    });

    const { parseTokenAccountResp } =
      await import("@raydium-io/raydium-sdk-v2");

    const tokenAccountData = parseTokenAccountResp({
      owner,
      solAccountResp: null,
      tokenAccountResp: {
        context: tokenAccountResp.context,
        value: [...tokenAccountResp.value, ...token2022Resp.value],
      },
    });

    const { Keypair } = await import("@solana/web3.js");
    const bs58 = (await import("bs58")).default;
    const ownerKeypair = Keypair.fromSecretKey(
      bs58.decode(this.config.privateKey),
    );

    this.raydium = await Raydium.load({
      connection: this.connection,
      owner: ownerKeypair,
      tokenAccounts: tokenAccountData.tokenAccounts,
      tokenAccountRawInfos: tokenAccountData.tokenAccountRawInfos,
      disableLoadToken: true,
    });

    console.log("[Bot] Raydium initialized");
  }

  // === Global Refresh Loops ===

  private async startBlockhashLoop(): Promise<void> {
    const refresh = async () => {
      try {
        const latest = await this.connection.getLatestBlockhash(
          this.config.commitment,
        );
        this.blockhashCache = {
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
          updatedAt: Date.now(),
        };
      } catch (error) {
        console.error("[Bot] Blockhash refresh failed:", error);
      }
    };

    await refresh();
    this.blockhashTimer = setInterval(refresh, this.config.blockhashRefreshMs);
    console.log(
      `[Bot] Blockhash loop started (${this.config.blockhashRefreshMs}ms)`,
    );
  }

  private async startLamportsBalanceLoop(): Promise<void> {
    const refresh = async () => {
      try {
        this.lamportsBalance = await this.connection.getBalance(
          new PublicKey(this.config.walletAddress),
          this.config.commitment,
        );
        this.lamportsBalanceUpdatedAt = Date.now();
      } catch (error) {
        console.error("[Bot] Lamports balance refresh failed:", error);
      }
    };

    await refresh();
    this.lamportsBalanceTimer = setInterval(
      refresh,
      this.config.lamportsBalanceRefreshMs,
    );
    console.log(
      `[Bot] Lamports balance loop started (${this.config.lamportsBalanceRefreshMs}ms)`,
    );
  }

  private async startEpochInfoLoop(): Promise<void> {
    const refresh = async () => {
      try {
        if (!this.raydium) return;
        this.epochInfoCache = await this.raydium.fetchEpochInfo();
        this.epochInfoUpdatedAt = Date.now();
      } catch (error) {
        console.error("[Bot] Epoch info refresh failed:", error);
      }
    };

    await refresh();
    this.epochInfoTimer = setInterval(refresh, 15000);
    console.log("[Bot] Epoch info loop started (15000ms)");
  }

  // === Per-Position Monitoring ===

  private async startPositionMonitoring(
    position: TokenPosition,
  ): Promise<void> {
    if (!position.poolAddress || !position.walletTokenAccount) return;

    // Initialize PrecomputedSellContext
    const ctx: PrecomputedSellContext = {
      poolId: position.poolAddress,
      inputMint: position.tokenMint,
      tokenAccount: position.walletTokenAccount,

      // Token balance (updated by refresh loop)
      tokenAmountRaw: 0n,

      // Pool snapshot (updated by refresh loop)
      poolInfo: null as any,
      poolKeys: null as any,
      computePoolInfo: null as any,
      tickData: null as any,
      epochInfo: null as any,

      // Precomputed (set on first pool fetch)
      inputIsMintA: false,
      tokenOut: null,

      // SOL balance and blockhash (updated by global loops)
      lamportsBalance: this.lamportsBalance,
      blockhash: this.blockhashCache?.blockhash ?? "",
      lastValidBlockHeight: this.blockhashCache?.lastValidBlockHeight ?? 0,

      // Execution params
      priorityFeeMicroLamports: this.config.priorityFeeMicroLamports,
      computeUnits: this.config.computeUnits,
      tipLamports: this.config.tipLamports,
    };

    const monitored: MonitoredPosition = { ctx };

    // Run initial fetches in parallel to reduce time until position is protected
    await Promise.all([
      this.refreshPoolSnapshot(position.poolAddress, monitored),
      this.refreshTokenBalance(position.walletTokenAccount, monitored),
    ]);

    // Start pool snapshot refresh with jitter to spread requests
    const poolJitter = Math.floor(Math.random() * 1000);
    monitored.poolSnapshotTimer = setInterval(
      () => this.refreshPoolSnapshot(position.poolAddress!, monitored),
      this.config.poolSnapshotRefreshMs + poolJitter,
    );

    // Start token balance polling with jitter
    const tokenJitter = Math.floor(Math.random() * 2000);
    monitored.tokenBalanceTimer = setInterval(
      () => this.refreshTokenBalance(position.walletTokenAccount!, monitored),
      this.config.tokenBalancePollMs + tokenJitter,
    );

    this.monitoredPositions.set(position.tokenMint, monitored);
  }

  private async refreshPoolSnapshot(
    poolId: string,
    monitored: MonitoredPosition,
  ): Promise<void> {
    if (!this.raydium) return;
    if (monitored.poolRefreshInFlight) return;

    monitored.poolRefreshInFlight = true;

    try {
      const { poolInfo, poolKeys, computePoolInfo, tickData } =
        await this.raydium.clmm.getPoolInfoFromRpc(poolId);

      const ctx = monitored.ctx;
      ctx.poolInfo = poolInfo;
      ctx.poolKeys = poolKeys;
      ctx.computePoolInfo = computePoolInfo;
      ctx.tickData = tickData;
      ctx.epochInfo = this.epochInfoCache;
      ctx.poolSnapshotUpdatedAt = Date.now();

      // Precompute inputIsMintA and tokenOut on first fetch
      if (!ctx.tokenOut) {
        const mintA = poolInfo.mintA.address;
        const mintB = poolInfo.mintB.address;
        ctx.inputIsMintA = ctx.inputMint === mintA;
        ctx.tokenOut = ctx.inputIsMintA ? poolInfo.mintB : poolInfo.mintA;
      }

      // Also update blockhash and lamports in context
      if (this.blockhashCache) {
        monitored.ctx.blockhash = this.blockhashCache.blockhash;
        monitored.ctx.lastValidBlockHeight = this.blockhashCache.lastValidBlockHeight;
        monitored.ctx.blockhashUpdatedAt = this.blockhashCache.updatedAt;
      }
      monitored.ctx.lamportsBalance = this.lamportsBalance;

      this.maybeRefreshSellTemplate(monitored);
    } catch (error) {
      console.error(
        `[Bot] Pool snapshot refresh failed for ${poolId.slice(0, 8)}...:`,
        error,
      );
    } finally {
      monitored.poolRefreshInFlight = false;
    }
  }

  private async refreshTokenBalance(
    tokenAccount: string,
    monitored: MonitoredPosition,
  ): Promise<void> {
    if (monitored.tokenRefreshInFlight) return;

    monitored.tokenRefreshInFlight = true;

    try {
      const cached = this.heliusClient.getCachedBalance(tokenAccount);
      if (cached !== undefined) {
        monitored.ctx.tokenAmountRaw = cached;
        monitored.ctx.tokenBalanceUpdatedAt = Date.now();
      } else {
        const balance =
          await this.heliusClient.getTokenAccountBalance(tokenAccount);
        monitored.ctx.tokenAmountRaw = BigInt(balance?.value?.amount || "0");
        monitored.ctx.tokenBalanceUpdatedAt = Date.now();
      }

      if (this.blockhashCache) {
        monitored.ctx.blockhash = this.blockhashCache.blockhash;
        monitored.ctx.lastValidBlockHeight =
          this.blockhashCache.lastValidBlockHeight;
        monitored.ctx.blockhashUpdatedAt = this.blockhashCache.updatedAt;
      }
      monitored.ctx.lamportsBalance = this.lamportsBalance;

      this.maybeRefreshSellTemplate(monitored);
    } catch (error) {
      console.error(
        `[Bot] Token balance refresh failed for ${tokenAccount.slice(0, 8)}...:`,
        error,
      );
    } finally {
      monitored.tokenRefreshInFlight = false;
    }
  }

  private maybeRefreshSellTemplate(monitored: MonitoredPosition): void {
    if (monitored.templateRefreshInFlight) {
      monitored.templateRefreshQueued = true;
      return;
    }

    const ctx = monitored.ctx;
    if (
      !ctx.poolInfo ||
      !ctx.computePoolInfo ||
      !ctx.tickData ||
      !ctx.epochInfo
    )
      return;
    if (!ctx.tokenOut) return;
    if (!ctx.blockhash) return;
    if (ctx.tokenAmountRaw <= 0n) return;

    monitored.templateRefreshInFlight = true;

    void this.seller
      .prepareSellTemplate({
        ctx,
        sellPercent: 100,
        slippageBps: this.config.defaultSlippageBps,
        forceMinOutZero: true,
      })
      .catch((error) => {
        console.error("[Bot] Template refresh failed:", error);
      })
      .finally(() => {
        monitored.templateRefreshInFlight = false;
        if (monitored.templateRefreshQueued) {
          monitored.templateRefreshQueued = false;
          this.maybeRefreshSellTemplate(monitored);
        }
      });
  }

  private handleUserTokenBalanceChange(
    tokenAccount: string,
    amount: bigint,
  ): void {
    for (const monitored of this.monitoredPositions.values()) {
      if (monitored.ctx.tokenAccount === tokenAccount) {
        monitored.ctx.tokenAmountRaw = amount;
        monitored.ctx.tokenBalanceUpdatedAt = Date.now();
        this.maybeRefreshSellTemplate(monitored);
        break;
      }
    }
  }

  private stopPositionMonitoring(tokenMint: string): void {
    const monitored = this.monitoredPositions.get(tokenMint);
    if (!monitored) return;

    if (monitored.poolSnapshotTimer) clearInterval(monitored.poolSnapshotTimer);
    if (monitored.tokenBalanceTimer) clearInterval(monitored.tokenBalanceTimer);

    // Release the API key assigned to this position
    this.releaseApiKey(tokenMint);

    this.monitoredPositions.delete(tokenMint);
  }

  // === Event Handlers ===

  private async handleNewToken(
    tokenMint: string,
    signature: string,
  ): Promise<void> {
    if (this.knownTokens.has(tokenMint) || this.checkedTokens.has(tokenMint))
      return;

    console.log(
      `[Bot] 🆕 New token: ${tokenMint.slice(0, 8)}... (sig: ${signature.slice(0, 8)}...)`,
    );

    this.checkedTokens.add(tokenMint);
    this.knownTokens.add(tokenMint);

    const userTokenAccount = await this.heliusClient.getUserTokenAccount(
      this.config.walletAddress,
      tokenMint,
    );

    if (!userTokenAccount) {
      console.warn(`[Bot] No token account for ${tokenMint.slice(0, 8)}...`);
      return;
    }

    const balance =
      await this.heliusClient.getTokenAccountBalance(userTokenAccount);
    const amount = BigInt(balance?.value?.amount || "0");

    if (amount <= 0n) {
      console.warn(`[Bot] Zero balance for ${tokenMint.slice(0, 8)}...`);
      return;
    }

    await this.handleNewBuy(tokenMint, amount, userTokenAccount);
  }

  private isPolling = false;

  private startPollingForNewBuys(): void {
    this.pollInterval = setInterval(async () => {
      if (this.isPolling) return;

      this.isPolling = true;
      try {
        await this.checkForNewBuys();
      } finally {
        this.isPolling = false;
      }
    }, 2000);
  }

  private async checkForNewBuys(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const tokenAccounts = await this.heliusClient.getWalletTokenAccounts(
        this.config.walletAddress,
      );
      const currentTokens = new Set<string>();

      for (const account of tokenAccounts) {
        currentTokens.add(account.mint);

        if (this.checkedTokens.has(account.mint)) continue;
        this.checkedTokens.add(account.mint);

        if (account.mint === DEFAULT_WSOL_MINT) continue;

        console.log(
          `[Bot] 🆕 New token detected: ${account.mint.slice(0, 8)}...`,
        );
        this.knownTokens.add(account.mint);

        const amount = BigInt(account.amount);
        if (amount > 0n) {
          await this.handleNewBuy(account.mint, amount, account.tokenAccount);
        }
      }

      // Check for sold positions
      for (const knownToken of this.knownTokens) {
        if (!currentTokens.has(knownToken)) {
          console.log(`[Bot] 📤 Position sold: ${knownToken.slice(0, 8)}...`);

          const position = this.positionTracker.getPosition(knownToken);
          if (position?.devTokenAccount) {
            this.heliusClient.unsubscribeFromTokenAccount(
              position.devTokenAccount,
            );
          }

          this.stopPositionMonitoring(knownToken);
          this.positionTracker.removePosition(knownToken);
          this.knownTokens.delete(knownToken);
        }
      }
    } catch (error) {
      console.error("[Bot] Error checking for new buys:", error);
    }
  }

  private async handleNewBuy(
    tokenMint: string,
    amount: bigint,
    walletTokenAccount?: string,
  ): Promise<void> {
    console.log(`[Bot] Setting up monitoring for: ${tokenMint.slice(0, 8)}...`);

    // First, find dev address using temporary API key (round-robin in tracker)
    const devAddress = await this.positionTracker.findTokenDev(tokenMint);
    if (!devAddress) {
      console.warn(`[Bot] Could not find dev for ${tokenMint.slice(0, 8)}... - skipping`);
      return;
    }

    // Check if we have capacity for a new position (free plan limit)
    if (!this.hasCapacityForNewPosition()) {
      console.warn(
        `[Bot] ⚠️ No API keys available for ${tokenMint.slice(0, 8)}... - NOT monitoring (free plan limit reached)`,
      );
      console.warn(
        `[Bot] Position will not be rug-protected. Consider upgrading to paid plan or selling manually.`,
      );
      return;
    }

    // Temporarily add position to check for CLMM pool
    await this.positionTracker.addPositionWithDev(
      tokenMint,
      devAddress,
      amount,
      6,
      walletTokenAccount,
    );

    const position = this.positionTracker.getPosition(tokenMint);
    if (!position) {
      console.warn(`[Bot] Failed to create position for ${tokenMint.slice(0, 8)}...`);
      return;
    }

    // Check if this token has a CLMM pool (uses temporary API key from heliusClient)
    const devTokenAccount = await this.heliusClient.getDevTokenAccount(
      position.devAddress,
      position.tokenMint,
    );

    if (!devTokenAccount) {
      console.log(`[Bot] No CLMM pool found for ${tokenMint.slice(0, 8)}... - skipping (not a CLMM token)`);
      this.positionTracker.removePosition(tokenMint);
      return;
    }

    // Found CLMM pool - now assign API key permanently
    const keyIndex = this.assignApiKey(tokenMint);
    if (keyIndex < 0) {
      console.warn(
        `[Bot] ⚠️ Failed to assign API key to ${tokenMint.slice(0, 8)}... - NOT monitoring`,
      );
      this.positionTracker.removePosition(tokenMint);
      return;
    }

    // Continue with monitoring setup
    position.devTokenAccount = devTokenAccount;

    // Fetch pool address from dev token account's CLOSE_ACCOUNT transaction
    const poolAddress = await this.heliusClient.getPoolFromDevTokenAccount(devTokenAccount);
    if (poolAddress) {
      position.poolAddress = poolAddress;
      console.log(
        `[Bot] Found pool for ${position.tokenMint.slice(0, 8)}...: ${poolAddress.slice(0, 12)}...`,
      );
    } else {
      console.warn(
        `[Bot] Could not find pool for ${position.tokenMint.slice(0, 8)}... - skipping`,
      );
      this.releaseApiKey(tokenMint);
      this.positionTracker.removePosition(tokenMint);
      return;
    }

    // Get user's token account for this mint
    if (!position.walletTokenAccount) {
      const userTokenAccount = await this.heliusClient.getUserTokenAccount(
        this.config.walletAddress,
        position.tokenMint,
      );
      if (userTokenAccount) {
        position.walletTokenAccount = userTokenAccount;
      }
    }

    // Start monitoring for this position if we have all required data
    if (position.walletTokenAccount && position.poolAddress) {
      // Refresh Raydium's token accounts so it knows about the new token
      await this.seller.refreshTokenAccounts();
      await this.startPositionMonitoring(position);

      // Use dev token account for fast-detection via logsSubscribe
      // Any transaction mentioning the dev's token account = rug detected
      position.fastDetectionAccount = devTokenAccount;
      this.heliusClient.subscribeToFastDetectionAccount(devTokenAccount, position);
      console.log(`[Bot] Using dev token account for fast-detection: ${devTokenAccount.slice(0, 12)}...`);
    } else {
      console.warn(
        `[Bot] Cannot start monitoring - missing pool or wallet account for ${position.tokenMint.slice(0, 8)}...`,
      );
      this.releaseApiKey(tokenMint);
      this.positionTracker.removePosition(tokenMint);
      return;
    }
  }

  private async subscribeToDevTokenAccount(
    position: TokenPosition,
  ): Promise<void> {
    const devTokenAccount = await this.heliusClient.getDevTokenAccount(
      position.devAddress,
      position.tokenMint,
    );

    if (devTokenAccount) {
      position.devTokenAccount = devTokenAccount;

      // Fetch pool address from dev token account's CLOSE_ACCOUNT transaction
      if (!position.poolAddress) {
        const poolAddress =
          await this.heliusClient.getPoolFromDevTokenAccount(devTokenAccount);
        if (poolAddress) {
          position.poolAddress = poolAddress;
          console.log(
            `[Bot] Found pool for ${position.tokenMint.slice(0, 8)}...: ${poolAddress.slice(0, 12)}...`,
          );
        } else {
          console.warn(
            `[Bot] Could not find pool for ${position.tokenMint.slice(0, 8)}...`,
          );
        }
      }

      // Get user's token account for this mint
      if (!position.walletTokenAccount) {
        const userTokenAccount = await this.heliusClient.getUserTokenAccount(
          this.config.walletAddress,
          position.tokenMint,
        );
        if (userTokenAccount) {
          position.walletTokenAccount = userTokenAccount;
        }
      }

      // Start monitoring for this position if we have all required data
      if (position.walletTokenAccount && position.poolAddress) {
        await this.startPositionMonitoring(position);

        // Use dev token account for fast-detection via logsSubscribe
        // Any transaction mentioning the dev's token account = rug detected
        position.fastDetectionAccount = devTokenAccount;
        this.heliusClient.subscribeToFastDetectionAccount(devTokenAccount, position);
        console.log(`[Bot] Using dev token account for fast-detection: ${devTokenAccount.slice(0, 12)}...`);
      } else {
        console.warn(
          `[Bot] Cannot start monitoring - missing pool or wallet account for ${position.tokenMint.slice(0, 8)}...`,
        );
      }
    } else {
      console.warn(
        `[Bot] ⚠️  No dev token account for ${position.tokenMint.slice(0, 8)}... - cannot monitor`,
      );
      position.hasLiquidity = false;
    }
  }

  private async handleLiquidityRemoval(
    tokenMint: string,
    _signature: string,
  ): Promise<void> {
    const position = this.positionTracker.getPosition(tokenMint);
    if (!position || !position.hasLiquidity) return;

    if (this.pendingSells.has(tokenMint)) return;

    const sellPromise = this.executeEmergencySell(position);
    this.pendingSells.set(tokenMint, sellPromise);

    try {
      await sellPromise;
    } finally {
      this.pendingSells.delete(tokenMint);
    }
  }

  /**
   * Execute sell using pre-built PrecomputedSellContext
   * Context is continuously updated by refresh loops
   */
  private async executeEmergencySell(position: TokenPosition): Promise<void> {
    if (!position.walletTokenAccount || !position.poolAddress) {
      console.error("[Bot] ❌ Missing wallet token account or pool address");
      this.positionTracker.markLiquidityRemoved(position.tokenMint);
      return;
    }

    // Get pre-built context (continuously updated by refresh loops)
    const monitored = this.monitoredPositions.get(position.tokenMint);

    if (!monitored || !monitored.ctx.poolInfo) {
      console.error("[Bot] ❌ No pre-computed context for this position");
      this.positionTracker.markLiquidityRemoved(position.tokenMint);
      return;
    }

    // Check for stale data
    const now = Date.now();
    const ctx = monitored.ctx;

    if (
      ctx.poolSnapshotUpdatedAt &&
      now - ctx.poolSnapshotUpdatedAt > this.config.stalePoolSnapshotMs
    ) {
      console.warn(
        `[Bot] ⚠️ Pool snapshot is stale (${Math.round((now - ctx.poolSnapshotUpdatedAt) / 1000)}s old)`,
      );
    }

    if (
      ctx.tokenBalanceUpdatedAt &&
      now - ctx.tokenBalanceUpdatedAt > this.config.staleTokenBalanceMs
    ) {
      console.warn(
        `[Bot] ⚠️ Token balance is stale (${Math.round((now - ctx.tokenBalanceUpdatedAt) / 1000)}s old)`,
      );
    }

    if (
      ctx.blockhashUpdatedAt &&
      now - ctx.blockhashUpdatedAt > this.config.staleBlockhashMs
    ) {
      console.warn(
        `[Bot] ⚠️ Blockhash is stale (${Math.round((now - ctx.blockhashUpdatedAt) / 1000)}s old)`,
      );
    }

    // Execute sell - pass the pre-built context directly
    const result = await this.seller.emergencySell({
      ctx: monitored.ctx,
      sellPercent: 100,
      slippageBps: this.config.defaultSlippageBps,
      forceMinOutZero: true,
      confirmAfterSend: this.config.confirmAfterSend,
    });

    // Cleanup
    if (position.devTokenAccount) {
      this.heliusClient.unsubscribeFromTokenAccount(position.devTokenAccount, position.tokenMint);
    }

    this.stopPositionMonitoring(position.tokenMint);

    if (result.success) {
      console.log(`[Bot] ✅ ${result.txSignature}`);
      this.positionTracker.removePosition(position.tokenMint);
      this.knownTokens.delete(position.tokenMint);
    } else {
      console.error(`[Bot] ❌ ${result.error}`);
      this.positionTracker.markLiquidityRemoved(position.tokenMint);
    }
  }

  private handleConnect(): void {
    console.log("[Bot] Connected to Helius");
  }

  private handleError(error: Error): void {
    console.error("[Bot] Error:", error.message);
  }

  stop(): void {
    console.log("[Bot] Stopping...");

    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.blockhashTimer) clearInterval(this.blockhashTimer);
    if (this.lamportsBalanceTimer) clearInterval(this.lamportsBalanceTimer);

    // Stop all position monitoring
    for (const tokenMint of this.monitoredPositions.keys()) {
      this.stopPositionMonitoring(tokenMint);
    }

    this.heliusClient.disconnect();
    this.isRunning = false;
    console.log("[Bot] Stopped");
  }
}

// Main entry point
async function main() {
  const requiredEnvVars = [
    "HELIUS_WS_BASE_URL",
    "HELIUS_HTTP_BASE_URL",
    "PRIVATE_KEY",
    "FLASHBLOCK_API_KEY",
    "FLASHBLOCK_URL",
    "HELIUS_PLAN",
  ];
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
  }

  const walletAddress = process.env.WALLET_ADDRESS || "";
  if (!walletAddress) {
    throw new Error("WALLET_ADDRESS environment variable is required");
  }

  const heliusPlan = (process.env.HELIUS_PLAN || "free") as "free" | "paid";

  // Parse API keys from environment
  const heliusApiKeys: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const key = process.env[`HELIUS_API_KEY_${i}`];
    if (key && key !== `your_${["second", "third", "fourth", "fifth"][i - 1] || "first"}_helius_api_key_here`) {
      heliusApiKeys.push(key);
    }
  }

  if (heliusPlan === "free" && heliusApiKeys.length === 0) {
    throw new Error("HELIUS_PLAN=free requires at least one HELIUS_API_KEY_N to be set");
  }

  console.log(`[Bot] Helius plan: ${heliusPlan}, API keys available: ${heliusApiKeys.length}`);

  const bot = new RugDefenseBot({
    heliusWsBaseUrl: process.env.HELIUS_WS_BASE_URL!,
    heliusHttpBaseUrl: process.env.HELIUS_HTTP_BASE_URL!,
    walletAddress,
    privateKey: process.env.PRIVATE_KEY!,
    heliusPlan,
    heliusApiKeys,
    flashblockApiKey: process.env.FLASHBLOCK_API_KEY!,
    flashblockUrl: process.env.FLASHBLOCK_URL!,
    flashblockBackupUrl: process.env.FLASHBLOCK_BACKUP_URL,
    heliusSenderUrl: process.env.HELIUS_SENDER_URL,
    defaultSlippageBps: parseInt(process.env.DEFAULT_SLIPPAGE_BPS || "10000"),
    priorityFeeMicroLamports: parseInt(
      process.env.PRIORITY_FEE_MICRO_LAMPORTS || "120000",
    ),
    computeUnits: parseInt(process.env.COMPUTE_UNITS || "1000000"),
    tipLamports: parseInt(process.env.TIP_LAMPORTS || "200000"),
    confirmAfterSend: process.env.CONFIRM_AFTER_SEND === "true",
    blockhashRefreshMs: parseInt(process.env.BLOCKHASH_REFRESH_MS || "1500"),
    poolSnapshotRefreshMs: parseInt(
      process.env.POOL_SNAPSHOT_REFRESH_MS || "10000",
    ),
    lamportsBalanceRefreshMs: parseInt(
      process.env.LAMPORTS_BALANCE_REFRESH_MS || "15000",
    ),
    tokenBalancePollMs: parseInt(process.env.TOKEN_BALANCE_POLL_MS || "60000"),
    staleBlockhashMs: parseInt(process.env.STALE_BLOCKHASH_MS || "10000"),
    stalePoolSnapshotMs: parseInt(
      process.env.STALE_POOL_SNAPSHOT_MS || "15000",
    ),
    staleTokenBalanceMs: parseInt(
      process.env.STALE_TOKEN_BALANCE_MS || "90000",
    ),
  });

  process.on("SIGINT", () => {
    console.log("\n[Bot] Shutting down...");
    bot.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    bot.stop();
    process.exit(0);
  });

  await bot.start();
}

main().catch((error) => {
  console.error("[Bot] Fatal error:", error);
  process.exit(1);
});
