# HIP-4 Telegram Trading Bot

Single-user, private-chat Telegram bot for Hyperliquid HIP-4 outcome markets, with English/Russian menus. Supports current outcome discovery/search, market and limit buy/sell, paired YES/NO buys, positions, orders and notifications. This is not a Polymarket or generic perp-trading bot.

## Setup

Requires Node.js >=22.22.0 and npm.

```bash
npm ci
cp .env.example .env
```

On Windows use `Copy-Item .env.example .env`. Set `TELEGRAM_BOT_TOKEN` (BotFather) and `TELEGRAM_ALLOWED_USER_ID` (your numeric user ID). Never put a wallet private key into `.env` or Telegram.

The Linux `install/install.sh` and Windows `install/windows_install.bat` installers install locked dependencies only by default. They do not install Node/PM2 globally, replace data or automatically restart a bot. `--start` explicitly requests PM2 startup; inspect existing processes first.

## Connect your existing wallet without sharing its private key

```bash
npm run connect
```

Open the printed private loopback URL in a browser with your wallet extension. Do not share that URL. The connection server listens on `127.0.0.1:8787`, not a public interface. On a remote host, forward the port with `ssh -L 8787:127.0.0.1:8787 user@host`, then open the printed link locally. Do not expose this server through a public reverse proxy.

- Choose the intended account and network. Testnet is the safe initial default; mainnet trades use real money.
- Review and explicitly approve the agent in your wallet. The owner's private key stays in the wallet and is never shared with the bot/server. This does **not** make the connection risk-free: an approved agent can trade and lose your funds.
- A separate agent signing key is held in process memory for this session. The existing encrypted local wallet/config is not replaced by the session. Restart/expiry requires reconnecting. Process termination is not on-chain revocation: revoke the agent in Hyperliquid when finished or if compromised.
- Agent mode does not authorize owner-only deposits/transfers/withdrawals. Perform those through the official wallet/account interface; do not send a master key to bypass restrictions.
- After successful connection use `/start` in the private Telegram chat. Keep this process running; do not also start another polling bot with the same token.

### Optional Outcome attribution and rewards

The connector offers optional zero-fee Outcome builder attribution, with explicit wallet approval. Attribution and reward visibility are not evidence of campaign eligibility. Provider whitelisting, maker/taker rules, qualifying activity and payout decisions remain external requirements. Reported paid/pending/awarded amounts are service-reported history, **not a guarantee of future rewards or profitability**. Approval, eligibility and live payout behavior require separate verification; tests do not establish them.

## Existing local wallet mode

```bash
npm run bootstrap
npm start
```

Bootstrap checks local configuration/encryption without Telegram polling or trading workers. `npm start` uses the stored encrypted wallet; it does not resume an expired in-memory agent session. Wallet creation is available in bot settings with confirmation. Use a dedicated low-balance wallet. Fund the correct Hyperliquid network/account and the market's actual quote token, not Polygon. Private-key export through Telegram is disabled.

Markets and limit orders require a review/confirmation. Market orders are aggressive IOC orders; inspect reported fills, resting orders and unknown results rather than assuming execution. Paired buys are not settlement-atomic: one leg can fail or fill differently. No automatic profit or reward is promised. Network changes require confirmation. Stale confirmations expire.

## Configuration and operation

`.env.example` lists supported environment settings:

- `HL_NETWORK=testnet` supplies the initial default; persisted `config.hlNetwork` controls an existing wallet.
- `PROXY` optionally uses HTTP CONNECT. An `https://` proxy retains TLS to the proxy; unsupported proxy transport must fail, not silently downgrade.
- `LOG_TO_FILE=false` disables application file logging; `LOG_FILE_PATH` customizes its destination. Redaction is defense in depth, not permission to log sensitive payloads.
- `WORKERS_SYNC_POSITIONS_MS`, `WORKERS_MONITOR_ORDERS_MS`, `WORKERS_MONITOR_PRICES_MS` control worker intervals in milliseconds.
- `HIP4_DATA_DIR` selects an absolute isolated data root; when set, normal project `.env` auto-loading is disabled in the config module. Test harnesses also set `DOTENV_CONFIG_PATH` to a disposable path.

Catalog metadata uses current `outcomeMeta.outcomes/questions`, a short client/network-specific TTL, parent expiry and settled-member filtering. Display summaries are conveniences; raw resolution descriptions and actual market quote tokens remain authoritative.

For persistent stored-wallet operation, explicitly install PM2 and inspect process state before using `npm run pm2:start`. The ecosystem and scripts use the same name: `hip-4-telegram-bot`. Other commands: `npm run pm2:logs`, `npm run pm2:restart`, `npm run pm2:stop`, `npm run pm2:delete`. Never restart during an uncertain financial action. PM2 configuration is not the ephemeral connection workflow.

## Offline tests and read-only diagnostics

```bash
npm test
# Selected files: filename fragments, not full paths
node scripts/run-safe-tests.js catalog-current-meta ops-migration-roundtrip ops-safety
node scripts/ops-catalog-probe.js
# Public mainnet metadata only, no wallet or signing:
node scripts/ops-catalog-probe.js --mainnet
```

The test runner uses separate temporary data directories, disables file logs and blocks outbound requests in the test process. Synthetic migration tests launch bounded child processes against disposable data. Never substitute historical `scripts/test-*.js` or `debug-*.js` for the safe suite. These legacy financial probes and the faucet script are retired and fail closed even with an opt-in flag; they place no orders, transfer no funds and perform no broad cancellation. Live testnet actions still need explicit approval.

## Data, backups and secure device migration

- `data/config.json`: machine-bound encrypted signer and settings. Copying this file alone does not migrate a usable wallet.
- `data/database.sqlite`: local cache and reconciliation state, not authoritative exchange state. Back up SQLite consistently including WAL state via an online backup or stopped-process snapshot.
- Preserve `.env`, `data/`, logs and migration artifacts on upgrades. Never use broad reset/clean/sync-delete commands.

Migration changes the target wallet: stop its bot, verify a backup and check source/target identity first. It migrates persisted wallet/agent credentials and settings, not an ephemeral connector session, Telegram credentials or SQLite history. No Polymarket L2 credentials are required.

On the target:

```bash
npm run migrate:prepare -- --ttl-minutes 30
```

Keep the generated one-time `.private.pem` on the target. Transfer only the request JSON to the source and verify its displayed public-key fingerprint out of band.

On the source:

```bash
npm run migrate:export -- --request <request.json> --fingerprint <verified-fingerprint>
```

Transfer the encrypted bundle to the target:

```bash
npm run migrate:apply -- --request <request.json> --bundle <bundle.json>
```

Apply re-encrypts for the target machine, reads the committed config from disk, checks identities/network and decryption, then deletes and verifies removal of the one-time migration private key. Synthetic tests cover both wallet and agent modes and reject replay after deletion. Deletion is not guaranteed physical secure erasure on SSDs/backups. `--keep-private-key` and `--allow-expired` weaken protections and are not recommended. `--private-key <path>` overrides key location; `--delete-request` also removes the request JSON. Migration cannot undo exposure on a compromised source.

## Validation limits

Offline passing tests do not prove live exchange permissions, wallet extension compatibility, provider reward eligibility, Windows installer execution or production deployment readiness. Signed live trades, approvals, transfers, cancellations and withdrawals require separate explicit authorization and account-state verification.
