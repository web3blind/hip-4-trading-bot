# HIP-4 Telegram Trading Bot

Single-user, private-chat Telegram bot for Hyperliquid HIP-4 outcome markets, with English/Russian menus. Supports current outcome discovery/search, market and limit buy/sell, paired YES/NO buys, positions, orders and notifications. This is not a Polymarket or generic perp-trading bot.

## Setup

Requires Node.js >=22.22.0 and npm.

```bash
npm ci
cp .env.example .env
```

On Windows use `Copy-Item .env.example .env`. Set `TELEGRAM_BOT_TOKEN` (BotFather) and `TELEGRAM_ALLOWED_USER_ID` (your numeric user ID). Never put a wallet private key into `.env`. The Telegram connection flow accepts only a dedicated API-wallet key in the authorized private chat and immediately deletes that message; never send a main key/seed.

The Linux `install/install.sh` and Windows `install/windows_install.bat` installers install locked dependencies only by default. They do not install Node/PM2 globally, replace data or automatically restart a bot. `--start` explicitly requests PM2 startup; inspect existing processes first.

## Connect with a persistent API wallet (recommended)

The bot needs **your MAIN Hyperliquid account address** and a dedicated **API-wallet private key**. It never needs the main wallet private key or seed phrase. Setup is directly in the Telegram dialogue using two buttons. Detailed English/Russian instructions are available in that same section.

### Obtain and authorize the API wallet

1. Open the official [mainnet API page](https://app.hyperliquid.xyz/API), or [testnet API page](https://app.hyperliquid-testnet.xyz/API) for testnet. Match this network in the bot.
2. Click **Connect**, then connect the main wallet that owns your Hyperliquid funds.
3. Enter a recognizable API wallet name, such as `HIP4Bot`. Click **Generate** to create a separate signing wallet for this bot.
4. Immediately copy the generated **API-wallet private key** into a password manager. It may not be displayed again. This is not the private key/seed of your main wallet. Do not send funds to the API-wallet address.
5. **Authorize** the generated API wallet and confirm the authorization in your main wallet. Button labels may change. If offered, select a suitable validity period. Confirm its address appears in the authorized API-wallet list and check **Valid Until**. Generating a key alone does not authorize trading.
6. Copy your **MAIN account address** from the connected wallet. The bot derives the API-agent address from the API private key; do not paste that agent address as the main account.

The public official API page explicitly states that API wallets act on behalf of an account without withdrawal permissions and that info requests use the account public address. See also [Nonces and API wallets](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets). Authorization requires your own wallet interaction; no real account approval is performed by installing this project.

### Connect directly in the Telegram dialogue

Start the bot normally with `npm start` (or use the already running instance). In its **private chat**, open **Wallet / Settings → Connect API wallet**. No SSH tunnel, web form, JSON, browser console or bot restart is needed for this flow.

1. Check the network displayed in the setup screen.
2. First button **Wallet / Кошелёк**: send the MAIN Hyperliquid account address. This is not the generated API-agent address.
3. Second button **Private key / Приватник**: review the displayed owner/network and replacement notice, then send only the dedicated API-wallet private key.
4. The bot attempts to delete that message immediately, before credential verification or storage. If deletion fails, it refuses to save; remove the message manually. The key is never echoed.
5. It verifies the agent authorization, makes an encrypted backup if replacing a configured wallet, writes the API key encrypted to the existing protected `data/config.json` (mode `0600`), and activates the shared trading client/workers. After the success message, use the bot. Restarts reuse the encrypted key until expiry/revocation.

Only use the intended bot's private chat. Telegram deletion does **not** prove removal from notification previews, client copies, or Telegram infrastructure. Never send the MAIN wallet key or seed phrase. Use a dedicated, revocable API wallet.

### Renewal, revocation and risks

- Revoke the dedicated API wallet on the same official API page. Stopping the bot does not revoke it.
- If the key is lost or authorization expires, generate and authorize a replacement, repeat the Wallet and Private key buttons in the bot. Use a separate API wallet for each application.
- An agent can trade/cancel orders and **lose your funds**. Perform owner-only transfers and withdrawals in Hyperliquid using your main wallet. Funding remains in the main account, not the API wallet. For a Unified Account or Portfolio Margin account, USDC shown under Spot (minus holds) is the quote balance for USDC outcome orders; a zero perp balance does not require any spot-to-perp transfer. In Standard mode, spot USDC funds outcomes while perps have a separate balance.
- Keys are encrypted at rest using the existing machine-bound encryption. Server compromise can still expose an active signer; encryption is not protection against a fully compromised machine.

### Optional local tools and Outcome rewards

For operators who prefer local entry, `npm run connect` retains the optional loopback form; it is not required for Telegram setup. The previous temporary wallet-signing flow remains optional as `npm run connect:temporary`; it holds its generated agent key only in memory and requires reconnection after stopping. It is no longer the default.

In mainnet, the bot checks Outcome builder approval for the MAIN account when connecting, on startup and immediately before each order. If approval is verified, it attaches Outcome's builder address to the order with an explicit zero builder fee. Approval must be given once with the MAIN wallet in the [official Outcome interface](https://outcome.xyz/); an API wallet cannot grant it. Without approval or when the check fails, ordinary HIP-4 trading continues **without** Outcome attribution; check the status under Wallet or Settings → Outcome rewards. Temporary mode can still offer its own optional approval flow. Paid/pending/awarded totals are service-reported history, not proof of campaign eligibility or future rewards. No Outcome SDK dependency is required.

## Existing local wallet mode

```bash
npm run bootstrap
npm start
```

Bootstrap checks local configuration/encryption without Telegram polling or trading workers. `npm start` uses the stored encrypted wallet; it does not resume an expired in-memory agent session. Wallet creation is available in bot settings with confirmation. Use a dedicated low-balance wallet. Fund the correct Hyperliquid network/account and the market's actual quote token, not Polygon. Private-key export through Telegram is disabled.

Markets and limit orders require a review/confirmation. Market orders are aggressive IOC orders; inspect reported fills, resting orders and unknown results rather than assuming execution. Paired buys are not settlement-atomic: one leg can fail or fill differently. No automatic profit or reward is promised. Network changes require confirmation. Stale confirmations expire. The Positions view shows indicative unrealized return as a signed percentage of Hyperliquid's remaining `entryNtl` cost basis, valued at current mid-price; unavailable cost or price is shown as N/A, and realized PnL/fees are not included.

## Configuration and operation

`.env.example` lists supported environment settings:

- `HL_NETWORK=testnet` supplies the initial default; persisted `config.hlNetwork` controls an existing wallet.
- `PROXY` optionally uses HTTP CONNECT. An `https://` proxy retains TLS to the proxy; unsupported proxy transport must fail, not silently downgrade.
- `LOG_TO_FILE=false` disables application file logging; `LOG_FILE_PATH` customizes its destination. Redaction is defense in depth, not permission to log sensitive payloads.
- `WORKERS_SYNC_POSITIONS_MS`, `WORKERS_MONITOR_ORDERS_MS`, `WORKERS_MONITOR_PRICES_MS` control worker intervals in milliseconds.
- `HIP4_DATA_DIR` selects an absolute isolated data root; when set, normal project `.env` auto-loading is disabled in the config module. Test harnesses also set `DOTENV_CONFIG_PATH` to a disposable path.

Catalog metadata comes from `outcomeMeta.outcomes/questions`, cached for five minutes per client/network and invalidated at market expiry. Markets opens **Filters**: choose a category, then a market; you can refine it by deployer (Hyperliquid `venue`, e.g. `out` = Outcome). Hyperliquid does not publish category tags in this metadata, so Sports/Prices/Economy/Business/Other are inferred from market template types. List prices can be up to five minutes old; opening details refreshes prices, and order reviews use live books. Settled/expired members are excluded. Raw resolution descriptions and actual market quote tokens remain authoritative.

For persistent stored-wallet operation, PM2 manages two separate one-instance processes from `ecosystem.config.cjs`: `hip-4-telegram-bot` (Telegram polling plus private broker) and `hip-4-mcp` (loopback protocol frontend). `npm run pm2:start`, `npm run pm2:restart`, `npm run pm2:stop`, and `npm run pm2:delete` target **both** in order; `npm run pm2:mcp:start`, `npm run pm2:mcp:restart`, and `npm run pm2:mcp:logs` target only the frontend. `npm run pm2:logs` shows bot logs. Never restart during an uncertain financial action, and verify broker readiness and both process states after a deploy. PM2 configuration is not the ephemeral connection workflow.

### MCP (private agent access)

In the owner's private Telegram chat: **Settings → MCP**. Generate separate read and trade keys; rotating/revoking one scope does not affect the other. Only hashes are saved in the bot config. The raw key appears in one temporary private reply, scheduled for deletion; copy it into a protected client secret store before it disappears. Never paste it into a group, issue, source file or command line. Revocation/rotation blocks previously issued requests and pending approvals.

Start the bot first, then run `npm run mcp:start` locally or `npm run pm2:mcp:start` for the dedicated `hip-4-mcp` PM2 process. The protocol endpoint listens **only** on `127.0.0.1:19120/mcp`; the bot broker uses a mode-0600 Unix socket inside the mode-0700 data runtime directory. Do not publish port 19120 through a reverse proxy, public bind or firewall rule. A client running on another machine needs a *private, authenticated transport* to the loopback endpoint. Provide the key only as an `Authorization: Bearer ...` header (prefer environment-backed secret interpolation); do not put it in URL, MCP arguments or logs. The trade key can request market/limit orders or cancellations but **cannot execute them**: the owner must approve each bound, short-lived request in the bot's private chat. No MCP wallet management, funds transfer, key administration or network change exists. A request ID identifies a single action for replay protection; only one outstanding trading review is permitted per key, with a bounded request rate. Catalog prices are cached and not execution prices; do not infer a fill from an accepted request.

For Hermes on a separate trusted host, forward the remote loopback port through an automatically managed authenticated SSH connection (do not expose the port publicly). In Hermes's default profile place the issued key **only** in `~/.hermes/.env` as `MCP_HIP4_API_KEY=...` and add this non-secret config to `~/.hermes/config.yaml` once the key exists:

```yaml
mcp_servers:
  hip4:
    url: http://127.0.0.1:19120/mcp
    headers:
      Authorization: "Bearer ${MCP_HIP4_API_KEY}"
    sampling:
      enabled: false
```

The local SSH forward must already be running before `hermes mcp test hip4` or MCP discovery; tools appear as `mcp_hip4_*` after MCP reload/new session. Never send the issued key in an AI prompt or group chat. If the key is not installed yet, do **not** add the Hermes entry: it would repeatedly fail authentication.

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
