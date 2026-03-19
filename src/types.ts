/**
 * Token position with associated dev info and LP data
 */
export interface TokenPosition {
  tokenMint: string;
  poolAddress: string;
  dex: string;
  devAddress: string;
  devTokenAccount?: string; // Dev's token account to monitor for CLOSE_ACCOUNT
  fastDetectionAccount?: string; // Fast-detection account for rug monitoring (receives notifications faster)
  walletTokenAccount?: string; // Wallet's token account to sell from
  poolKeys?: any; // Preloaded CLMM pool keys (observationId, vaults, config, etc.)
  lpMint?: string; // LP token mint for the pool
  devLpTokenAccount?: string; // Dev's LP token account
  amountHeld: bigint;
  decimals: number;
  addedAt: number;
  hasLiquidity: boolean;
  txCount: number; // Track number of txs for this token (1 = mint, 2 = close = rug)
  prepKey?: string; // Prepared sell context key for fast trigger
}

/**
 * Tracked dev wallet with their tokens
 */
export interface DevWallet {
  address: string;
  tokens: Set<string>; // token mints this dev created
}

/**
 * Liquidity removal event detected from dev tx
 */
export interface LiquidityRemovalEvent {
  devAddress: string;
  tokenMint: string;
  poolAddress: string;
  amountRemoved: bigint;
  timestamp: number;
  txSignature: string;
}

/**
 * Helius logsSubscribe message
 */
export interface HeliusLogMessage {
  signature: string;
  err: unknown;
  logs: string[];
}

/**
 * Helius WebSocket subscription params
 */
export interface LogsSubscribeFilter {
  mentions: string[]; // accounts to filter by
}

export interface LogsSubscribeParams {
  filter: LogsSubscribeFilter | { kind: string };
}

/**
 * Raydium CLMM Program ID (all tokens are on CLMM pools)
 */
export const RAYDIUM_CLMM_PROGRAM_ID = 'CAMMCzo5YL8w4VFFVLKVxDV7CqAd24p3pSWjXXeDbQva';

/**
 * Raydium CLMM instruction discriminators for liquidity operations
 * Based on Raydium CLMM IDL
 */
export const RAYDIUM_CLMM_DISCRIMINATORS = {
  // decrease_liquidity - when dev removes liquidity
  DECREASE_LIQUIDITY: new Uint8Array([0x8f, 0x2c, 0xd9, 0x4a, 0x3d, 0x9a, 0x4d, 0x9c]),
  // close_position - when dev closes position entirely
  CLOSE_POSITION: new Uint8Array([0x3d, 0x2b, 0x1a, 0x6c, 0x4f, 0x5e, 0x3b, 0x8a]),
  // collect_protocol_fee - sometimes used before removing
  COLLECT_PROTOCOL_FEE: new Uint8Array([0x6b, 0x4a, 0x7c, 0x3d, 0x2e, 0x5f, 0x1a, 0x9b]),
} as const;
