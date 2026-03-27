# HIP-4 Telegram Bot — Plan

## Goal

Fork `polymarket-trading-bot` into a standalone HyperLiquid HIP-4 outcome-trading Telegram bot.
Remove all Polymarket-specific logic. Replace with HyperLiquid HIP-4 API integration.
Keep the same UX pattern: single-user Telegram bot, wallet management, market browsing, trading, positions, orders.

## Non-Goals

- Multi-exchange support (no Polymarket+HL combo)
- HyperLiquid perps/spot trading (only HIP-4 outcomes)
- Strategy system (defer to Phase 2 — get core trading working first)
- On-chain operations (no split/merge/redeem — HL outcomes are native CLOB)
- AI translation (keep i18n but remove OpenRouter dependency for MVP)

## Architecture

### What stays (reuse as-is or with minor edits)

| Module | Lines | Changes |
|--------|-------|---------|
| `src/modules/auth.js` | 277 | Replace Polymarket wallet gen → HL private key import/generate |
| `src/modules/config.js` | 272 | Adapt config fields (remove CLOB creds, add HL-specific) |
| `src/modules/database.js` | 673 | Adapt table schemas (outcomes instead of markets) |
| `src/modules/logger.js` | 542 | As-is |
| `src/modules/proxy.js` | 497 | As-is |
| `src/modules/i18n.js` | 66 | As-is |
| `src/modules/bot/runtime.js` | — | Minor: remove Polymarket-specific state keys |
| `src/modules/bot/constants.js` | — | Adapt constants |
| `src/modules/bot/ui/keyboards.js` | — | Rebuild for HL outcome UX |
| `src/modules/bot/ui/formatters.js` | — | Rebuild for HL outcome data |
| `src/modules/bot/routing/` | — | Adapt routes |
| `src/index.js` | 155 | Minor: remove Polymarket SDK init |
| `ecosystem.config.cjs` | — | Rename app |

### What gets replaced entirely

| Old Module | New Module | Purpose |
|-----------|-----------|---------|
| `polymarket.js` (3601 lines) | `hyperliquid.js` | HL API client: info, exchange, signing |
| `workers.js` (1379 lines) | `workers.js` | Positions sync, order monitoring (HL API) |
| `strategyMarketWatcher.js` (627 lines) | DELETE (Phase 2) | Strategy scanner — not needed for MVP |
| `constants.js` (43 lines) | `constants.js` | HL chain config, API URLs, encoding helpers |
| `bot.js` (2996 lines) | `bot.js` | Rewire features, remove Polymarket refs |
| `features/markets.js` | `features/outcomes.js` | Browse HIP-4 outcome markets |
| `features/market-details.js` | `features/outcome-details.js` | View outcome orderbook, price, info |
| `features/trade-market.js` | `features/trade-market.js` | Market buy/sell on HL outcomes |
| `features/trade-limit.js` | `features/trade-limit.js` | Limit orders on HL outcomes |
| `features/trade-onchain.js` | DELETE | No on-chain ops for HL outcomes |
| `features/strategies.js` | DELETE (Phase 2) | Strategies deferred |
| `features/positions.js` | `features/positions.js` | HL outcome positions |
| `features/orders.js` | `features/orders.js` | HL open/filled orders |
| `features/withdraw.js` | `features/withdraw.js` | HL USDC withdraw (if applicable) |
| `features/settings.js` | `features/settings.js` | Adapt settings |
| `features/security.js` | `features/security.js` | Adapt for HL wallet |
| `features/language.js` | As-is | — |
| `ai.js` | DELETE | Not needed for MVP |
| `notifications.js` | `notifications.js` | Adapt for HL outcomes |

### What gets added

| New Module | Purpose |
|-----------|---------|
| `src/modules/hyperliquid.js` | Core HL API client |
| `src/modules/hl-signing.js` | EIP-712 signing for HL exchange actions |
| `src/modules/hl-encoding.js` | Outcome ID encoding/decoding utilities |

## HyperLiquid HIP-4 API Reference

### Endpoints

- **Testnet Info**: `POST https://api.hyperliquid-testnet.xyz/info`
- **Testnet Exchange**: `POST https://api.hyperliquid-testnet.xyz/exchange`
- **Mainnet Info**: `POST https://api.hyperliquid.xyz/info`
- **Mainnet Exchange**: `POST https://api.hyperliquid.xyz/exchange`

### Info Requests (read-only, no auth)

```json
{"type": "outcomeMeta"}                              // All outcome markets
{"type": "l2Book", "coin": "#21460"}                 // Orderbook
{"type": "allMids"}                                  // All mid prices
{"type": "spotClearinghouseState", "user": "0x..."}  // User balances
{"type": "candleSnapshot", "req": {"coin": "#21460", "interval": "1h", "startTime": ..., "endTime": ...}}
{"type": "userFills", "user": "0x..."}               // Fill history
{"type": "frontendOpenOrders", "user": "0x..."}      // Open orders
```

### Asset Encoding

```
encoding = 10 * outcomeId + side   (side: 0=YES, 1=NO)
coin = "#" + encoding              (e.g. #21460)
token = "+" + encoding             (e.g. +21460)
assetId = 100_000_000 + encoding   (e.g. 100021460)
```

### Exchange Actions (require signing)

Standard HL exchange endpoint with EIP-712 typed data signing.
Order placement uses the same `order` action as spot, but with outcome asset IDs.

### Authentication

- Private key (Ethereum wallet) → generates EIP-712 signatures
- Optional: API wallet (sub-key with limited permissions)
- Nonce management: timestamp-based

## SDK Choice

Use `hyperliquid` npm package (nktkas/hyperliquid, 360 stars, actively maintained).
It handles signing, nonce management, and all API calls.

```bash
npm install hyperliquid
```

## Implementation Phases

### Phase 1: Foundation (MVP Core)

**Milestone 1.1: Strip Polymarket, set up HL client**
- [ ] Remove `polymarket.js`, `strategyMarketWatcher.js`, `ai.js`, `trade-onchain.js`, `strategies.js`
- [ ] Create `hyperliquid.js` — wrapper around `hyperliquid` SDK
- [ ] Create `hl-encoding.js` — outcome encoding/decoding utils
- [ ] Update `constants.js` — HL API URLs, chain config
- [ ] Update `package.json` — remove @polymarket/clob-client, add hyperliquid
- [ ] Update `.env.example` — HL-specific vars
- [ ] Update `config.js` — HL config structure

**Milestone 1.2: Wallet & Auth**
- [ ] Update `auth.js` — generate/import HL-compatible Ethereum wallet
- [ ] Integrate with `hyperliquid` SDK client initialization
- [ ] Test wallet creation and API connection

**Milestone 1.3: Market Discovery**
- [ ] Create `features/outcomes.js` — list outcomes from outcomeMeta
- [ ] Create `features/outcome-details.js` — view orderbook, price, description
- [ ] Update `keyboards.js` — outcome-specific keyboards
- [ ] Update `formatters.js` — outcome price/description formatting
- [ ] Update `database.js` — outcomes cache table

**Milestone 1.4: Trading**
- [ ] Implement market buy/sell in `trade-market.js` using HL SDK
- [ ] Implement limit buy/sell in `trade-limit.js` using HL SDK
- [ ] Test order placement on testnet

**Milestone 1.5: Positions & Orders**
- [ ] Update `positions.js` — fetch from spotClearinghouseState
- [ ] Update `orders.js` — fetch from frontendOpenOrders, cancel orders
- [ ] Update `workers.js` — positions sync, order monitoring

**Milestone 1.6: Bot Assembly**
- [ ] Rewire `bot.js` — register new features, remove old
- [ ] Update routing — callback-router.js, text-router.js
- [ ] Update `notifications.js` for HL outcomes
- [ ] Update locales (en.json, ru.json)
- [ ] Update `index.js` entry point

### Phase 2: Enhancement (post-MVP)

- Strategy system for outcome arbitrage
- WebSocket real-time price updates
- Price alerts
- Portfolio view
- Mainnet switch when HIP-4 goes live

## Validation Strategy

- Unit tests for encoding/decoding
- Unit tests for API response parsing
- Integration test: connect to HL testnet, fetch outcomeMeta
- Integration test: place and cancel test order on testnet
- Manual Telegram bot testing

## Risks & Assumptions

1. **HIP-4 write API not fully documented** — may need to reverse-engineer from testnet UI or SDK source. Mitigation: `hyperliquid` npm package likely supports outcomes since it's actively maintained.
2. **Testnet only** — bot will work on testnet until HIP-4 goes to mainnet. Config should support easy network switching.
3. **SDK outcome support** — need to verify `hyperliquid` npm package supports outcome trading. If not, fall back to raw HTTP + signing.
4. **Rate limits** — HL rate limits differ from Polymarket. Need to respect them.

## Definition of Done

- Bot starts, connects to HL testnet
- User can browse HIP-4 outcome markets via Telegram
- User can view orderbook and prices for any outcome
- User can place market and limit orders (buy/sell YES/NO)
- User can view positions and open orders
- User can cancel orders
- All Polymarket code is removed
- Tests pass
- README updated
