import axios from "axios";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction,
  PublicKey,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  getMint,
} from "@solana/spl-token";
import { API_URLS } from "@raydium-io/raydium-sdk-v2";

type PriorityFeeResp = {
  id: string;
  success: boolean;
  data: { default: { vh: number; h: number; m: number } };
};

type SwapComputeResp = {
  id: string;
  success: boolean;
  version: "V0" | "V1";
  data: {
    swapType: "BaseIn" | "BaseOut";
    inputMint: string;
    inputAmount: string;
    outputMint: string;
    outputAmount: string;
    otherAmountThreshold: string;
    slippageBps: number;
    priceImpactPct: number;
    routePlan: Array<{
      poolId: string;
      inputMint: string;
      outputMint: string;
      feeMint: string;
      feeRate: number;
      feeAmount: string;
    }>;
  };
};

type SwapTxResp = {
  id: string;
  version: string;
  success: boolean;
  data: Array<{ transaction: string }>;
};

export interface RaydiumSwapSellerConfig {
  rpcUrl: string;
  privateKey: string;
  defaultSlippageBps?: number;
  computeUnitPriceMicroLamports?: number;
  txVersion?: "V0" | "V1";
}

export interface SellResult {
  success: boolean;
  txSignature?: string;
  amountIn?: string;
  amountOut?: string;
  error?: string;
  quoteResponse?: SwapComputeResp;
}

export class RaydiumSwapSeller {
  private config: RaydiumSwapSellerConfig;
  private owner: Keypair;
  private connection: Connection;

  constructor(config: RaydiumSwapSellerConfig) {
    this.config = config;
    this.owner = Keypair.fromSecretKey(bs58.decode(config.privateKey));
    this.connection = new Connection(config.rpcUrl, "confirmed");
  }

  async initialize(): Promise<void> {
    console.log("[RaydiumSwapSeller] Initialized");
    console.log(`[RaydiumSwapSeller] Wallet: ${this.owner.publicKey.toBase58()}`);
  }

  getOwnerPubkey(): PublicKey {
    return this.owner.publicKey;
  }

  /**
   * Find token account with balance for a given mint
   */
  private async findTokenAccount(
    mint: PublicKey
  ): Promise<{
    pubkey: PublicKey;
    amountRaw: bigint;
    programId: PublicKey;
  } | null> {
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const resp = await this.connection.getTokenAccountsByOwner(this.owner.publicKey, {
        mint,
        programId,
      });

      for (const item of resp.value) {
        const bal = await this.connection.getTokenAccountBalance(item.pubkey);
        const amountRaw = BigInt(bal.value.amount);
        if (amountRaw > 0n) {
          return {
            pubkey: item.pubkey,
            amountRaw,
            programId,
          };
        }
      }
    }

    return null;
  }

  /**
   * Get mint decimals (handles both TOKEN_PROGRAM_ID and TOKEN_2022_PROGRAM_ID)
   */
  private async getMintDecimals(mint: PublicKey): Promise<number> {
    try {
      const mintInfo = await getMint(
        this.connection,
        mint,
        "confirmed",
        TOKEN_PROGRAM_ID
      );
      return mintInfo.decimals;
    } catch {
      const mintInfo = await getMint(
        this.connection,
        mint,
        "confirmed",
        TOKEN_2022_PROGRAM_ID
      );
      return mintInfo.decimals;
    }
  }

  /**
   * Emergency sell using Raydium swap API:
   * 1. Find token account
   * 2. Get priority fee
   * 3. Get quote
   * 4. Build transaction
   * 5. Sign and send
   */
  async emergencySell(params: {
    inputMint: string;
    tokenAccount?: string;
    sellPercent?: number;
    slippageBps?: number;
    computeUnitPriceMicroLamports?: number;
  }): Promise<SellResult> {
    const sellPercent = params.sellPercent ?? 100;
    const slippageBps = params.slippageBps ?? this.config.defaultSlippageBps ?? 500;
    const computeUnitPrice = params.computeUnitPriceMicroLamports ?? 
      this.config.computeUnitPriceMicroLamports ?? 150000;
    const txVersion = this.config.txVersion ?? "V0";
    const isV0Tx = txVersion === "V0";

    console.log(`[RaydiumSwapSeller] EMERGENCY SELL for ${params.inputMint.slice(0, 8)}...`);

    try {
      const inputMint = new PublicKey(params.inputMint);
      const outputMint = NATIVE_MINT;

      // 1) Find token account
      let tokenAccPubkey: PublicKey;
      let amountRaw: bigint;

      if (params.tokenAccount) {
        tokenAccPubkey = new PublicKey(params.tokenAccount);
        const bal = await this.connection.getTokenAccountBalance(tokenAccPubkey);
        amountRaw = BigInt(bal.value.amount);
      } else {
        const tokenAcc = await this.findTokenAccount(inputMint);
        if (!tokenAcc) {
          return { success: false, error: "No token account with balance found for this mint" };
        }
        tokenAccPubkey = tokenAcc.pubkey;
        amountRaw = tokenAcc.amountRaw;
      }

      if (amountRaw <= 0n) {
        return { success: false, error: "No balance to sell" };
      }

      // Calculate amount to sell
      const amountToSell = (amountRaw * BigInt(Math.floor(sellPercent * 100))) / 10000n;

      if (amountToSell <= 0n) {
        return { success: false, error: "Calculated sell amount is 0" };
      }

      console.log(`[RaydiumSwapSeller] Selling ${amountToSell.toString()} tokens (${sellPercent}%)`);
      console.log(`[RaydiumSwapSeller] Token account: ${tokenAccPubkey.toBase58().slice(0, 12)}...`);

      // 2) Get priority fee suggestion from Raydium
      const feeResp = await axios.get<PriorityFeeResp>(
        `${API_URLS.BASE_HOST}${API_URLS.PRIORITY_FEE}`
      );
      const suggestedCuPrice = String(feeResp.data.data.default.h);
      console.log(`[RaydiumSwapSeller] Suggested priority fee: ${suggestedCuPrice}, using: ${computeUnitPrice}`);

      // 3) Get quote
      const quoteUrl =
        `${API_URLS.SWAP_HOST}/compute/swap-base-in` +
        `?inputMint=${inputMint.toBase58()}` +
        `&outputMint=${outputMint.toBase58()}` +
        `&amount=${amountToSell.toString()}` +
        `&slippageBps=${slippageBps}` +
        `&txVersion=${txVersion}`;

      console.log("[RaydiumSwapSeller] Fetching quote...");
      const quoteResp = await axios.get<SwapComputeResp>(quoteUrl);

      if (!quoteResp.data.success) {
        return {
          success: false,
          error: `Raydium quote request failed: ${JSON.stringify(quoteResp.data)}`,
        };
      }

      console.log(`[RaydiumSwapSeller] Quoted output: ${quoteResp.data.data.outputAmount}`);
      console.log(`[RaydiumSwapSeller] Price impact: ${quoteResp.data.data.priceImpactPct}%`);
      console.log(`[RaydiumSwapSeller] Route pools: ${quoteResp.data.data.routePlan.map(r => r.poolId.slice(0, 8)).join(', ')}`);

      // 4) Build swap transaction
      let txResp;
      try {
        txResp = await axios.post<SwapTxResp>(
          `${API_URLS.SWAP_HOST}/transaction/swap-base-in`,
          {
            computeUnitPriceMicroLamports: String(computeUnitPrice),
            swapResponse: quoteResp.data,
            txVersion,
            wallet: this.owner.publicKey.toBase58(),
            wrapSol: false,
            unwrapSol: true,
            inputAccount: tokenAccPubkey.toBase58(),
          }
        );
      } catch (e: any) {
        const errData = e?.response?.data ?? e;
        console.error(`[RaydiumSwapSeller] Transaction build HTTP error: ${JSON.stringify(errData)}`);
        return {
          success: false,
          error: `Transaction build failed: ${JSON.stringify(errData)}`,
        };
      }

      if (!txResp.data.success || !txResp.data.data?.length) {
        return {
          success: false,
          error: `Raydium transaction build failed: ${JSON.stringify(txResp.data)}`,
          quoteResponse: quoteResp.data,
        };
      }

      console.log(`[RaydiumSwapSeller] Built ${txResp.data.data.length} transaction(s)`);

      // 5) Sign and send transactions
      const txBuffers = txResp.data.data.map((t) => Buffer.from(t.transaction, "base64"));
      const txs = txBuffers.map((buf) =>
        isV0Tx ? VersionedTransaction.deserialize(buf) : Transaction.from(buf)
      );

      let lastSig: string | undefined;
      let sent = 0;

      for (const tx of txs) {
        sent++;

        if (isV0Tx) {
          const vtx = tx as VersionedTransaction;
          vtx.sign([this.owner]);

          const sig = await this.connection.sendTransaction(vtx, {
            skipPreflight: true,
            maxRetries: 3,
          });

          console.log(`[RaydiumSwapSeller] [${sent}/${txs.length}] Sent: ${sig}`);

          const latest = await this.connection.getLatestBlockhash("confirmed");
          await this.connection.confirmTransaction(
            {
              blockhash: latest.blockhash,
              lastValidBlockHeight: latest.lastValidBlockHeight,
              signature: sig,
            },
            "confirmed"
          );

          console.log(`[RaydiumSwapSeller] [${sent}/${txs.length}] Confirmed: ${sig}`);
          lastSig = sig;
        } else {
          const legacyTx = tx as Transaction;
          legacyTx.sign(this.owner);

          const sig = await this.connection.sendRawTransaction(legacyTx.serialize(), {
            skipPreflight: true,
            maxRetries: 3,
          });

          console.log(`[RaydiumSwapSeller] [${sent}/${txs.length}] Sent: ${sig}`);

          const latest = await this.connection.getLatestBlockhash("confirmed");
          await this.connection.confirmTransaction(
            {
              blockhash: latest.blockhash,
              lastValidBlockHeight: latest.lastValidBlockHeight,
              signature: sig,
            },
            "confirmed"
          );

          console.log(`[RaydiumSwapSeller] [${sent}/${txs.length}] Confirmed: ${sig}`);
          lastSig = sig;
        }
      }

      console.log(`[RaydiumSwapSeller] ✅ Sell complete: ${lastSig}`);

      return {
        success: true,
        txSignature: lastSig,
        amountIn: amountToSell.toString(),
        amountOut: quoteResp.data.data.outputAmount,
        quoteResponse: quoteResp.data,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[RaydiumSwapSeller] Sell failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }
}
