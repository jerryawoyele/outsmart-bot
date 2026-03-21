import {
  Commitment,
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { rpcRateLimiter } from "./rpc-rate-limiter.js";

const ULTRA_BASE = "https://api.jup.ag/ultra/v1";
const SOL_MINT = "So11111111111111111111111111111111111111112";

export interface JupiterSellerConfig {
  rpcUrl: string;
  privateKey: string;
  jupiterApiKey: string;
  defaultSlippageBps?: number;
  defaultPriorityFeeLamports?: number;
  broadcastFeeType?: 'maxCap' | 'exactFee';
  jitoTipLamports?: number;
  commitment?: Commitment;
}

export interface SellResult {
  success: boolean;
  txSignature?: string;
  amountIn?: string;
  status?: string;
  requestId?: string;
  error?: string;
  orderResponse?: any;
  executeResponse?: any;
}

type PreparedSellContext = {
  key: string;
  inputMint: string;
  tokenAccount: PublicKey;
};

export class JupiterUltraSeller {
  private readonly config: Required<
    Pick<JupiterSellerConfig, "defaultSlippageBps" | "defaultPriorityFeeLamports" | "commitment">
  > & {
    broadcastFeeType?: 'maxCap' | 'exactFee';
    jitoTipLamports?: number;
  };

  private connection: Connection;
  private owner: Keypair;
  private jupiterApiKey: string;

  private prepared = new Map<string, PreparedSellContext>();

  constructor(config: JupiterSellerConfig) {
    this.config = {
      defaultSlippageBps: config.defaultSlippageBps ?? 10000,
      defaultPriorityFeeLamports: config.defaultPriorityFeeLamports ?? 150000,
      commitment: config.commitment ?? "processed",
      broadcastFeeType: config.broadcastFeeType,
      jitoTipLamports: config.jitoTipLamports,
    };

    this.connection = new Connection(config.rpcUrl, this.config.commitment);
    this.owner = Keypair.fromSecretKey(bs58.decode(config.privateKey));
    this.jupiterApiKey = config.jupiterApiKey;
  }

  async initialize(): Promise<void> {
    console.log(`[JupiterUltraSeller] Wallet: ${this.owner.publicKey.toBase58()}`);
  }

  getOwnerPubkey(): PublicKey {
    return this.owner.publicKey;
  }

  /**
   * Prepare a sell context. Just stores inputMint and tokenAccount for fast lookup.
   * Balance caching is handled by helius-client via accountSubscribe.
   */
  async prepareEmergencySell(params: {
    inputMint: string;
    tokenAccount: string;
  }): Promise<string> {
    const inputMint = params.inputMint;
    const tokenAccount = new PublicKey(params.tokenAccount);

    const key = `${inputMint}:${tokenAccount.toBase58()}`;

    // Check if already prepared
    if (this.prepared.has(key)) {
      return key;
    }

    const ctx: PreparedSellContext = {
      key,
      inputMint,
      tokenAccount,
    };

    this.prepared.set(key, ctx);
    return key;
  }

  /**
   * Fast trigger path.
   * Uses cached balance passed from helius-client.
   */
  async emergencySellPrepared(params: {
    prepKey: string;
    cachedBalance?: bigint; // Passed from helius-client
    sellPercent?: number;
    slippageBps?: number;
    priorityFeeLamports?: number;
    broadcastFeeType?: 'maxCap' | 'exactFee';
    jitoTipLamports?: number;
  }): Promise<SellResult> {
    const ctx = this.prepared.get(params.prepKey);
    if (!ctx) {
      return { success: false, error: "Prepared context not found" };
    }

    const sellPercent = params.sellPercent ?? 100;
    const slippageBps = params.slippageBps ?? this.config.defaultSlippageBps;
    const priorityFeeLamports =
      params.priorityFeeLamports ?? this.config.defaultPriorityFeeLamports;
    const broadcastFeeType = params.broadcastFeeType ?? this.config.broadcastFeeType;
    const jitoTipLamports = params.jitoTipLamports ?? this.config.jitoTipLamports;

    try {
      // Use cached balance from helius-client, fallback to RPC
      let amountRaw = params.cachedBalance;

      if (amountRaw === undefined) {
        await rpcRateLimiter.waitForSlot();
        const bal = await this.connection.getTokenAccountBalance(
          ctx.tokenAccount,
          this.config.commitment
        );
        amountRaw = BigInt(bal.value.amount);
      }

      if (amountRaw <= 0n) {
        return { success: false, error: "No balance to sell" };
      }

      const amountIn = (amountRaw * BigInt(Math.floor(sellPercent * 100))) / 10000n;
      if (amountIn <= 0n) {
        return { success: false, error: "Calculated sell amount is 0" };
      }

      // Build /order query
      const qs = new URLSearchParams({
        inputMint: ctx.inputMint,
        outputMint: SOL_MINT,
        amount: amountIn.toString(),
        taker: this.owner.publicKey.toBase58(),
      });

      if (typeof slippageBps === "number") {
        qs.set("slippageBps", String(slippageBps));
      }

      if (typeof priorityFeeLamports === "number") {
        qs.set("priorityFeeLamports", String(priorityFeeLamports));
      }

      if (broadcastFeeType) {
        qs.set("broadcastFeeType", broadcastFeeType);
      }

      if (typeof jitoTipLamports === "number") {
        qs.set("jitoTipLamports", String(jitoTipLamports));
      }

      const orderUrl = `${ULTRA_BASE}/order?${qs.toString()}`;

      let orderResp: Response;
      try {
        orderResp = await fetch(orderUrl, {
          method: "GET",
          headers: {
            "x-api-key": this.jupiterApiKey,
            Accept: "application/json",
          },
        });
      } catch (fetchErr) {
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        const cause = fetchErr instanceof Error && 'cause' in fetchErr ? String((fetchErr as any).cause) : '';
        return { success: false, error: `Order fetch failed: ${msg}${cause ? ` (${cause})` : ''}` };
      }

      let orderJson: any;
      try {
        orderJson = await orderResp.json();
      } catch (parseErr) {
        return { success: false, error: `Order parse failed: ${parseErr}` };
      }

      if (!orderResp.ok) {
        return {
          success: false,
          error: `Ultra order HTTP ${orderResp.status}: ${JSON.stringify(orderJson)}`,
          orderResponse: orderJson,
        };
      }

      if (!orderJson?.transaction || !orderJson?.requestId) {
        return {
          success: false,
          error: `Ultra order missing transaction/requestId: ${JSON.stringify(orderJson)}`,
          orderResponse: orderJson,
        };
      }

      // Sign
      const tx = VersionedTransaction.deserialize(
        Buffer.from(orderJson.transaction, "base64")
      );
      tx.sign([this.owner]);
      const signedTransaction = Buffer.from(tx.serialize()).toString("base64");

      // Execute
      let executeResp: Response;
      try {
        executeResp = await fetch(`${ULTRA_BASE}/execute`, {
          method: "POST",
          headers: {
            "x-api-key": this.jupiterApiKey,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            signedTransaction,
            requestId: orderJson.requestId,
          }),
        });
      } catch (fetchErr) {
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        const cause = fetchErr instanceof Error && 'cause' in fetchErr ? String((fetchErr as any).cause) : '';
        return {
          success: false,
          requestId: orderJson.requestId,
          error: `Execute fetch failed: ${msg}${cause ? ` (${cause})` : ''}`,
          orderResponse: orderJson,
        };
      }

      let executeJson: any;
      try {
        executeJson = await executeResp.json();
      } catch (parseErr) {
        return {
          success: false,
          requestId: orderJson.requestId,
          error: `Execute parse failed: ${parseErr}`,
          orderResponse: orderJson,
        };
      }

      if (!executeResp.ok) {
        return {
          success: false,
          requestId: orderJson.requestId,
          error: `Ultra execute HTTP ${executeResp.status}: ${JSON.stringify(executeJson)}`,
          orderResponse: orderJson,
          executeResponse: executeJson,
        };
      }

      const status = executeJson?.status;
      const signature = executeJson?.signature ?? executeJson?.txid;

      if (status !== "Success") {
        return {
          success: false,
          txSignature: signature,
          requestId: orderJson.requestId,
          status,
          amountIn: amountIn.toString(),
          error: `Ultra execute returned non-success status: ${JSON.stringify(executeJson)}`,
          orderResponse: orderJson,
          executeResponse: executeJson,
        };
      }

      console.log(`[JupiterUltraSeller] ✅ ${signature}`);

      return {
        success: true,
        txSignature: signature,
        amountIn: amountIn.toString(),
        requestId: orderJson.requestId,
        status,
        orderResponse: orderJson,
        executeResponse: executeJson,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[JupiterUltraSeller] Sell failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Legacy compatibility wrapper.
   */
  async emergencySell(params: {
    inputMint: string;
    tokenAccount: string;
    cachedBalance?: bigint;
    sellPercent?: number;
    slippageBps?: number;
    priorityFeeLamports?: number;
    broadcastFeeType?: 'maxCap' | 'exactFee';
    jitoTipLamports?: number;
  }): Promise<SellResult> {
    const prepKey = `${params.inputMint}:${params.tokenAccount}`;

    let matchedKey: string | undefined;
    for (const key of this.prepared.keys()) {
      if (key === prepKey) {
        matchedKey = key;
        break;
      }
    }

    if (!matchedKey) {
      matchedKey = await this.prepareEmergencySell({
        inputMint: params.inputMint,
        tokenAccount: params.tokenAccount,
      });
    }

    return this.emergencySellPrepared({
      prepKey: matchedKey ?? prepKey,
      cachedBalance: params.cachedBalance,
      sellPercent: params.sellPercent,
      slippageBps: params.slippageBps,
      priorityFeeLamports: params.priorityFeeLamports,
      broadcastFeeType: params.broadcastFeeType,
      jitoTipLamports: params.jitoTipLamports,
    });
  }

  async stopPrepared(prepKey: string): Promise<void> {
    this.prepared.delete(prepKey);
  }

  async shutdown(): Promise<void> {
    this.prepared.clear();
  }

  getPreparedState(prepKey: string) {
    const ctx = this.prepared.get(prepKey);
    if (!ctx) return null;

    return {
      prepKey: ctx.key,
      inputMint: ctx.inputMint,
      tokenAccount: ctx.tokenAccount.toBase58(),
    };
  }
}
