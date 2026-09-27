# HIP-4 Trading Bot — Local Development Guide

Concise project instructions for coding agents working in this repository. This
file records load-bearing architecture, trading invariants, and safe validation;
it is not a complete user manual or feature catalogue.

## Project Context

- This is a single-user Telegram bot for HyperLiquid HIP-4 outcome markets.
- The current product supports market discovery/search, outcome details,
  market and limit orders, split-buy arbitrage, positions, orders, wallet
  funding/withdrawal, complete-set bundles with aggregate PnL/history and guarded
  exits, MCP access, notifications, and English/Russian UI.
- Markets open through bot-derived categories; the deployer filter comes from
  `outcomeMeta` and combines with category. Catalog results are cached for five
  minutes, not authoritative execution quotes.
- An existing owner account can connect a dedicated API wallet through the
  private Telegram chat. Never request or store the owner's private key there.
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
- `npm test` / `npm run test:unit` use `scripts/run-safe-tests.js`: each unit
  file runs in its own temporary `HIP4_DATA_DIR`, with offline network guards
  and live credentials removed. Run this wrapper, not `node --test` directly
  or any live-exchange probe, even from a checkout next to production data.
- Syntax check changed files with `node --check <path>`.
- PM2 manages `hip-4-telegram-bot` (polling and private broker) and `hip-4-mcp`
  (protocol frontend). `npm run pm2:restart` restarts both; prefer the verified
  individual process for a scoped change. Inspect live PID/cwd/script and lock;
  never restart neighboring projects or launch a second polling/signing instance.

## Project Map

- `src/index.js` — startup order, bootstrap mode, shutdown handlers, bot/client
  initialization, and worker lifecycle.
- `src/modules/hyperliquid.js` — HyperLiquid info/exchange requests, signing,
  nonce handling, order construction, funding transfers, withdrawals, and
  cancellation.
- `src/modules/outcome-builder.js` and `src/modules/api-wallet-store.js` —
  Outcome builder eligibility and persistent API-wallet setup.
- `src/modules/process-lock.js` — single-runtime `data/runtime.lock`; never
  remove it without proving its owner exited and no bot/connector still runs.
- `src/modules/hl-encoding.js` — canonical HIP-4 outcome/side encoding.
- `src/modules/auth.js` — machine-bound private-key encryption and wallet setup.
- `src/modules/config.js` — atomic `data/config.json` reads/writes and runtime
  settings.
- `src/modules/database.js` — SQLite cache/state for outcomes, positions,
  orders, and price alerts.
- `src/modules/workers.js` — position sync, order reconciliation, and price
  monitoring; workers must not overlap their previous run.
- `src/modules/complete-set-*.js` — opportunity rules/fees, purchase and fill
  reconciliation; a filled purchase is not a settled event.
- `src/modules/bundle-portfolio.js`, `bundle-label.js`, and
  `bot/features/bundles.js` — inventory attribution, aggregate PnL/history,
  event-level labels and owner-confirmed close UI.
- `src/mcp-main.js`, `src/mcp-server.js`, and `src/modules/mcp/` — MCP frontend
  and private broker. Keep signing inside the bot; money-moving MCP requests
  require expiring, one-use owner approval in Telegram, not an MCP bypass.
- `src/modules/bot/bot.js` — Grammy assembly, single-user middleware, commands,
  rate limiting, and router registration.
- `src/modules/bot/runtime.js` — shared bot/client references and in-memory
  `userStates`, `busyLocks`, and `confirmationLocks`.
- `src/modules/bot/routing/` — callback/text dispatch only; business logic lives
  in `src/modules/bot/features/`.
- `src/modules/bot/features/api-wallet.js` — private-chat connection and
  confirmed deletion of the submitted API key before saving it.
- `src/modules/bot/features/outcomes.js` and `positions.js` — filtered catalog
  and read-only outcome position display.
- `src/modules/bot/ui/` — Telegram keyboards and plain-text/TalkBack-friendly
  formatting.
- `src/locales/en.json`, `src/locales/ru.json` — translation dictionaries.
- `scripts/` — migration, diagnostics, and manual/live exchange probes. Script
  names beginning with `test-` do not imply unit-test safety.
- `tests/unit/` — deterministic Node test suites; keep network and live trading
  outside these tests.

## HIP-4 Data Invariants

- Encoding is `10 * outcomeId + side`, where `0 = YES` and `1 = NO`.
- Canonical outcome coin form is `#<encoding>`; only `+<encoding>` is its alias.
  `@<index>` denotes ordinary spot and must never alias an outcome token.
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
- Position return is an indicative *unrealized* percentage based on the
  remaining spot balance's `total` and `entryNtl` and the current mid-price;
  zero/unknown basis or invalid/missing mid means N/A. It is not realized PnL
  or a guaranteed executable price and excludes fees.
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
- In `unifiedAccount`/`portfolioMargin`, outcome funding uses available Spot
  USDC (`total - hold`); a zero perp balance must not cap it or trigger a
  Spot→perp transfer. Non-unified modes may transfer perp→Spot for purchases
  or Spot→perp for withdrawals, but owner signing is required; the API-wallet
  agent cannot sign owner transfers or withdrawals. Test dependent actions.
- Add the Outcome builder code only after owner/network-specific approval is
  verified; `f: 0` is zero *additional builder fee*, not a rewards guarantee.
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

### Bundle accounting and notifications

- Preserve `complete_set_attempts`, `bundle_snapshots`, `bundle_fill_evidence`,
  and `bundle_close_requests`. Attribute buys by order/trade identity; validate
  `startPosition` inventory continuity and live balances. Ambiguous ownership,
  missing history or unknown fees must not become a claimed profit or sale.
- Settlement fills legitimately have prices 0 and 1. Compute realized net from
  actual buys, exits and fees; disappearing balances alone do not prove closure.
  Open midpoint PnL is indicative, not an executable return.
- Accept either chronological API response order, deduplicate trade IDs and
  handle capped time windows. Persist validated evidence rather than scanning
  from epoch zero; missing initial history leaves the bundle Unknown.
- Bundle close is an explicitly confirmed IOC batch without automatic retry or
  GTC fallback. Revalidate binding, expiry, holdings, fee evidence and quote
  immediately before signing; persist intent first and reconcile each leg.
- Active bundle shares use aggregate alerts with configured threshold/repeat/
  cooldown. Preserve standalone alerts; closed snapshots must not suppress a
  subsequent ordinary purchase. Preserve `final_notified` across label fixes.
- Derive bundle names from the parent event or constituent participants, never
  the first outcome. Keep RU/EN notification copy synchronized: completed event,
  profit/loss/break-even, signed USDC to 3 decimals and percent to 2; RU uses
  decimal commas. Localize country names via `bundle-label.js`, not event IDs.

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
- On the Positions screen, put positions immediately after the heading; keep
  the mid-price/fees caveat at the end, not before the list.
- Keep `en.json` and `ru.json` keys synchronized. Do not replace translated copy
  with hard-coded English in an existing localized flow.

## Secrets, Persistence, And Migration

- `.env` contains Telegram/API credentials and is never committed or printed.
- `data/config.json` contains the encrypted owner/API-wallet key and settings.
  Encryption is machine-ID-bound; copying this file alone to another machine
  does not make a usable backup. Do not inspect its secret fields in routine
  development or print them in diagnostics.
- API-wallet setup must stay in an authorized private Telegram chat. Confirm
  Telegram deleted the message containing the dedicated API key *before*
  validating/persisting it; on deletion failure, store nothing.
- Runtime SQLite is scoped as `data/cache-<network>-<account>.sqlite` (or under
  `HIP4_DATA_DIR`); legacy `data/database.sqlite` need not be the live database.
  Resolve the actual scope first. Treat WAL/SHM as one consistency unit and use
  SQLite online backup or a stopped-process snapshot, not a lone file copy.
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

- Owner-key export still sends the key to Telegram briefly after the literal
  `CONFIRM` and schedules deletion; it is not password authentication. Never
  exercise it with a real key during inspection. API-wallet mode has no export.
- The network button has a review/confirmation step, and API-wallet mode
  requires reconnection to change network. Do not invoke either during inspection.
- Outcome size precision can fall back to zero decimals when spot metadata was
  not populated; do not assume fractional HIP-4 size support without a focused
  rounding test.
- Worker intervals are read in `startWorkers()`; verify actual consumers and
  config notification settings before changing or documenting their behavior.
- Migration scripts still depend on obsolete Polymarket L2 credentials and are
  not covered by an end-to-end round-trip test. Treat them as unavailable until
  repaired and validated with synthetic secrets.

## Testing And Update Coupling

- Run `npm test` after changes through the safe wrapper; for a focused run use
  `npm test -- <test-name-substring>`. Its child processes isolate data,
  disable file logging, and block network. Never bypass the wrapper or run a
  second bot instance with the production Telegram token.
- For `hyperliquid.js` or encoding changes, cover `#`/`+` aliasing and `@` rejection,
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
