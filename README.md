# Rug Defense Bot

Auto-sells your Raydium CLMM token positions when the dev removes liquidity.

## How It Works

1. **Monitors dev wallets** via Helius WebSocket `logsSubscribe`
2. **Detects liquidity removal** from Raydium CLMM pools (decrease_liquidity, close_position instructions)
3. **Emergency sells** your position using outsmart library with increasing slippage tiers

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in:

```env
# Helius WebSocket URL (get from helius.dev)
HELIUS_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY

# Solana RPC (can use same Helius HTTP endpoint)
MAINNET_ENDPOINT=https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY

# Your wallet private key (base58 encoded)
PRIVATE_KEY=your_base58_private_key_here

# Your wallet address
WALLET_ADDRESS=your_wallet_address_here

# Optional: Priority fee (microLamports)
PRIORITY_FEE=100000

# Optional: Default slippage (bps)
DEFAULT_SLIPPAGE_BPS=500

# Optional: Tip for TX landing (SOL)
TIP_SOL=0.001
```

### 3. Run

```bash
npm start
```

## Adding New Positions

The bot auto-loads positions from your wallet on startup. For new buys, you can also manually add positions:

```typescript
// In your buy flow, after successful purchase:
await bot.addPosition(
  tokenMint,    // Token mint address
  poolAddress,  // Raydium CLMM pool address
  amountHeld,   // Amount of tokens (bigint)
  decimals      // Token decimals
);
```

## Architecture

```
src/
├── index.ts              # Main bot orchestration
├── helius-client.ts      # WebSocket client for logsSubscribe
├── position-tracker.ts   # Track positions and dev addresses
├── liquidity-detector.ts # Parse txs for LP removal
├── seller.ts             # Sell via outsmart library
└── types.ts              # TypeScript types & constants
```

## Emergency Sell Strategy

When liquidity removal is detected, the bot tries to sell with increasing slippage:

1. 5% slippage
2. 10% slippage  
3. 20% slippage
4. 50% slippage

Each attempt uses 2x priority fee and tip for faster landing.

## Requirements

- Node.js 18+
- Helius API key (free tier works)
- Wallet with private key

## Notes

- Only works with **Raydium CLMM** pools
- Dev address is fetched from pool creation transaction
- Uses outsmart as a library (not CLI) for programmatic control
