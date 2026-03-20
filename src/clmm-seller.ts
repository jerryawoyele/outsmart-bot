import axios from "axios";
import https from "node:https";
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
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import {
  Raydium,
  TxVersion,
  parseTokenAccountResp,
  PoolUtils,
} from "@raydium-io/raydium-sdk-v2";
import { rpcRateLimiter } from "./rpc-rate-limiter.js";

/**
 * Near-prebuilt CLMM seller.
 *
 * Background phase:
 * - index.ts keeps ctx fresh
 * - index.ts calls prepareSellTemplate(ctx) when pool/balance changes
 *
 * Trigger phase:
 * - emergencySell() only clones template, patches blockhash, signs, sends
 */

const DEFAULT_WSOL_MINT = "So11111111111111111111111111111111111111112";
const MIN_TIP_LAMPORTS = 600_000;

/**
 * Keep your current tip wallet list for now.
 * If you later get official FlashBlock-specific tip wallets, replace this list.
 */
const RELAY_TIP_WALLETS = [
  "FLaShB3iXXTWE1vu9wQsChUKq3HFtpMAhb8kAh1pf1wi",
  "FLashhsorBmM9dLpuq6qATawcpqk1Y2aqaZfkd48iT3W",
  "FLaSHJNm5dWYzEgnHJWWJP5ccu128Mu61NJLxUf7mUXU",
  "FLaSHR4Vv7sttd6TyDF4yR1bJyAxRwWKbohDytEMu3wL",
  "FLASHRzANfcAKDuQ3RXv9hbkBy4WVEKDzoAgxJ56DiE4",
  "FLasHstqx11M8W56zrSEqkCyhMCCpr6ze6Mjdvqope5s",
  "FLAShWTjcweNT4NSotpjpxAkwxUr2we3eXQGhpTVzRwy",
  "FLasHXTqrbNvpWFB6grN47HGZfK6pze9HLNTgbukfPSk",
  "FLAshyAyBcKb39KPxSzXcepiS8iDYUhDGwJcJDPX4g2B",
  "FLAsHZTRcf3Dy1APaz6j74ebdMC6Xx4g6i9YxjyrDybR",
] as const;

type FlashBlockResp = {
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
  privateKey: string;
  flashblockApiKey: string;
  flashblockUrl: string;
  flashblockBackupUrl?: string;
  heliusSenderUrl?: string; // Helius Sender endpoint for parallel broadcast
  commitment?: Commitment;
  defaultSlippageBps?: number;
  priorityFeeMicroLamports?: number;
  computeUnits?: number;
  tipLamports?: number;
  confirmAfterSend?: boolean;
}

export interface PrecomputedSellContext {
  poolId: string;
  inputMint: string;
  tokenAccount: string;

  tokenAmountRaw: bigint;
  tokenBalanceUpdatedAt?: number;

  poolInfo: any;
  poolKeys: any;
  computePoolInfo: any;
  tickData: any;
  epochInfo: any;
  poolSnapshotUpdatedAt?: number;

  inputIsMintA: boolean;
  tokenOut: any;

  lamportsBalance: number;

  blockhash: string;
  lastValidBlockHeight: number;
  blockhashUpdatedAt?: number;

  priorityFeeMicroLamports: number;
  computeUnits: number;
  tipLamports: number;

  // Near-prebuilt template state
  preparedTx?: Transaction;
  preparedAmountIn?: string;
  preparedMinAmountOut?: string;
  templateUpdatedAt?: number;
}

export interface PrepareSellTemplateParams {
  ctx: PrecomputedSellContext;
  sellPercent?: number;
  slippageBps?: number;
  forceMinOutZero?: boolean;
}

export interface EmergencySellParams {
  ctx: PrecomputedSellContext;
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
      | "flashblockBackupUrl"
    >
  >;

  private readonly connection: Connection;
  private readonly owner: Keypair;
  private readonly raydiumHttp: ReturnType<typeof axios.create>;
  private readonly flashblockUrls: string[];
  private readonly flashblockApiKey: string;
  private readonly heliusSenderUrl: string | null;
  private raydium: Awaited<ReturnType<typeof Raydium.load>> | null = null;
  private wsolAta: PublicKey | null = null;

  constructor(config: ClmmSellerConfig) {
    this.config = {
      commitment: config.commitment ?? "processed",
      defaultSlippageBps: config.defaultSlippageBps ?? 10_000,
      priorityFeeMicroLamports: config.priorityFeeMicroLamports ?? 120_000,
      computeUnits: config.computeUnits ?? 1_000_000,
      tipLamports: Math.max(
        config.tipLamports ?? MIN_TIP_LAMPORTS,
        MIN_TIP_LAMPORTS,
      ),
      confirmAfterSend: config.confirmAfterSend ?? false,
      flashblockBackupUrl: config.flashblockBackupUrl ?? "",
    };

    this.connection = new Connection(config.rpcUrl, this.config.commitment);
    this.owner = Keypair.fromSecretKey(bs58.decode(config.privateKey));
    this.flashblockApiKey = config.flashblockApiKey;
    this.flashblockUrls = [config.flashblockUrl, config.flashblockBackupUrl]
      .filter(Boolean)
      .map((u) => u!.replace(/\/+$/, "") + "/");
    this.heliusSenderUrl = config.heliusSenderUrl || null;

    this.raydiumHttp = axios.create({
      timeout: 2000,
      validateStatus: () => true,
      httpsAgent: new https.Agent({
        keepAlive: true,
        maxSockets: 32,
        keepAliveMsecs: 10_000,
      }),
    });
  }

  getOwnerPubkey(): PublicKey {
    return this.owner.publicKey;
  }

  getConnection(): Connection {
    return this.connection;
  }

  async initialize(): Promise<void> {
    if (this.raydium) return;

    const owner = this.owner.publicKey;
    await rpcRateLimiter.waitForSlot();
    const tokenAccountResp = await this.connection.getTokenAccountsByOwner(
      owner,
      {
        programId: TOKEN_PROGRAM_ID,
      },
    );

    const tokenAccountData = parseTokenAccountResp({
      owner,
      solAccountResp: null,
      tokenAccountResp: {
        context: tokenAccountResp.context,
        value: tokenAccountResp.value,
      },
    });

    this.raydium = await Raydium.load({
      connection: this.connection,
      owner: this.owner,
      tokenAccounts: tokenAccountData.tokenAccounts,
      tokenAccountRawInfos: tokenAccountData.tokenAccountRawInfos,
      disableLoadToken: true,
    });

    // Compute and cache WSOL ATA address (deterministic, no RPC needed)
    const wsolMint = new PublicKey(DEFAULT_WSOL_MINT);
    this.wsolAta = await getAssociatedTokenAddress(wsolMint, this.owner.publicKey);

    // Ensure WSOL ATA exists (one-time check at startup, off hot path)
    await this.ensureWsolAtaExists();

    console.log(`[ClmmSeller] Initialized for ${owner.toBase58()}`);
  }

  /**
   * Refresh token accounts in Raydium SDK.
   * Call this when a new token is detected to update the SDK's token account cache.
   */
  async refreshTokenAccounts(): Promise<void> {
    // Reinitialize Raydium with fresh token accounts
    this.raydium = null;
    await this.initialize();
    console.log(`[ClmmSeller] Refreshed token accounts`);
  }

  /**
   * Get cached WSOL ATA address (no RPC call).
   * Safe to call on hot path - just returns cached address.
   */
  getWsolAta(): PublicKey {
    if (!this.wsolAta) {
      throw new Error("WSOL ATA not initialized - call initialize() first");
    }
    return this.wsolAta;
  }

  /**
   * Ensure WSOL ATA exists (one-time at startup).
   * NOT called on hot path - initialized once before any trading.
   */
  private async ensureWsolAtaExists(): Promise<void> {
    if (!this.wsolAta) return;

    await rpcRateLimiter.waitForSlot();
    const accountInfo = await this.connection.getAccountInfo(this.wsolAta);
    if (accountInfo) {
      console.log(`[ClmmSeller] WSOL ATA exists: ${this.wsolAta.toBase58().slice(0, 12)}...`);
      return;
    }

    // Create WSOL ATA (one-time setup)
    console.log(`[ClmmSeller] Creating WSOL ATA: ${this.wsolAta.toBase58().slice(0, 12)}...`);

    const wsolMint = new PublicKey(DEFAULT_WSOL_MINT);
    const createAtaIx = createAssociatedTokenAccountInstruction(
      this.owner.publicKey,
      this.wsolAta,
      this.owner.publicKey,
      wsolMint,
      TOKEN_PROGRAM_ID
    );

    await rpcRateLimiter.waitForSlot();
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash('processed');

    const tx = new Transaction();
    tx.feePayer = this.owner.publicKey;
    tx.recentBlockhash = blockhash;
    tx.add(createAtaIx);
    tx.sign(this.owner);

    const sig = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 0,
    });

    await this.connection.confirmTransaction(
      { blockhash, lastValidBlockHeight, signature: sig },
      'processed'
    );

    console.log(`[ClmmSeller] WSOL ATA created: ${sig.slice(0, 12)}...`);
  }

  /**
   * Build/refresh an unsigned near-prebuilt legacy tx template.
   * Call this in the background whenever pool snapshot or balance changes.
   */
  async prepareSellTemplate(params: PrepareSellTemplateParams): Promise<void> {
    await this.initialize();

    const { ctx } = params;
    const sellPercent = params.sellPercent ?? 100;
    const slippageBps = params.slippageBps ?? this.config.defaultSlippageBps;
    const slippage = slippageBps / 10_000;

    if (
      !ctx.poolInfo ||
      !ctx.computePoolInfo ||
      !ctx.tickData ||
      !ctx.epochInfo
    )
      return;
    if (!ctx.tokenOut) return;
    if (!ctx.blockhash) return;
    if (ctx.tokenAmountRaw <= 0n) {
      ctx.preparedTx = undefined;
      ctx.preparedAmountIn = undefined;
      ctx.preparedMinAmountOut = undefined;
      ctx.templateUpdatedAt = Date.now();
      return;
    }

    const amountInRaw =
      (ctx.tokenAmountRaw * BigInt(Math.floor(sellPercent * 100))) / 10000n;

    if (amountInRaw <= 0n) {
      ctx.preparedTx = undefined;
      ctx.preparedAmountIn = undefined;
      ctx.preparedMinAmountOut = undefined;
      ctx.templateUpdatedAt = Date.now();
      return;
    }

    const quote = PoolUtils.computeAmountOutFormat({
      poolInfo: ctx.computePoolInfo,
      tickArrayCache: ctx.tickData[ctx.poolId],
      amountIn: new BN(amountInRaw.toString()),
      tokenOut: ctx.tokenOut,
      slippage,
      epochInfo: ctx.epochInfo,
    });

    const amountOutMin = params.forceMinOutZero
      ? new BN(0)
      : quote.minAmountOut.amount.raw;

    const inputMintPubkey = new PublicKey(ctx.inputMint);

    const built = await this.raydium!.clmm.swap({
      poolInfo: ctx.poolInfo,
      poolKeys: ctx.poolKeys,
      inputMint: inputMintPubkey,
      amountIn: new BN(amountInRaw.toString()),
      amountOutMin,
      observationId: ctx.computePoolInfo.observationId,
      ownerInfo: {
        feePayer: this.owner.publicKey,
        useSOLBalance: true, // Wrap SOL -> WSOL automatically
      },
      remainingAccounts: quote.remainingAccounts,
      txVersion: TxVersion.LEGACY,
      computeBudgetConfig: undefined,
      feePayer: this.owner.publicKey,
    });

    const builtTxs = this.extractBuiltTransactions(built);
    if (!builtTxs.length) {
      throw new Error("Raydium swap returned no built transaction");
    }

    const rawBuiltTx = builtTxs[builtTxs.length - 1];
    if (!(rawBuiltTx instanceof Transaction)) {
      throw new Error("Expected legacy transaction template");
    }

    rawBuiltTx.feePayer = this.owner.publicKey;
    rawBuiltTx.recentBlockhash = ctx.blockhash;

    // Add close WSOL ATA instruction to unwrap WSOL -> SOL at end of tx
    // The WSOL ATA is created automatically by Raydium SDK when useSOLBalance: true
    const wsolAta = this.getWsolAta();
    const closeWsolIx = createCloseAccountInstruction(
      wsolAta,
      this.owner.publicKey,
      this.owner.publicKey,
      [],
      TOKEN_PROGRAM_ID,
    );
    rawBuiltTx.add(closeWsolIx);

    const templateTx = this.addComputeAndTipToLegacyTransaction(
      rawBuiltTx,
      ctx.priorityFeeMicroLamports,
      ctx.computeUnits,
      ctx.tipLamports,
    );

    templateTx.feePayer = this.owner.publicKey;
    templateTx.recentBlockhash = ctx.blockhash;

    ctx.preparedTx = templateTx;
    ctx.preparedAmountIn = amountInRaw.toString();
    ctx.preparedMinAmountOut = amountOutMin.toString();
    ctx.templateUpdatedAt = Date.now();
  }

  /**
   * Trigger path: clone near-prebuilt template, patch blockhash, sign, send.
   */
  async emergencySell(params: EmergencySellParams): Promise<SellResult> {
    try {
      await this.initialize();

      const { ctx } = params;
      const confirmAfterSend =
        params.confirmAfterSend ?? this.config.confirmAfterSend;

      if (ctx.tokenAmountRaw <= 0n) {
        return { success: false, error: "No balance to sell" };
      }

      const feeBudget = this.estimateRequiredFeeLamports(
        ctx.computeUnits,
        ctx.priorityFeeMicroLamports,
        ctx.tipLamports,
      );

      if (ctx.lamportsBalance < feeBudget) {
        return {
          success: false,
          error: `Insufficient SOL for fees. Need ~${feeBudget}, have ${ctx.lamportsBalance}`,
        };
      }

      if (!ctx.preparedTx) {
      console.warn(
        "[ClmmSeller] No prepared template at trigger; rebuilding on hot path",
      );
      await this.prepareSellTemplate({
        ctx,
        sellPercent: params.sellPercent,
        slippageBps: params.slippageBps,
        forceMinOutZero: params.forceMinOutZero,
      });
    }

      if (!ctx.preparedTx) {
        return { success: false, error: "No prepared tx template available" };
      }

      const finalTx = this.cloneLegacyTransaction(ctx.preparedTx);
      finalTx.feePayer = this.owner.publicKey;
      finalTx.recentBlockhash = ctx.blockhash;
      finalTx.sign(this.owner);

      const sig = await this.sendViaFlashBlock(finalTx);

      if (confirmAfterSend) {
        await this.connection.confirmTransaction(
          {
            blockhash: ctx.blockhash,
            lastValidBlockHeight: ctx.lastValidBlockHeight,
            signature: sig,
          },
          "processed",
        );
      }

      return {
        success: true,
        txSignature: sig,
        amountIn: ctx.preparedAmountIn,
        minAmountOut: ctx.preparedMinAmountOut,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[ClmmSeller] Sell failed:", msg);
      return { success: false, error: msg };
    }
  }

  private cloneLegacyTransaction(tx: Transaction): Transaction {
    const cloned = new Transaction();
    cloned.feePayer = tx.feePayer ?? this.owner.publicKey;
    cloned.recentBlockhash = tx.recentBlockhash;
    for (const ix of tx.instructions) cloned.add(ix);
    return cloned;
  }

  private estimateRequiredFeeLamports(
    computeUnits: number,
    priorityFeeMicroLamports: number,
    tipLamports: number,
    signatures = 1,
  ): number {
    const baseFee = 5_000 * signatures;
    const priorityFeeLamports = Math.ceil(
      (computeUnits * priorityFeeMicroLamports) / 1_000_000,
    );
    return baseFee + priorityFeeLamports + tipLamports;
  }

  private randomTipWallet(): PublicKey {
    const chosen =
      RELAY_TIP_WALLETS[Math.floor(Math.random() * RELAY_TIP_WALLETS.length)];
    return new PublicKey(chosen);
  }

  private addComputeAndTipToLegacyTransaction(
    tx: Transaction,
    priorityFeeMicroLamports: number,
    computeUnits: number,
    tipLamports: number,
  ): Transaction {
    const tipIx = SystemProgram.transfer({
      fromPubkey: this.owner.publicKey,
      toPubkey: this.randomTipWallet(),
      lamports: Math.max(tipLamports, MIN_TIP_LAMPORTS),
    });

    const finalTx = new Transaction();
    finalTx.feePayer = tx.feePayer ?? this.owner.publicKey;
    finalTx.recentBlockhash = tx.recentBlockhash;

    // Optimal order for fast bots:
    // 1. Compute budget instructions
    // 2. Tip transfer (before swap for priority)
    // 3. Swap instructions
    // 4. Cleanup / close WSOL
    finalTx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: priorityFeeMicroLamports,
      }),
      tipIx
    );

    for (const ix of tx.instructions) finalTx.add(ix);

    return finalTx;
  }

  private extractBuiltTransactions(
    built: any,
  ): Array<Transaction | VersionedTransaction> {
    const out: Array<Transaction | VersionedTransaction> = [];

    if (built?.transaction) {
      if (Array.isArray(built.transaction)) {
        for (const tx of built.transaction) if (tx) out.push(tx);
      } else {
        out.push(built.transaction);
      }
    }

    if (Array.isArray(built?.transactions)) {
      for (const tx of built.transactions) if (tx) out.push(tx);
    }

    const allTxData = built?.builder?.allTxData;
    if (Array.isArray(allTxData)) {
      for (const item of allTxData) {
        const tx = item?.transaction ?? item?.tx ?? item;
        if (tx && !out.includes(tx)) out.push(tx);
      }
    }

    return out;
  }

  private async sendToSingleFlashBlock(
    url: string,
    base64Tx: string,
  ): Promise<string> {
    const payload = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "sendTransaction",
      params: [
        [base64Tx],
        {
          encoding: "base64",
          skipPreflight: true,
          maxRetries: 0,
        },
      ],
    };

    const resp = await this.raydiumHttp.post<FlashBlockResp>(url, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: this.flashblockApiKey,
      },
    });

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(
        `FlashBlock HTTP ${resp.status}: ${JSON.stringify(resp.data)}`,
      );
    }

    if (resp.data.error) {
      throw new Error(
        `FlashBlock error ${resp.data.error.code}: ${resp.data.error.message}`,
      );
    }

    if (!resp.data.result) {
      throw new Error(
        `FlashBlock returned no signature: ${JSON.stringify(resp.data)}`,
      );
    }

    return resp.data.result;
  }

  /**
   * Send to Helius Sender endpoint.
   * Helius Sender routes transactions through SWQoS and Jito in parallel.
   */
  private async sendToHeliusSender(base64Tx: string): Promise<string> {
    if (!this.heliusSenderUrl) {
      throw new Error("Helius Sender URL not configured");
    }

    const payload = {
      jsonrpc: "2.0",
      id: Date.now(),
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

    const resp = await this.raydiumHttp.post<FlashBlockResp>(
      this.heliusSenderUrl,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(
        `Helius Sender HTTP ${resp.status}: ${JSON.stringify(resp.data)}`,
      );
    }

    if (resp.data.error) {
      throw new Error(
        `Helius Sender error ${resp.data.error.code}: ${resp.data.error.message}`,
      );
    }

    if (!resp.data.result) {
      throw new Error(
        `Helius Sender returned no signature: ${JSON.stringify(resp.data)}`,
      );
    }

    return resp.data.result;
  }

  /**
   * Multi-endpoint broadcast: sign once, serialize once, fan out to all endpoints.
   * Uses Promise.any to race FlashBlock primary/backup + Helius Sender.
   * First successful response wins.
   */
  private async sendViaFlashBlock(
    tx: Transaction | VersionedTransaction,
  ): Promise<string> {
    const raw = tx.serialize();
    const base64Tx = Buffer.from(raw).toString("base64");

    // Build list of send promises
    const sendPromises: Promise<string>[] = [];

    // Add FlashBlock endpoints
    for (const url of this.flashblockUrls) {
      sendPromises.push(this.sendToSingleFlashBlock(url, base64Tx));
    }

    // Add Helius Sender if configured
    if (this.heliusSenderUrl) {
      sendPromises.push(this.sendToHeliusSender(base64Tx));
    }

    if (sendPromises.length === 0) {
      throw new Error("No send endpoints configured");
    }

    // Race all endpoints - first success wins
    return Promise.any(sendPromises).catch((err) => {
      throw new Error(`All endpoints failed: ${String(err)}`);
    });
  }
}
