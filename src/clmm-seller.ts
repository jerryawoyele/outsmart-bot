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
  VersionedTransaction,
  SendOptions,
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

/**
 * Rebuilt CLMM seller for Raydium SDK v2 + Helius Sender
 *
 * Goals:
 * - fast emergency CLMM sell
 * - avoid stale-quote / stale-pool issues
 * - handle SDK builders that may return transaction OR transactions
 * - keep token balance hot via websocket + polling fallback
 * - use Helius Sender-compatible fee/tip path
 *
 * Notes:
 * - This file is written to be robust across minor SDK return-shape differences,
 *   so there are a few `any` casts around builder outputs.
 * - It assumes a token -> WSOL/SOL sell on a Raydium CLMM pool.
 */

const DEFAULT_WSOL_MINT = "So11111111111111111111111111111111111111112";
const MIN_JITO_TIP_LAMPORTS = 200_000;

/**
 * Helius tip wallets
 * Keep current if Helius changes their list.
 */
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
] as const;

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

  commitment?: Commitment;

  // execution
  defaultSlippageBps?: number;
  priorityFeeMicroLamports?: number;
  computeUnits?: number;
  tipLamports?: number;
  confirmAfterSend?: boolean;

  // cache / loops
  blockhashRefreshMs?: number;
  tokenBalancePollFallbackMs?: number;
  staleBlockhashMs?: number;
  staleTokenBalanceMs?: number;
}

export interface PrepareParams {
  inputMint: string;
  poolId: string;
  tokenAccount?: string;

  priorityFeeMicroLamports?: number;
  computeUnits?: number;
  tipLamports?: number;
}

export interface EmergencySellParams {
  prepKey: string;
  sellPercent?: number;
  slippageBps?: number;
  forceMinOutZero?: boolean;
  confirmAfterSend?: boolean;
}

export interface SellResult {
  success: boolean;
  txSignature?: string;
  amountIn?: string;
  minAmountOut?: string;
  error?: string;
}

type CachedBlockhash = {
  blockhash: string;
  lastValidBlockHeight: number;
  updatedAt: number;
};

type PreparedSellContext = {
  key: string;
  poolId: string;
  inputMint: PublicKey;
  tokenAccount: PublicKey;
  tokenProgramId: PublicKey;
  wsolMint: PublicKey;

  tokenAmountRaw: bigint;
  tokenBalanceUpdatedAt: number;
  tokenAccountSubId: number | null;
  tokenBalancePollTimer: NodeJS.Timeout | null;

  priorityFeeMicroLamports: number;
  computeUnits: number;
  tipLamports: number;
};

export class ClmmSeller {
  private readonly config: Required<
    Pick<
      ClmmSellerConfig,
      | "commitment"
      | "defaultSlippageBps"
      | "priorityFeeMicroLamports"
      | "computeUnits"
      | "tipLamports"
      | "confirmAfterSend"
      | "blockhashRefreshMs"
      | "tokenBalancePollFallbackMs"
      | "staleBlockhashMs"
      | "staleTokenBalanceMs"
    >
  >;

  private readonly connection: Connection;
  private readonly owner: Keypair;
  private readonly heliusSenderUrl: string;

  private raydium: Awaited<ReturnType<typeof Raydium.load>> | null = null;

  private blockhashCache: CachedBlockhash | null = null;
  private blockhashTimer: NodeJS.Timeout | null = null;

  private prepared = new Map<string, PreparedSellContext>();

  constructor(config: ClmmSellerConfig) {
    this.config = {
      commitment: config.commitment ?? "processed",
      defaultSlippageBps: config.defaultSlippageBps ?? 500,
      priorityFeeMicroLamports: config.priorityFeeMicroLamports ?? 500_000,
      computeUnits: config.computeUnits ?? 1_000_000,
      tipLamports: Math.max(config.tipLamports ?? MIN_JITO_TIP_LAMPORTS, MIN_JITO_TIP_LAMPORTS),
      confirmAfterSend: config.confirmAfterSend ?? false,
      blockhashRefreshMs: config.blockhashRefreshMs ?? 1_500,
      tokenBalancePollFallbackMs: config.tokenBalancePollFallbackMs ?? 10_000,
      staleBlockhashMs: config.staleBlockhashMs ?? 10_000,
      staleTokenBalanceMs: config.staleTokenBalanceMs ?? 20_000,
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

    const owner = this.owner.publicKey;

    const solAccountResp = await this.connection.getAccountInfo(owner);
    const tokenAccountResp = await this.connection.getTokenAccountsByOwner(owner, {
      programId: TOKEN_PROGRAM_ID,
    });
    const token2022Resp = await this.connection.getTokenAccountsByOwner(owner, {
      programId: TOKEN_2022_PROGRAM_ID,
    });

    const tokenAccountData = parseTokenAccountResp({
      owner,
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

    console.log(`[ClmmSeller] Initialized for ${owner.toBase58()}`);
  }

  async refreshWalletTokenAccounts(forceUpdate = true): Promise<void> {
    if (!this.raydium) throw new Error("Raydium not initialized");
    try {
      await this.raydium.account.fetchWalletTokenAccounts({ forceUpdate });
    } catch (error) {
      console.warn("[ClmmSeller] Wallet token account refresh failed:", error);
    }
  }

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

    console.log(`[ClmmSeller] Blockhash loop started (${this.config.blockhashRefreshMs}ms)`);
  }

  private getCachedBlockhash(): CachedBlockhash {
    if (!this.blockhashCache) {
      throw new Error("Blockhash cache empty. Call startBlockhashLoop() first.");
    }

    const ageMs = Date.now() - this.blockhashCache.updatedAt;
    if (ageMs > this.config.staleBlockhashMs) {
      throw new Error(`Cached blockhash stale (${ageMs}ms old)`);
    }

    return this.blockhashCache;
  }

  private async getLamportsBalance(): Promise<number> {
    return this.connection.getBalance(this.owner.publicKey, this.config.commitment);
  }

  private randomTipWallet(): PublicKey {
    const chosen =
      HELIUS_TIP_WALLETS[Math.floor(Math.random() * HELIUS_TIP_WALLETS.length)];
    return new PublicKey(chosen);
  }

  private async sendViaHeliusSender(
    tx: Transaction | VersionedTransaction,
    opts?: SendOptions
  ): Promise<string> {
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
          ...opts,
        },
      ],
    };

    const resp = await axios.post<HeliusSenderResp>(this.heliusSenderUrl, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 20_000,
      validateStatus: () => true,
    });

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`Helius Sender HTTP ${resp.status}: ${JSON.stringify(resp.data)}`);
    }

    if (resp.data.error) {
      throw new Error(
        `Helius Sender error ${resp.data.error.code}: ${resp.data.error.message}`
      );
    }

    if (!resp.data.result) {
      throw new Error(`Helius Sender returned no signature: ${JSON.stringify(resp.data)}`);
    }

    return resp.data.result;
  }

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

  private async startTokenAccountMonitoring(ctx: PreparedSellContext): Promise<void> {
    try {
      const bal = await this.connection.getTokenAccountBalance(
        ctx.tokenAccount,
        this.config.commitment
      );
      ctx.tokenAmountRaw = BigInt(bal.value.amount);
      ctx.tokenBalanceUpdatedAt = Date.now();
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
    } catch (error) {
      console.error("[ClmmSeller] Failed to start token WS monitor:", error);
    }

    const poll = async () => {
      try {
        const bal = await this.connection.getTokenAccountBalance(
          ctx.tokenAccount,
          this.config.commitment
        );
        ctx.tokenAmountRaw = BigInt(bal.value.amount);
        ctx.tokenBalanceUpdatedAt = Date.now();
      } catch (error) {
        console.error("[ClmmSeller] Token balance poll failed:", error);
      }
    };

    if (ctx.tokenBalancePollTimer) clearInterval(ctx.tokenBalancePollTimer);
    ctx.tokenBalancePollTimer = setInterval(
      poll,
      this.config.tokenBalancePollFallbackMs
    );
  }

  private async fetchFreshPoolSnapshot(poolId: string) {
    if (!this.raydium) throw new Error("Raydium not initialized");

    const { poolInfo, poolKeys, computePoolInfo, tickData } =
      await this.raydium.clmm.getPoolInfoFromRpc(poolId);
    const epochInfo = await this.raydium.fetchEpochInfo();

    return { poolInfo, poolKeys, computePoolInfo, tickData, epochInfo };
  }

  private addComputeAndTipToLegacyTransaction(
    tx: Transaction,
    priorityFeeMicroLamports: number,
    computeUnits: number,
    tipLamports: number
  ): Transaction {
    const tipIx = SystemProgram.transfer({
      fromPubkey: this.owner.publicKey,
      toPubkey: this.randomTipWallet(),
      lamports: Math.max(tipLamports, MIN_JITO_TIP_LAMPORTS),
    });

    const finalTx = new Transaction();

    finalTx.feePayer = tx.feePayer ?? this.owner.publicKey;
    finalTx.recentBlockhash = tx.recentBlockhash;

    finalTx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: priorityFeeMicroLamports,
      })
    );

    for (const ix of tx.instructions) {
      finalTx.add(ix);
    }

    finalTx.add(tipIx);

    return finalTx;
  }

  /**
   * Normalize Raydium builder output into a list of txs.
   * Raydium's demo states tx builders may return transaction OR transactions.
   */
  private extractBuiltTransactions(built: any): Array<Transaction | VersionedTransaction> {
    const out: Array<Transaction | VersionedTransaction> = [];

    if (built?.transaction) {
      if (Array.isArray(built.transaction)) {
        for (const tx of built.transaction) {
          if (tx) out.push(tx);
        }
      } else {
        out.push(built.transaction);
      }
    }

    if (Array.isArray(built?.transactions)) {
      for (const tx of built.transactions) {
        if (tx) out.push(tx);
      }
    }

    // builder.allTxData fallback
    const allTxData = built?.builder?.allTxData;
    if (Array.isArray(allTxData)) {
      for (const item of allTxData) {
        const tx = item?.transaction ?? item?.tx ?? item;
        if (tx && !out.includes(tx)) out.push(tx);
      }
    }

    return out;
  }

  private signBuiltTransaction(
    tx: Transaction | VersionedTransaction
  ): Transaction | VersionedTransaction {
    if (tx instanceof VersionedTransaction) {
      tx.sign([this.owner]);
      return tx;
    }

    tx.sign(this.owner);
    return tx;
  }

  private withFreshBlockhash(
    tx: Transaction | VersionedTransaction,
    blockhash: string
  ): Transaction | VersionedTransaction {
    if (tx instanceof VersionedTransaction) {
      tx.message.recentBlockhash = blockhash;
      return tx;
    }

    tx.recentBlockhash = blockhash;
    return tx;
  }

  private estimateRequiredFeeLamports(
    computeUnits: number,
    priorityFeeMicroLamports: number,
    tipLamports: number,
    signatures = 1
  ): number {
    const baseFee = 5_000 * signatures;
    const priorityFeeLamports = Math.ceil(
      (computeUnits * priorityFeeMicroLamports) / 1_000_000
    );
    return baseFee + priorityFeeLamports + tipLamports;
  }

  async prepareEmergencySell(params: PrepareParams): Promise<string> {
    await this.initialize();
    await this.refreshWalletTokenAccounts(true);

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
      if (!accInfo) throw new Error("Provided token account not found");

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
      if (!found) throw new Error("No token account with balance found for this mint");

      tokenAccount = found.pubkey;
      tokenProgramId = found.programId;
      seedBalance = found.amountRaw;
    }

    const ctx: PreparedSellContext = {
      key: `${poolId}:${inputMint.toBase58()}:${tokenAccount.toBase58()}`,
      poolId,
      inputMint,
      tokenAccount,
      tokenProgramId,
      wsolMint,

      tokenAmountRaw: seedBalance,
      tokenBalanceUpdatedAt: Date.now(),
      tokenAccountSubId: null,
      tokenBalancePollTimer: null,

      priorityFeeMicroLamports:
        params.priorityFeeMicroLamports ?? this.config.priorityFeeMicroLamports,
      computeUnits: params.computeUnits ?? this.config.computeUnits,
      tipLamports: Math.max(
        params.tipLamports ?? this.config.tipLamports,
        MIN_JITO_TIP_LAMPORTS
      ),
    };

    // Quick validation with fresh pool fetch at prepare time
    const snapshot = await this.fetchFreshPoolSnapshot(poolId);

    const mintA = snapshot.poolInfo.mintA.address;
    const mintB = snapshot.poolInfo.mintB.address;

    if (ctx.inputMint.toBase58() !== mintA && ctx.inputMint.toBase58() !== mintB) {
      throw new Error(
        `Input mint ${ctx.inputMint.toBase58()} is not in pool mints (${mintA}, ${mintB})`
      );
    }

    if (mintA !== DEFAULT_WSOL_MINT && mintB !== DEFAULT_WSOL_MINT) {
      throw new Error("Pool does not contain WSOL; this seller supports token -> SOL only");
    }

    this.prepared.set(ctx.key, ctx);
    await this.startTokenAccountMonitoring(ctx);

    console.log(`[ClmmSeller] Prepared ${ctx.key}`);
    console.log(`[ClmmSeller] Seed balance ${seedBalance.toString()}`);

    return ctx.key;
  }

  async emergencySellPrepared(params: EmergencySellParams): Promise<SellResult> {
    try {
      await this.initialize();

      const ctx = this.prepared.get(params.prepKey);
      if (!ctx) {
        return { success: false, error: "Prepared context not found" };
      }

      const sellPercent = params.sellPercent ?? 100;
      const slippageBps = params.slippageBps ?? this.config.defaultSlippageBps;
      const slippage = slippageBps / 10_000;
      const confirmAfterSend =
        params.confirmAfterSend ?? this.config.confirmAfterSend;

      const tokenAgeMs = Date.now() - ctx.tokenBalanceUpdatedAt;
      if (tokenAgeMs > this.config.staleTokenBalanceMs) {
        return {
          success: false,
          error: `Token balance cache stale (${tokenAgeMs}ms old)`,
        };
      }

      const totalRaw = ctx.tokenAmountRaw;
      if (totalRaw <= 0n) {
        return { success: false, error: "No balance to sell" };
      }

      const amountInRaw =
        (totalRaw * BigInt(Math.floor(sellPercent * 100))) / 10000n;

      if (amountInRaw <= 0n) {
        return { success: false, error: "Calculated sell amount is 0" };
      }

      const feeBudget = this.estimateRequiredFeeLamports(
        ctx.computeUnits,
        ctx.priorityFeeMicroLamports,
        ctx.tipLamports
      );
      const lamportsBalance = await this.getLamportsBalance();
      if (lamportsBalance < feeBudget) {
        return {
          success: false,
          error: `Insufficient SOL for fees. Need ~${feeBudget} lamports, have ${lamportsBalance}`,
        };
      }

      // refresh Raydium's internal wallet account cache before build
      await this.refreshWalletTokenAccounts(true);

      // refresh CLMM state right before sell
      const { poolInfo, poolKeys, computePoolInfo, tickData, epochInfo } =
        await this.fetchFreshPoolSnapshot(ctx.poolId);

      const mintA = poolInfo.mintA.address;
      const mintB = poolInfo.mintB.address;
      const tokenOut = ctx.inputMint.toBase58() === mintA ? poolInfo.mintB : poolInfo.mintA;

      const quote = PoolUtils.computeAmountOutFormat({
        poolInfo: computePoolInfo,
        tickArrayCache: tickData[ctx.poolId],
        amountIn: new BN(amountInRaw.toString()),
        tokenOut,
        slippage,
        epochInfo,
      });

      const amountOutMin = params.forceMinOutZero
        ? new BN(0)
        : quote.minAmountOut.amount.raw;

      const built = await this.raydium!.clmm.swap({
        poolInfo,
        poolKeys,
        inputMint: ctx.inputMint,
        amountIn: new BN(amountInRaw.toString()),
        amountOutMin,
        observationId: computePoolInfo.observationId,
        ownerInfo: {
          feePayer: this.owner.publicKey,
          // false is safer for token -> SOL flow unless you intentionally
          // want SOL balance semantics for input side.
          useSOLBalance: false,
        },
        remainingAccounts: quote.remainingAccounts,
        txVersion: TxVersion.LEGACY,
        computeBudgetConfig: undefined,
        feePayer: this.owner.publicKey,
      });

      const builtTxs = this.extractBuiltTransactions(built);

      if (!builtTxs.length) {
        return { success: false, error: "Raydium swap returned no built transaction" };
      }

      // For emergency sell, we send the last built tx because earlier ones are
      // usually setup steps. If multiple txs are returned, you may need to send
      // all of them sequentially for your exact SDK version / token path.
      const rawBuiltTx = builtTxs[builtTxs.length - 1];

      if (!(rawBuiltTx instanceof Transaction) && !(rawBuiltTx instanceof VersionedTransaction)) {
        return { success: false, error: "Unsupported built transaction type" };
      }

      if (rawBuiltTx instanceof VersionedTransaction) {
        return {
          success: false,
          error:
            "Raydium returned a versioned transaction. This seller expects legacy tx output. Force LEGACY or adapt the tip/compute injection path.",
        };
      }

      const { blockhash, lastValidBlockHeight } = this.getCachedBlockhash();

      // Replace blockhash, then prepend compute budget + append tip
      rawBuiltTx.feePayer = this.owner.publicKey;
      rawBuiltTx.recentBlockhash = blockhash;

      const finalTx = this.addComputeAndTipToLegacyTransaction(
        rawBuiltTx,
        ctx.priorityFeeMicroLamports,
        ctx.computeUnits,
        ctx.tipLamports
      );

      finalTx.feePayer = this.owner.publicKey;
      finalTx.recentBlockhash = blockhash;

      this.signBuiltTransaction(finalTx);

      console.log(
        `[ClmmSeller] Emergency sell -> amount=${amountInRaw.toString()} minOut=${amountOutMin.toString()}`
      );

      const sig = await this.sendViaHeliusSender(finalTx, {
        skipPreflight: true,
        maxRetries: 0,
      });

      if (confirmAfterSend) {
        await this.connection.confirmTransaction(
          {
            blockhash,
            lastValidBlockHeight,
            signature: sig,
          },
          "processed"
        );
      }

      return {
        success: true,
        txSignature: sig,
        amountIn: amountInRaw.toString(),
        minAmountOut: amountOutMin.toString(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[ClmmSeller] Sell failed:", msg);
      return { success: false, error: msg };
    }
  }

  async emergencySell(params: {
    inputMint: string;
    poolId: string;
    tokenAccount?: string;
    sellPercent?: number;
    slippageBps?: number;
    priorityFeeMicroLamports?: number;
    computeUnits?: number;
    tipLamports?: number;
    forceMinOutZero?: boolean;
    confirmAfterSend?: boolean;
  }): Promise<SellResult> {
    let prepKey: string | undefined;

    for (const key of this.prepared.keys()) {
      if (key.startsWith(`${params.poolId}:${params.inputMint}:`)) {
        if (!params.tokenAccount || key.endsWith(`:${params.tokenAccount}`)) {
          prepKey = key;
          break;
        }
      }
    }

    if (!prepKey) {
      prepKey = await this.prepareEmergencySell({
        inputMint: params.inputMint,
        poolId: params.poolId,
        tokenAccount: params.tokenAccount,
        priorityFeeMicroLamports: params.priorityFeeMicroLamports,
        computeUnits: params.computeUnits,
        tipLamports: params.tipLamports,
      });
    }

    return this.emergencySellPrepared({
      prepKey,
      sellPercent: params.sellPercent,
      slippageBps: params.slippageBps,
      forceMinOutZero: params.forceMinOutZero,
      confirmAfterSend: params.confirmAfterSend,
    });
  }

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
      priorityFeeMicroLamports: ctx.priorityFeeMicroLamports,
      computeUnits: ctx.computeUnits,
      tipLamports: ctx.tipLamports,
    };
  }

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
  }

  async shutdown(): Promise<void> {
    if (this.blockhashTimer) {
      clearInterval(this.blockhashTimer);
      this.blockhashTimer = null;
    }

    for (const key of [...this.prepared.keys()]) {
      await this.stopPrepared(key);
    }

    console.log("[ClmmSeller] Shutdown complete");
  }
}