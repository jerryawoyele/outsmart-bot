import axios from "axios";
import bs58 from "bs58";
import BN from "bn.js";
import {
  Commitment,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackAccount,
} from "@solana/spl-token";
import {
  Raydium,
  TxVersion,
  parseTokenAccountResp,
  PoolUtils,
} from "@raydium-io/raydium-sdk-v2";

// Helius tip wallets
const HELIUS_TIP_WALLETS = [
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "D1Mc6j9xQWgR1o1Z7yU5nVVXFQiAYx7FG9AW1aVfwrUM",
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
];

const DEFAULT_WSOL_MINT = "So11111111111111111111111111111111111111112";
const MIN_TIP_LAMPORTS = 200_000;

type HeliusSenderResp = {
  jsonrpc: string;
  id: string | number;
  result?: string;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export interface ClmmSellerConfig {
  rpcUrl: string;
  heliusApiKey: string;
  privateKey: string;

  // execution
  defaultSlippageBps?: number;
  priorityFeeMicroLamports?: number;
  computeUnits?: number;
  confirmAfterSend?: boolean;
  tipLamports?: number;

  // refresh loops
  commitment?: Commitment;
  blockhashRefreshMs?: number;
  tokenBalancePollFallbackMs?: number;
}

export interface SellResult {
  success: boolean;
  txSignature?: string;
  amountIn?: string;
  amountOut?: string;
  error?: string;
}

type CachedBlockhash = {
  blockhash: string;
  lastValidBlockHeight: number;
  updatedAt: number;
};

type FixedIxs = {
  computeBudgetIxs: ReturnType<typeof ComputeBudgetProgram.setComputeUnitLimit>[];
  tipIx: ReturnType<typeof SystemProgram.transfer>;
};

type PreparedClmmSellContext = {
  key: string;
  poolId: string;
  inputMint: PublicKey;
  tokenAccount: PublicKey;
  tokenProgramId: PublicKey;
  wsolMint: PublicKey;

  // live token balance cache
  tokenAmountRaw: bigint;
  tokenBalanceUpdatedAt: number;
  tokenAccountSubId: number | null;
  tokenBalancePollTimer: NodeJS.Timeout | null;

  // static pool snapshot (fetched once at prepare time)
  poolInfo: any;
  poolKeys: any;
  computePoolInfo: any;
  tickData: any;
  epochInfo: any;

  // static/fixed ixs
  fixedIxs: FixedIxs;
};

export class ClmmSeller {
  private readonly config: Required<
    Pick<
      ClmmSellerConfig,
      | "defaultSlippageBps"
      | "priorityFeeMicroLamports"
      | "computeUnits"
      | "confirmAfterSend"
      | "tipLamports"
      | "commitment"
      | "blockhashRefreshMs"
      | "tokenBalancePollFallbackMs"
    >
  >;

  private connection: Connection;
  private owner: Keypair;
  private raydium: Awaited<ReturnType<typeof Raydium.load>> | null = null;
  private heliusSenderUrl: string;

  private blockhashCache: CachedBlockhash | null = null;
  private blockhashTimer: NodeJS.Timeout | null = null;

  private prepared = new Map<string, PreparedClmmSellContext>();

  constructor(config: ClmmSellerConfig) {
    this.config = {
      defaultSlippageBps: config.defaultSlippageBps ?? 500,
      priorityFeeMicroLamports: config.priorityFeeMicroLamports ?? 500_000,
      computeUnits: config.computeUnits ?? 600_000,
      confirmAfterSend: config.confirmAfterSend ?? false,
      tipLamports: config.tipLamports ?? MIN_TIP_LAMPORTS,
      commitment: config.commitment ?? "processed",
      blockhashRefreshMs: config.blockhashRefreshMs ?? 1_500,
      tokenBalancePollFallbackMs: config.tokenBalancePollFallbackMs ?? 10_000,
    };

    this.connection = new Connection(config.rpcUrl, this.config.commitment);
    this.owner = Keypair.fromSecretKey(bs58.decode(config.privateKey));
    this.heliusSenderUrl = `https://sender.helius-rpc.com/fast?api-key=${encodeURIComponent(
      config.heliusApiKey
    )}`;
  }

  getOwnerPubkey(): PublicKey {
    return this.owner.publicKey;
  }

  async initialize(): Promise<void> {
    if (this.raydium) return;

    console.log("[ClmmSeller] Initializing Raydium SDK...");

    const ownerPubkey = this.owner.publicKey;

    const solAccountResp = await this.connection.getAccountInfo(ownerPubkey);
    const tokenAccountResp = await this.connection.getTokenAccountsByOwner(ownerPubkey, {
      programId: TOKEN_PROGRAM_ID,
    });
    const token2022Resp = await this.connection.getTokenAccountsByOwner(ownerPubkey, {
      programId: TOKEN_2022_PROGRAM_ID,
    });

    const tokenAccountData = parseTokenAccountResp({
      owner: ownerPubkey,
      solAccountResp,
      tokenAccountResp: {
        context: tokenAccountResp.context,
        value: [...tokenAccountResp.value, ...token2022Resp.value],
      },
    });

    this.raydium = await Raydium.load({
      connection: this.connection,
      owner: this.owner,
      tokenAccounts: tokenAccountData.tokenAccounts,
      tokenAccountRawInfos: tokenAccountData.tokenAccountRawInfos,
      disableLoadToken: true,
    });

    console.log("[ClmmSeller] Initialized");
    console.log(`[ClmmSeller] Wallet: ${this.owner.publicKey.toBase58()}`);
  }

  /**
   * Starts the global blockhash refresher loop.
   * Call once during app startup.
   */
  async startBlockhashLoop(): Promise<void> {
    const refresh = async () => {
      try {
        const latest = await this.connection.getLatestBlockhash(this.config.commitment);
        this.blockhashCache = {
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
          updatedAt: Date.now(),
        };
      } catch (error) {
        console.error("[ClmmSeller] Blockhash refresh failed:", error);
      }
    };

    await refresh();

    if (this.blockhashTimer) clearInterval(this.blockhashTimer);
    this.blockhashTimer = setInterval(refresh, this.config.blockhashRefreshMs);
    console.log(
      `[ClmmSeller] Blockhash loop started (${this.config.blockhashRefreshMs}ms)` 
    );
  }

  private getCachedBlockhash(): CachedBlockhash {
    if (!this.blockhashCache) {
      throw new Error("Blockhash cache is empty. Call startBlockhashLoop() first.");
    }

    // very small guard, because we are refreshing aggressively
    const ageMs = Date.now() - this.blockhashCache.updatedAt;
    if (ageMs > 10_000) {
      throw new Error(`Cached blockhash is stale (${ageMs}ms old)`);
    }

    return this.blockhashCache;
  }

  /**
   * Helius Sender /fast
   */
  private async sendViaHeliusSender(tx: Transaction): Promise<string> {
    const raw = tx.serialize();
    const base64Tx = Buffer.from(raw).toString("base64");

    const payload = {
      jsonrpc: "2.0",
      id: Date.now().toString(),
      method: "sendTransaction",
      params: [
        base64Tx,
        {
          encoding: "base64",
          skipPreflight: true,
          maxRetries: 0,
        },
      ],
    };

    const resp = await axios.post<HeliusSenderResp>(this.heliusSenderUrl, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 20_000,
      validateStatus: () => true,
    });

    if (resp.status < 200 || resp.status >= 300) {
      const body = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
      throw new Error(`Helius Sender HTTP ${resp.status}: ${body}`);
    }

    if (resp.data.error) {
      throw new Error(
        `Helius Sender error ${resp.data.error.code}: ${resp.data.error.message}` 
      );
    }

    if (!resp.data.result) {
      throw new Error(
        `Helius Sender returned no signature: ${JSON.stringify(resp.data)}` 
      );
    }

    return resp.data.result;
  }

  /**
   * Determine token account + token program if tokenAccount was not supplied.
   */
  private async findTokenAccountWithBalance(
    mint: PublicKey
  ): Promise<{ pubkey: PublicKey; amountRaw: bigint; programId: PublicKey } | null> {
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const resp = await this.connection.getTokenAccountsByOwner(this.owner.publicKey, {
        mint,
        programId,
      });

      for (const item of resp.value) {
        const bal = await this.connection.getTokenAccountBalance(
          item.pubkey,
          this.config.commitment
        );
        const amountRaw = BigInt(bal.value.amount);
        if (amountRaw > 0n) {
          return { pubkey: item.pubkey, amountRaw, programId };
        }
      }
    }

    return null;
  }

  private createFixedIxs(
    priorityFeeMicroLamports: number,
    computeUnits: number,
    tipLamports: number
  ): FixedIxs {
    const tipWallet =
      HELIUS_TIP_WALLETS[Math.floor(Math.random() * HELIUS_TIP_WALLETS.length)];

    const computeBudgetIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({
        units: computeUnits,
      }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: priorityFeeMicroLamports,
      }),
    ];

    const tipIx = SystemProgram.transfer({
      fromPubkey: this.owner.publicKey,
      toPubkey: new PublicKey(tipWallet),
      lamports: tipLamports,
    });

    return {
      computeBudgetIxs: computeBudgetIxs as ReturnType<
        typeof ComputeBudgetProgram.setComputeUnitLimit
      >[],
      tipIx,
    };
  }

  /**
   * Parse token amount from websocket account data.
   */
  private extractTokenAmountFromAccountData(
    accountPubkey: PublicKey,
    accountInfo: { data: Buffer },
    tokenProgramId: PublicKey
  ): bigint | null {
    try {
      const decoded = unpackAccount(accountPubkey, accountInfo as any, tokenProgramId);
      return BigInt(decoded.amount.toString());
    } catch {
      return null;
    }
  }

  /**
   * Subscribe to token account changes over websocket and keep in-memory amount fresh.
   */
  private async startTokenAccountMonitoring(ctx: PreparedClmmSellContext): Promise<void> {
    // seed current balance first
    try {
      const bal = await this.connection.getTokenAccountBalance(
        ctx.tokenAccount,
        this.config.commitment
      );
      ctx.tokenAmountRaw = BigInt(bal.value.amount);
      ctx.tokenBalanceUpdatedAt = Date.now();
      console.log(
        `[ClmmSeller] Seed token balance: ${ctx.tokenAmountRaw.toString()} for ${ctx.tokenAccount
          .toBase58()
          .slice(0, 12)}...`
      );
    } catch (error) {
      console.error("[ClmmSeller] Failed to seed token balance:", error);
    }

    try {
      ctx.tokenAccountSubId = this.connection.onAccountChange(
        ctx.tokenAccount,
        (info) => {
          const parsed = this.extractTokenAmountFromAccountData(
            ctx.tokenAccount,
            { data: info.data as Buffer },
            ctx.tokenProgramId
          );

          if (parsed !== null) {
            ctx.tokenAmountRaw = parsed;
            ctx.tokenBalanceUpdatedAt = Date.now();
          }
        },
        this.config.commitment
      );

      console.log(
        `[ClmmSeller] Token account WS monitor started for ${ctx.tokenAccount
          .toBase58()
          .slice(0, 12)}...`
      );
    } catch (error) {
      console.error("[ClmmSeller] Failed to start token WS monitor:", error);
    }

    // RPC fallback in case websocket lags or misses
    const poll = async () => {
      try {
        const bal = await this.connection.getTokenAccountBalance(
          ctx.tokenAccount,
          this.config.commitment
        );
        ctx.tokenAmountRaw = BigInt(bal.value.amount);
        ctx.tokenBalanceUpdatedAt = Date.now();
      } catch (error) {
        console.error("[ClmmSeller] Token balance fallback poll failed:", error);
      }
    };

    if (ctx.tokenBalancePollTimer) clearInterval(ctx.tokenBalancePollTimer);
    ctx.tokenBalancePollTimer = setInterval(
      poll,
      this.config.tokenBalancePollFallbackMs
    );
  }

  /**
   * Fetch pool snapshot once (called at prepare time)
   */
  private async fetchPoolSnapshot(
    poolId: string
  ): Promise<{ poolInfo: any; poolKeys: any; computePoolInfo: any; tickData: any; epochInfo: any }> {
    if (!this.raydium) throw new Error("Raydium not initialized");

    const { poolInfo, poolKeys, computePoolInfo, tickData } =
      await this.raydium.clmm.getPoolInfoFromRpc(poolId);

    const epochInfo = await this.raydium.fetchEpochInfo();

    return { poolInfo, poolKeys, computePoolInfo, tickData, epochInfo };
  }

  /**
   * Prepare a sell context once, then keep it fresh continuously.
   * Returns a prepKey to use with emergencySellPrepared().
   */
  async prepareEmergencySell(params: {
    inputMint: string;
    poolId: string;
    tokenAccount?: string;
    priorityFeeMicroLamports?: number;
    computeUnits?: number;
    tipLamports?: number;
  }): Promise<string> {
    await this.initialize();

    const inputMint = new PublicKey(params.inputMint);
    const poolId = params.poolId;
    const wsolMint = new PublicKey(DEFAULT_WSOL_MINT);

    let tokenAccount: PublicKey;
    let tokenProgramId: PublicKey;
    let seedBalance = 0n;

    if (params.tokenAccount) {
      tokenAccount = new PublicKey(params.tokenAccount);

      const accInfo = await this.connection.getAccountInfo(
        tokenAccount,
        this.config.commitment
      );
      if (!accInfo) {
        throw new Error("Provided token account not found");
      }

      // Detect token program from owner field
      tokenProgramId = accInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID;

      const bal = await this.connection.getTokenAccountBalance(
        tokenAccount,
        this.config.commitment
      );
      seedBalance = BigInt(bal.value.amount);
    } else {
      const found = await this.findTokenAccountWithBalance(inputMint);
      if (!found) {
        throw new Error("No token account with balance found for this mint");
      }
      tokenAccount = found.pubkey;
      tokenProgramId = found.programId;
      seedBalance = found.amountRaw;
    }

    const fixedIxs = this.createFixedIxs(
      params.priorityFeeMicroLamports ?? this.config.priorityFeeMicroLamports,
      params.computeUnits ?? this.config.computeUnits,
      params.tipLamports ?? this.config.tipLamports
    );

    const key = `${poolId}:${inputMint.toBase58()}:${tokenAccount.toBase58()}`;

    const ctx: PreparedClmmSellContext = {
      key,
      poolId,
      inputMint,
      tokenAccount,
      tokenProgramId,
      wsolMint,

      tokenAmountRaw: seedBalance,
      tokenBalanceUpdatedAt: Date.now(),
      tokenAccountSubId: null,
      tokenBalancePollTimer: null,

      poolInfo: null,
      poolKeys: null,
      computePoolInfo: null,
      tickData: null,
      epochInfo: null,

      fixedIxs,
    };

    // fetch pool snapshot once at prepare time
    const snapshot = await this.fetchPoolSnapshot(poolId);
    ctx.poolInfo = snapshot.poolInfo;
    ctx.poolKeys = snapshot.poolKeys;
    ctx.computePoolInfo = snapshot.computePoolInfo;
    ctx.tickData = snapshot.tickData;
    ctx.epochInfo = snapshot.epochInfo;

    // sanity checks
    const mintA = ctx.poolInfo.mintA.address;
    const mintB = ctx.poolInfo.mintB.address;

    if (ctx.inputMint.toBase58() !== mintA && ctx.inputMint.toBase58() !== mintB) {
      throw new Error(
        `Input mint ${ctx.inputMint.toBase58()} is not in pool mints (${mintA}, ${mintB})` 
      );
    }

    if (mintA !== DEFAULT_WSOL_MINT && mintB !== DEFAULT_WSOL_MINT) {
      throw new Error("Pool does not contain WSOL - only token -> SOL supported");
    }

    this.prepared.set(key, ctx);

    await this.startTokenAccountMonitoring(ctx);

    console.log(`[ClmmSeller] Prepared context: ${key}`);
    console.log(`[ClmmSeller] Pool: ${poolId.slice(0, 12)}...`);
    console.log(`[ClmmSeller] Token account: ${tokenAccount.toBase58().slice(0, 12)}...`);
    console.log(`[ClmmSeller] Seed balance: ${seedBalance.toString()}`);

    return key;
  }

  /**
   * Fast trigger path.
   * Uses:
   * - cached token balance from websocket
   * - cached pool snapshot
   * - cached recent blockhash
   * - local Raydium swap build
   */
  async emergencySellPrepared(params: {
    prepKey: string;
    sellPercent?: number;
    slippageBps?: number;
    forceMinOutZero?: boolean;
    confirmAfterSend?: boolean;
  }): Promise<SellResult> {
    try {
      if (!this.raydium) {
        await this.initialize();
      }

      const ctx = this.prepared.get(params.prepKey);
      if (!ctx) {
        return { success: false, error: "Prepared context not found" };
      }

      const sellPercent = params.sellPercent ?? 100;
      const slippageBps = params.slippageBps ?? this.config.defaultSlippageBps;
      const slippage = slippageBps / 10_000;
      const confirmAfterSend =
        params.confirmAfterSend ?? this.config.confirmAfterSend;

      // optional freshness guard for token balance only
      const balanceAgeMs = Date.now() - ctx.tokenBalanceUpdatedAt;

      if (balanceAgeMs > Math.max(this.config.tokenBalancePollFallbackMs * 3, 8_000)) {
        return {
          success: false,
          error: `Token balance cache is stale (${balanceAgeMs}ms old)`,
        };
      }

      const amountRaw = ctx.tokenAmountRaw;
      if (amountRaw <= 0n) {
        return { success: false, error: "No balance to sell" };
      }

      const amountInRaw =
        (amountRaw * BigInt(Math.floor(sellPercent * 100))) / 10000n;

      if (amountInRaw <= 0n) {
        return { success: false, error: "Calculated sell amount is 0" };
      }

      const mintA = ctx.poolInfo.mintA.address;
      const mintB = ctx.poolInfo.mintB.address;
      const baseIn = ctx.inputMint.toBase58() === mintA;
      const tokenOut = baseIn ? ctx.poolInfo.mintB : ctx.poolInfo.mintA;

      // compute quote from cached pool snapshot
      const quote = PoolUtils.computeAmountOutFormat({
        poolInfo: ctx.computePoolInfo,
        tickArrayCache: ctx.tickData[ctx.poolId],
        amountIn: new BN(amountInRaw.toString()),
        tokenOut,
        slippage,
        epochInfo: ctx.epochInfo,
      });

      const amountOutMin = params.forceMinOutZero
        ? new BN(0)
        : quote.minAmountOut.amount.raw;

      // build swap locally using cached pool context
      const built = await this.raydium!.clmm.swap({
        poolInfo: ctx.poolInfo,
        poolKeys: ctx.poolKeys,
        inputMint: ctx.inputMint,
        amountIn: new BN(amountInRaw.toString()),
        amountOutMin,
        observationId: ctx.computePoolInfo.observationId,
        ownerInfo: {
          useSOLBalance: true,
          feePayer: this.owner.publicKey,
        },
        remainingAccounts: quote.remainingAccounts,
        txVersion: TxVersion.LEGACY,
        computeBudgetConfig: undefined, // fixed compute budget already prebuilt
        feePayer: this.owner.publicKey,
      });

      const swapTx = built.transaction as Transaction;
      const { blockhash, lastValidBlockHeight } = this.getCachedBlockhash();

      // final fast tx assembly
      const finalTx = new Transaction();
      finalTx.feePayer = this.owner.publicKey;
      finalTx.recentBlockhash = blockhash;

      // compute budget first
      for (const ix of ctx.fixedIxs.computeBudgetIxs) {
        finalTx.add(ix);
      }

      // Raydium swap instructions
      for (const ix of swapTx.instructions) {
        finalTx.add(ix);
      }

      // Helius tip last
      finalTx.add(ctx.fixedIxs.tipIx);

      finalTx.sign(this.owner);

      console.log(
        `[ClmmSeller] Fast sell trigger -> amount=${amountInRaw.toString()} balanceAge=${balanceAgeMs}ms` 
      );

      const sig = await this.sendViaHeliusSender(finalTx);
      console.log(`[ClmmSeller] Sent: ${sig}`);

      if (confirmAfterSend) {
        await this.connection.confirmTransaction(
          {
            blockhash,
            lastValidBlockHeight,
            signature: sig,
          },
          "processed"
        );
        console.log(`[ClmmSeller] Confirmed: ${sig}`);
      }

      return {
        success: true,
        txSignature: sig,
        amountIn: amountInRaw.toString(),
        amountOut: amountOutMin.toString(),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[ClmmSeller] Sell failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Legacy compatibility wrapper.
   * If you still call emergencySell(), this now auto-prepares once and then uses the fast path.
   */
  async emergencySell(params: {
    inputMint: string;
    poolId: string;
    tokenAccount?: string;
    sellPercent?: number;
    slippageBps?: number;
    priorityFeeMicroLamports?: number;
    computeUnits?: number;
    forceMinOutZero?: boolean;
  }): Promise<SellResult> {
    const prepKey = `${params.poolId}:${params.inputMint}:${params.tokenAccount ?? "auto"}`;

    // Reuse existing prepared context if exact key already exists,
    // otherwise prepare a fresh one.
    let matchedKey: string | undefined;
    for (const key of this.prepared.keys()) {
      if (key.startsWith(`${params.poolId}:${params.inputMint}:`)) {
        if (!params.tokenAccount || key.endsWith(`:${params.tokenAccount}`)) {
          matchedKey = key;
          break;
        }
      }
    }

    if (!matchedKey) {
      matchedKey = await this.prepareEmergencySell({
        inputMint: params.inputMint,
        poolId: params.poolId,
        tokenAccount: params.tokenAccount,
        priorityFeeMicroLamports: params.priorityFeeMicroLamports,
        computeUnits: params.computeUnits,
      });
    }

    return this.emergencySellPrepared({
      prepKey: matchedKey ?? prepKey,
      sellPercent: params.sellPercent,
      slippageBps: params.slippageBps,
      forceMinOutZero: params.forceMinOutZero,
    });
  }

  /**
   * Stop one prepared context.
   */
  async stopPrepared(prepKey: string): Promise<void> {
    const ctx = this.prepared.get(prepKey);
    if (!ctx) return;

    if (ctx.tokenBalancePollTimer) {
      clearInterval(ctx.tokenBalancePollTimer);
      ctx.tokenBalancePollTimer = null;
    }

    if (ctx.tokenAccountSubId !== null) {
      try {
        await this.connection.removeAccountChangeListener(ctx.tokenAccountSubId);
      } catch (error) {
        console.error("[ClmmSeller] Failed removing token account listener:", error);
      }
      ctx.tokenAccountSubId = null;
    }

    this.prepared.delete(prepKey);
    console.log(`[ClmmSeller] Stopped prepared context: ${prepKey}`);
  }

  /**
   * Stop all loops/listeners.
   */
  async shutdown(): Promise<void> {
    if (this.blockhashTimer) {
      clearInterval(this.blockhashTimer);
      this.blockhashTimer = null;
    }

    const keys = [...this.prepared.keys()];
    for (const key of keys) {
      await this.stopPrepared(key);
    }

    console.log("[ClmmSeller] Shutdown complete");
  }

  /**
   * Helpful inspection method.
   */
  getPreparedState(prepKey: string) {
    const ctx = this.prepared.get(prepKey);
    if (!ctx) return null;

    return {
      prepKey: ctx.key,
      poolId: ctx.poolId,
      inputMint: ctx.inputMint.toBase58(),
      tokenAccount: ctx.tokenAccount.toBase58(),
      tokenAmountRaw: ctx.tokenAmountRaw.toString(),
      tokenBalanceUpdatedAt: ctx.tokenBalanceUpdatedAt,
      blockhashUpdatedAt: this.blockhashCache?.updatedAt ?? null,
    };
  }
}
