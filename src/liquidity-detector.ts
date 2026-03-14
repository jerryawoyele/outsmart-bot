import { Connection, PublicKey } from '@solana/web3.js';
import { 
  HeliusLogMessage, 
  LiquidityRemovalEvent, 
  RAYDIUM_CLMM_PROGRAM_ID,
  RAYDIUM_CLMM_DISCRIMINATORS 
} from './types.js';

export interface LiquidityDetectorConfig {
  rpcUrl: string;
  onLiquidityRemoval: (event: LiquidityRemovalEvent) => void;
}

/**
 * Detects liquidity removal from Raydium CLMM pools
 * Parses transaction logs and instructions to identify dev rug pulls
 */
export class LiquidityDetector {
  private connection: Connection;
  private onRemoval: (event: LiquidityRemovalEvent) => void;

  constructor(config: LiquidityDetectorConfig) {
    this.connection = new Connection(config.rpcUrl, 'processed');
    this.onRemoval = config.onLiquidityRemoval;
  }

  /**
   * Process a log message from Helius
   * Check if it's a liquidity removal from a tracked dev
   */
  async processLogMessage(
    log: HeliusLogMessage, 
    trackedDevs: Map<string, Set<string>>
  ): Promise<LiquidityRemovalEvent | null> {
    // Skip failed transactions
    if (log.err) {
      return null;
    }

    // Check if any tracked dev is involved
    const devAddress = this.findTrackedDev(log, trackedDevs);
    if (!devAddress) {
      return null;
    }

    // Fetch full transaction to analyze instructions
    try {
      const tx = await this.connection.getParsedTransaction(log.signature, {
        maxSupportedTransactionVersion: 0,
      });

      if (!tx) {
        return null;
      }

      // Check for Raydium CLMM liquidity removal instructions
      const removalEvent = this.detectClmmRemoval(tx, devAddress, log.signature);
      if (removalEvent) {
        this.onRemoval(removalEvent);
        return removalEvent;
      }

      return null;
    } catch (error) {
      console.error(`[Detector] Error processing tx ${log.signature}:`, error);
      return null;
    }
  }

  /**
   * Find if any tracked dev is mentioned in the transaction
   */
  private findTrackedDev(
    log: HeliusLogMessage, 
    trackedDevs: Map<string, Set<string>>
  ): string | null {
    // Check log messages for dev addresses
    for (const [devAddress, tokens] of trackedDevs) {
      if (log.logs.some((l) => l.includes(devAddress))) {
        return devAddress;
      }
    }
    return null;
  }

  /**
   * Detect Raydium CLMM liquidity removal from transaction
   */
  private detectClmmRemoval(
    tx: unknown,
    devAddress: string,
    signature: string
  ): LiquidityRemovalEvent | null {
    const parsedTx = tx as {
      transaction: {
        message: {
          accountKeys?: Array<{ pubkey: PublicKey; signer: boolean }>;
          instructions?: Array<{
            programId: PublicKey;
            data: string;
            accounts: string[];
          }>;
        };
      };
      meta?: {
        preBalances?: number[];
        postBalances?: number[];
        preTokenBalances?: Array<{ accountIndex: number; mint: string; uiTokenAmount: { amount: string } }>;
        postTokenBalances?: Array<{ accountIndex: number; mint: string; uiTokenAmount: { amount: string } }>;
      };
    };

    const message = parsedTx.transaction?.message;
    if (!message) return null;

    // Check each instruction for CLMM program calls
    const instructions = message.instructions || [];
    for (const ix of instructions) {
      const programId = ix.programId.toBase58();
      
      if (programId !== RAYDIUM_CLMM_PROGRAM_ID) {
        continue;
      }

      // Decode instruction data
      const data = Buffer.from(ix.data, 'base64');
      const discriminator = data.slice(0, 8);

      // Check if it's a liquidity removal instruction
      if (this.matchesDiscriminator(discriminator, RAYDIUM_CLMM_DISCRIMINATORS.DECREASE_LIQUIDITY) ||
          this.matchesDiscriminator(discriminator, RAYDIUM_CLMM_DISCRIMINATORS.CLOSE_POSITION)) {
        
        // Extract pool address from accounts
        // CLMM decrease_liquidity accounts: [position, lockPosition?, pool, protocolPosition, tokenAccount0, tokenAccount1, ...]
        const poolAddress = ix.accounts[2]; // Pool is typically 3rd account
        
        // Determine which token is affected based on balance changes
        const tokenMint = this.extractAffectedToken(parsedTx.meta, message.accountKeys || []);

        return {
          devAddress,
          tokenMint: tokenMint || 'UNKNOWN',
          poolAddress,
          amountRemoved: 0n, // Would need to parse instruction data for exact amount
          timestamp: Date.now(),
          txSignature: signature,
        };
      }
    }

    return null;
  }

  /**
   * Check if discriminator matches
   */
  private matchesDiscriminator(data: Buffer, expected: Uint8Array): boolean {
    if (data.length < 8) return false;
    for (let i = 0; i < 8; i++) {
      if (data[i] !== expected[i]) return false;
    }
    return true;
  }

  /**
   * Extract affected token from balance changes
   */
  private extractAffectedToken(
    meta: { 
      preTokenBalances?: Array<{ accountIndex: number; mint: string; uiTokenAmount: { amount: string } }>;
      postTokenBalances?: Array<{ accountIndex: number; mint: string; uiTokenAmount: { amount: string } }>;
    } | undefined,
    accountKeys: Array<{ pubkey: PublicKey }>
  ): string | null {
    if (!meta?.preTokenBalances || !meta?.postTokenBalances) {
      return null;
    }

    // Find token with decreased balance (being removed)
    for (const pre of meta.preTokenBalances) {
      const post = meta.postTokenBalances.find((p) => p.accountIndex === pre.accountIndex);
      if (post) {
        const preAmount = BigInt(pre.uiTokenAmount.amount);
        const postAmount = BigInt(post.uiTokenAmount.amount);
        if (preAmount > postAmount) {
          return pre.mint;
        }
      }
    }

    return null;
  }
}
