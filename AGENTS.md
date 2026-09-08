# HIP-4 Trading Bot — Local Development Guide

Concise project instructions for coding agents working in this repository. This
file records load-bearing architecture, trading invariants, and safe validation;
it is not a complete user manual or feature catalogue.

## Project Context

- This is a single-user Telegram bot for HyperLiquid HIP-4 outcome markets.
- The current product supports market discovery/search, outcome details,
  market and limit orders, split-buy arbitrage, positions, orders, wallet
  funding/withdrawal, notifications, and English/Russian UI.
- The repository was forked from a Polymarket bot and is still being migrated.
  Treat current code and tests as authoritative; `README.md`, `plan.md`, install
  scripts, comments, and compatibility stubs may still contain Polymarket-era
  names or assumptions. Do not reintroduce Polymarket behavior.
- HIP-4 outcomes only: do not add generic HyperLiquid perp/spot trading unless
  explicitly requested.

## Environment And Commands

- Runtime: Node.js `>=22.22.0`, ESM modules.
- Install locked dependencies with `npm ci`. Use `npm install` only when
  intentionally changing dependencies, and commit `package-lock.json` with
  `package.json`.
- Safe bootstrap check: `npm run bootstrap`. It validates config and local
  encryption without starting Telegram polling or workers.
- Foreground run: `npm start`; development watcher: `npm run dev`.
- Canonical suites are `npm test` and `npm run test:unit`, but do not run
  either in a live checkout: `tests/unit/database.test.js` currently opens and
  mutates the fixed `data/database.sqlite`. Use an isolated checkout/data copy
  until that test is changed to use a temporary database.
- Syntax check changed files with `node --check <path>`.
- PM2 commands are defined in `package.json` and `ecosystem.config.cjs`, but
  their process names currently disagree and some installers retain legacy
  Polymarket names. Inspect the live PM2 process and both files before any
  start, restart, stop, or delete operation; never guess the process name.

## Project Map

- `src/index.js` — startup order, bootstrap mode, shutdown handlers, bot/client
  initialization, and worker lifecycle.
- `src/modules/hyperliquid.js` — HyperLiquid info/exchange requests, signing,
  nonce handling, order construction, funding transfers, withdrawals, and
  cancellation.
- `src/modules/hl-encoding.js` — canonical HIP-4 outcome/side encoding.
- `src/modules/auth.js` — machine-bound private-key encryption and wallet setup.
- `src/modules/config.js` — atomic `data/config.json` reads/writes and runtime
  settings.
- `src/modules/database.js` — SQLite cache/state for outcomes, positions,
  orders, and price alerts.
- `src/modules/workers.js` — position sync, order reconciliation, and price
  monitoring; workers must not overlap their previous run.
- `src/modules/bot/bot.js` — Grammy assembly, single-user middleware, commands,
  rate limiting, and router registration.
- `src/modules/bot/runtime.js` — shared bot/client references and in-memory
  `userStates`, `busyLocks`, and `confirmationLocks`.
- `src/modules/bot/routing/` — callback/text dispatch only; business logic lives
  in `src/modules/bot/features/`.
- `src/modules/bot/ui/` — Telegram keyboards and plain-text/TalkBack-friendly
  formatting.
- `src/locales/en.json`, `src/locales/ru.json` — translation dictionaries.
- `scripts/` — migration, diagnostics, and manual/live exchange probes. Script
  names beginning with `test-` do not imply unit-test safety.
- `tests/unit/` — deterministic Node test suites; keep network and live trading
  outside these tests.

## HIP-4 Data Invariants

- Encoding is `10 * outcomeId + side`, where `0 = YES` and `1 = NO`.
- Canonical exchange coin form is `#<encoding>`; API/UI data may also expose
  `+<encoding>` or `@<encoding>`. Normalize aliases before matching positions,
  orders, outcomes, or mids.
- Validate the complete numeric suffix and require decoded side `0` or `1`.
  `parseInt` alone accepts malformed values such as `#123abc`.
- Exchange asset ID is `100_000_000 + encoding`. Do not apply regular spot
  `10_000 + universeIndex` logic to HIP-4 `#` coins.
- Prices are probabilities in `(0, 1)` and HyperLiquid wire prices are capped
  to five decimal places. Size must be rounded with the market's `szDecimals`.
- Configuration uses `hlNetwork`; default to `testnet`. Do not silently use a
  similarly named legacy field such as `network`.
- HyperLiquid API responses and current account state are authoritative.
  SQLite is a local cache/reconciliation store, not proof that an order filled
  or a position still exists.
- Nonces are monotonic only inside one `HLClient`. Avoid concurrent signing
  clients for the same wallet unless wallet-wide serialization is implemented.
- Order/cancel signing fields and transfer/withdraw EIP-712 network fields are
  coupled; change chain, source, signature domain, and IDs together.

## Trading And Money Safety

- Any order, cancellation, USD-class transfer, withdrawal, faucet claim, or
  mainnet switch is a live financial action. Do not execute one without explicit
  approval, even when a script or filename says `test`.
- Never run `scripts/test-live-buy.js`, `scripts/test-full-cycle.js`,
  `scripts/test-auto-funding.js`, or similar exchange probes as routine tests.
  Inspect the script first; many place orders, move funds, or cancel orders.
- Every money-moving Telegram flow must keep a review/confirmation step,
  validate its current `userStates` state, take a busy/confirmation lock, and
  clear locks/state on success, cancellation, stale callback, and error.
- Treat stale inline keyboards as normal. A stale confirmation must expire
  safely and must never replay a previous amount, destination, side, or market.
- Market orders are aggressive IOC orders. The current client may fall back to
  a resting GTC limit after specific IOC rejections; preserve this behavior only
  deliberately and make the resulting order state clear to the user.
- Buy flows may call `ensureOutcomeFunding()`, which can transfer USDC from spot
  to the prediction/perp balance before placing an order. Withdrawal may first
  transfer funds in the opposite direction. Include these dependent actions in
  confirmation, error handling, and tests.
- Split buy submits YES and NO legs in one signed HyperLiquid order action, but
  it is not settlement-atomic. Inspect each returned status independently and
  preserve explicit partial-acceptance warnings; never report guaranteed profit
  when one leg failed, rested unexpectedly, or filled at a different size.
- Parse HyperLiquid `statuses` instead of treating HTTP success or top-level
  `status: ok` as order success. Preserve indexed/per-leg errors.
- `ensureOutcomeFunding()` uses tolerances and is not proof of exact available
  funding. Always handle the exchange's final rejection path.
- Never use real mainnet money for validation. Testnet live checks still require
  approval because they use the configured wallet and can alter account state.

## Telegram, UX, And Accessibility

- Access control is enforced by `TELEGRAM_ALLOWED_USER_ID`; keep it ahead of all
  command, callback, and text handlers.
- Callback data is the public routing contract. When changing a callback, update
  its keyboard producer, `callback-router.js`, feature handler, stale-state path,
  and focused tests together.
- Free-form input states are routed in `text-router.js`. Add/remove states there
  whenever a feature changes `userStates`.
- Keep callback routers thin; put trading and validation logic in feature modules
  or the HyperLiquid client.
- Telegram-facing market lists and details should remain plain text and concise
  for TalkBack. Use HTML only where the calling message explicitly sets
  `parse_mode: 'HTML'`, and escape any external/user-controlled text first.
- Keep `en.json` and `ru.json` keys synchronized. Do not replace translated copy
  with hard-coded English in an existing localized flow.

## Secrets, Persistence, And Migration

- `.env` contains Telegram/API credentials and is never committed or printed.
- `data/config.json` contains the encrypted wallet key and settings. Encryption
  is machine-ID-bound; copying this file alone to another machine does not make
  a usable backup.
- `data/database.sqlite` uses WAL mode. Treat the database plus `-wal`/`-shm` as
  one consistency unit; use a SQLite backup or stopped-process snapshot.
- Preserve `data/`, `.env`, logs, and migration artifacts across deploys. Never
  use broad reset/clean/sync-delete commands against the project root.
- `saveConfig()` serializes writes, writes a mode-`0600` temporary file, fsyncs,
  and renames atomically. Do not replace it with direct writes.
- Patch console redaction before SDK/client startup. Never log private keys,
  encrypted blobs, signatures, nonces, credentials, auth headers, or full
  sensitive exchange payloads.
- Use `safeLog*`/`createContext` for runtime diagnostics. Direct
  `process.stderr.write` bypasses structured redaction, so never send sensitive
  values or full transaction responses through it.
- Private-key export is a destructive-security flow and must retain explicit
  confirmation. Wallet/device migration must retain fingerprint verification,
  restrictive file modes, decrypt/read-back checks, and cleanup of its one-time
  migration private key.
- Before restart, deploy, migration apply, or any data-shape change: inventory
  PM2/process state and data paths, make a verified backup, then check wallet
  address, configured network, database continuity, and worker health afterward.

## Known High-Risk Gaps

- Private-key export currently treats any text entered in its confirmation state
  as sufficient and leaves the key in Telegram. Do not exercise this flow with
  a real key; fixing it requires real password validation and message deletion.
- The settings network button toggles testnet/mainnet immediately. Do not invoke
  it during inspection, and add a deliberate confirmation before relying on it.
- `trade-limit.js` reads legacy `config.network` while the rest of the project
  uses `config.hlNetwork`; do not copy that pattern.
- Workers capture their own client when `startWorkers()` runs. Creating a wallet
  or switching network updates bot runtime state but does not replace/restart the
  worker client automatically.
- Outcome size precision can fall back to zero decimals when spot metadata was
  not populated; do not assume fractional HIP-4 size support without a focused
  rounding test.
- `.env.example` advertises worker interval variables that `workers.js` does not
  currently read. Verify runtime consumers before documenting a setting as live.
- Migration scripts still depend on obsolete Polymarket L2 credentials and are
  not covered by an end-to-end round-trip test. Treat them as unavailable until
  repaired and validated with synthetic secrets.

## Testing And Update Coupling

- Run `npm test` after changes only in an isolated checkout/data copy. In the
  live checkout, use syntax checks and explicitly selected safe unit files, and
  report the reduced validation scope. Set `LOG_TO_FILE=false` for offline unit
  runs so validation does not mutate application logs.
- For `hyperliquid.js` or encoding changes, cover `#`/`+`/`@` normalization,
  asset IDs, price/size rounding, nonce/signing payload shape, batch statuses,
  and partial errors with mocked exchange calls that do not spend funds.
- For config/auth/database changes, isolate tests from real `.env` and `data/`;
  never overwrite the configured wallet or production SQLite file.
- For Telegram flows, cover valid, invalid, cancelled, stale, repeated, and
  double-confirm paths. Verify both visible copy and keyboard callback data.
- For worker changes, verify overlap protection, API-to-SQLite reconciliation,
  notification dedup/cooldown, and stop/cleanup behavior.
- Update `README.md`, `.env.example`, locales, package scripts, and PM2/install
  files when the corresponding public setup or behavior changes. Verify claims
  against current code instead of copying legacy text.

## Git And Scope

- Inspect `git status`, `plan.md`, and the latest diff before editing. This repo
  may contain an in-progress trading slice; do not overwrite, stage, or reformat
  unrelated changes.
- Do not run `git reset`, `git clean`, `git restore`, broad checkout/sync, or
  destructive database/setup commands as shortcuts.
- Keep changes minimal and stage only reviewed task files. Stop before pushing or
  deploying when branch automation, live process impact, or account effects are
  unclear.
