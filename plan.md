# HIP-4 audit remediation

## Current task: private MCP access to bot functions
- Outcome: Perp-Prime-style split MCP frontend and in-process bot broker. Frontend is loopback-only; broker uses a private Unix socket. Generate/rotate/revoke independent read and trade keys from the authorized private Telegram Settings menu; persist only hashes. Read tools return bounded safe fields; trade tools queue *requests* requiring a fresh owner-only Telegram confirmation before any exchange write. MCP cannot approve itself, operate wallet/key/settings, transfer/withdraw, or bypass funding and resting-order safeguards.
- Internal contract: frontend `127.0.0.1:19120/mcp` forwards Bearer-authenticated `GET /auth` and `POST /rpc` over a mode-0600 Unix socket in the private data runtime directory. Operation is tool name, `args` object. Never publish an Internet endpoint, pass raw keys via CLI/URLs, or return secrets in tool data. Read-only broker rejects all unlisted operations. On startup broker may run with no keys; keys are generated only in private Telegram settings.
- Scope: this repository only for implementation; configure remote Hermes only after an issued key can be installed without exposing it in chat, transcript, or config output. No actual key or wallet data inspection, signed trade, cancellation, transfer, or permission change in tests. Production restart/new service needs verified backup and connectivity/security preflight.
- Verification: isolated synthetic bot+broker and real SDK client protocol (auth, read isolation, invalid/rotated keys, retry/stale/replay, one-time Telegram approval and no writes until approval), full `npm test`, source/diff review, staging integration. Stop on live-credential delivery, public exposure or financial action without safe authorized path.


## Current task: Position unrealized return percentage
- Read-only `spotClearinghouseState` supplies each held outcome's `total` and `entryNtl`; `allMids` supplies an indicative market price. Display `(total * mid / entryNtl - 1) * 100` as signed *unrealized* return, only when price and positive entry notional are valid. Zero/unknown cost or missing/invalid mid must show unavailable, never invented 0% or realized PnL.
- Keep existing position buttons, account/network isolation and EN/RU; label midpoint estimate and omission of fees. Tests use synthetic balances only, with positive/negative/zero, alias, missing data and invalid values. No secrets or live trading actions.
- Production rollout: update only the verified HIP-4 PM2 process after protected backup and staged server tests; do not read or print secrets or execute exchange writes.
- Implemented on synthetic positive/negative/zero/unknown examples; local offline suite: 196 tests, 30 files, 0 failures. Live public info schema showed positive `entryNtl` and a usable mid for an open outcome without querying any credential.


## Current task: Market filters and five-minute catalog cache
- Markets opens a filters screen: category first, then a filtered event/market list. The list has Filters as its first button, followed by market buttons. Category and deployer (venue) filters can be combined and survive pagination/event navigation.
- The public Hyperliquid outcomeMeta has no category field; derive a small explicit category set from outcome/question template names, with Other for unknown types. Its outcome `venue` maps via root `deployers` to the deployer; never conflate the Outcome builder with the `out` deployer.
- Cache metadata-derived catalog for 300 seconds per client/network, coalesce parallel loads, never serve stale market details after expiry/network changes. Preserve active/settled rules, trade callbacks, accessibility and EN/RU.
- Safe validation: synthetic metadata including unknown/mixed/expired markets, pagination/filters/restart-style callbacks, TTL concurrent/failure tests, full offline suite and read-only public schema smoke. No secrets, live trades or PM2 restart without explicit authorization.
- Completed locally: current public metadata reports 229 outcomes, 22 questions, and deployer venues `out`, `skew`, `txyz`; no category tags. Actual Grammy `/markets` command and callback routing verified. Offline tests: 193 passed across 29 isolated files; no exchange writes. Production PM2 has not been restarted.


## Current task: Unified USDC for HIP-4 outcomes
- Public API, with only the address supplied in chat, confirms `unifiedAccount`: spot USDC is available while perp withdrawable is zero. No wallet secrets or config were read.
- Correct unified/portfolio available funds to Spot USDC; label the wallet view accurately and prevent transfers to perp on unified accounts. Preserve manual-mode owner transfers.
- Offline tests: 189 passing in 28 files. Read-only HLClient smoke verified available USDC and sufficient-funds check without a signer. No exchange write or production restart.
## Current task: Outcome builder attribution without SDK
- Removed the unpublished SDK-only experiment after source backup; the public bot never depended on it. Verified official `approvedBuilders` and `maxBuilderFee` info endpoints with read-only synthetic-address requests.
- At Telegram wallet connection and startup, check MAIN owner/mainnet builder approval. Before every managed order, recheck authorization; attach `{b: Outcome, f: 0}` only if verified. Revocation/outage removes builder from the order but does not stop ordinary HIP-4 trading. Testnet remains unaffected. Status is shown in wallet, connection and rewards views; campaign payouts/eligibility remain external.
- No real wallet, Telegram polling, approvals or exchange writes in tests. `npm test`: 188 passed across 28 isolated files; syntax and `git diff --check` passed. Public synthetic-address read-only info responses returned `approvedBuilders: []`, `maxBuilderFee: 0` (zero alone is not proof of approval).

## Current task: Telegram-native API wallet setup (supersedes browser default)
- Explicit correction: all connection UI in private bot dialogue, first button «Кошелёк», second «Приватник». No local browser, CLI or SSH requirement. Retain prior optional CLI compatibility but remove it from primary help.
- Flow: owner-address button collects public MAIN address; private-key button explains selected owner/network and replacement before asking for dedicated API key. On input, delete Telegram message BEFORE any asynchronous config/API/crypto work, validate authorized agent, save encrypted key to existing protected secret-bearing data/config.json (0600) and activate shared client/workers without restart. Preserve existing wallet via verified encrypted config backup on replacement; no duplicate plaintext stores.
- Only authorized private chat can enter this flow. Secret interception precedes rate-limit/busy/command handling so rapid key input isn't left in chat; deletion failure means no save/activation and clear warning to remove manually. No raw key in state/callbacks/logs/errors/replies. Cancel/stale/context changes cannot bind a key to another owner/network. Keyboard may include network/help/back after the two primary buttons.
- Boundaries: bot routing/middleware/new feature, existing crypto/persistence helpers, localized guide and tests. No live bot/restarts/credentials/funds, no AGENTS changes. Verification: full real Grammy update flow incl rapid input/group/unauthorized/deletion failure/replay/context/backup/save/restart/activation with controlled API; all isolated tests, review/diff, commit/push.
- Completed: real Grammy update path verifies the two buttons in order, delete before API calls, rapid/duplicate input, cancel/stale/auth/TTL/network safety, encrypted 0600 persistence, backup and live-client activation against synthetic APIs; startup subprocess verifies expired agent still permits Telegram recovery without signing. Parent reviewed integration, retained busy lock through disk readback, requires confirmed Telegram deletion, and avoids false failure when only final notification fails. npm test: 181 passed, 0 failed, 27 files. No real key, Telegram account, running bot or .env modified.

## Previous task: persistent API wallet connection
- User correction: default connection must use a pre-authorized API wallet key and owner account address, encrypted persistence across restarts; no browser console, JSON copying, injected-wallet signature or daily ephemeral reconnection. Detailed EN/RU steps belong directly in connection UI and Telegram connection help, plus README.
- Scope: new persistent local connection form/service and CLI default, auth/config/runtime integration, Telegram help entry, locales/README and isolated tests. Preserve optional old temporary connector and existing wallet/trading behavior. No unrelated AGENTS.md edits.
- Authoritative identity: Hyperliquid info extraAgents for selected network and owner; derived signer must match non-expired authorized agent, never owner. No exchange/signature calls for setup. Persist using existing encryption/saveConfig, verify decrypt/identity and protect existing config with explicit replacement review and encrypted-config backup. Expired/revoked API agents must fail closed.
- Data safety: baseline f73f772, only pre-existing dirty plan.md. No real .env/config/DB changes, no live bot/restart/approvals/trades. Prior verified encrypted backup remains; new connection backup behavior exercised only in temp data roots. No new public service, loopback-only form with bearer/origin/host/body/rate limits and no secret logs/storage/browser return payload.
- Verification: new HTTP/form-to-config-to-restarted-HLClient tests, invalid owner/key/network/expired/revoked/upstream failure/replacement/cancel/no plain secrets tests; browser synthetic fixture; npm test and syntax/diff checks; official API page/source inspection for instructions; reviewed commit/push. Stop before real credentials/account permission changes.
- Done: default npm run connect saves durable API wallet, npm start uses it after process restart, user help supplies exact safe acquisition/authorization/renewal/revocation steps and distinguishes master vs agent address/key. No claimed live trading validation.
- Completed verification: npm test 170/170 across 24 isolated files; real browser form -> reviewed replacement -> encrypted saved config and backup, no browser key retention; fresh subprocess reconstructed owner/signer client. Official API page inspected. Parent fixed absent Origin on authenticated GET and close/drain before runtime lock release. Fixture stopped. Actual .env/wallet untouched; AGENTS not changed.


## Completion contract
- outcome: repair all audit findings while preserving market/limit buy/sell, paired buys, positions/orders, notifications, EN/RU and wallet usability; add agent-account connection without exposing the owner's private key, optional Outcome builder attribution and reward visibility.
- verification: isolated Node regression suites exercising real handlers/client boundaries with synthetic signers and controlled HTTP/Telegram responses; syntax; browser QA of local connection; public read-only Hyperliquid metadata/book and Outcome rewards; git diff review. No signed live trades, cancels, transfers, approvals, or withdrawal validation.
- constraints: preserve pre-existing dirty batch-order and market-label work; # outcomes and + tokens are distinct from ordinary @ spot; actual API responses/quoteToken/account abstraction/fills are authoritative. Unknown execution is never success or automatic retry. Master keys must not enter browser-to-server payloads. Local existing wallet remains intact.
- boundaries: this repository and its local test/backup artifacts only. Do not mutate Hermes/global config, unrelated projects, live wallets, network selection, Telegram delivery, or remote account permissions. No new public endpoint without approval.
- stop_when: actual wallet signature, live funds, inaccessible provider whitelist/eligibility, or public deployment is required. Finish independent safe implementation and document exact unresolved external gate.

## Data safety
Inventory: HEAD f1e667bc77c073d344d69908da1af7afe1aa8bf6; existing dirty source/test changes; trusted origin web3blind/hip-4-trading-bot; no repo GitHub deployment workflows found. No running process with this checkout cwd or saved matching PM2 entry observed. data/config.json contains encrypted existing wallet; network absent => testnet; do not replace/migrate real wallet. Persistent files: .env, data/config.json, data/database.sqlite with -wal/-shm, data/logs and migration keys.
Before code changes: preserve current source snapshot and git diff; SQLite online backup into private directory, verify integrity and table counts; encrypt runtime backup including .env/config/database with random AES-256 password stored separately mode 0600 for local rollback. Source snapshot excludes runtime/secrets/node_modules/.git. This is local rollback protection, not off-host disaster recovery.
Forbidden: reset/clean/restore, rsync --delete, init-db against live data, broad probe cancellation, installing/starting second polling bot, migration of real wallet, changing actual config/network. Risky deployed schema changes/restart require additional continuity verification. Tests must use temporary absolute data roots and no .env loading from project. Any legacy manual live probe must fail closed by default and restrict cleanup to its own OIDs.

## Slices
1. [x] Establish safe test/data paths and snapshot baseline.
2. [x] Wallet/auth/private-chat controls; one-time state-bound confirmations; atomic network/client/workers lifecycle; account/network-specific persistent caches and worker reconciliation.
3. [x] Strict API encoding, response parsing, account-aware quote balances, budgets/precision before review, fill-aware paired results/cancellation/withdraw semantics.
4. [~] Fresh metadata/catalog, parent expiry, migration, installers/PM2, README, log/proxy, guarded probes verified. AGENTS.md remains unchanged: protected-file approval timed out; no bypass attempted.
5. [x] Browser/local agent connection and separate owner/signer identity; optional zero-fee Outcome attribution and payout visibility, no promise of whitelist eligibility.
6. [x] Full integration regression, independent review, corrections/retest, reviewed commit/push if no risky automation; short Russian final usage instructions.

## Financial flow rules
Every review binds operation/token, account, network, expiry. Cancel/navigation invalidates it; stale buttons cannot confirm a new operation. Amounts and rounded order wires are frozen at review, refreshed execution cannot exceed caps. User sees actual fills/resting/unknown and OIDs; server does not fabricate success. Owner-only transfer/withdraw disabled for agent mode with clear actionable instructions, not automatic signing attempts. Withdrawal review names Arbitrum route and fee/receipt semantics. Quote and maker/taker rewards require campaign rules and builder approval; reward service data is not proof of eligibility.

## Plan-only / customer copy
This file records staging limits. UI remains short, accessible and EN/RU; meaningful warnings for non-atomic pair risk, unverified approval and live-money confirmations are required. No speculative refactor or trading strategies. Final response concise as requested.

## Verification and release bounds
- Final `npm test`: 160 passed, 0 failed across 22 isolated test files; no live exchange writes.
- Syntax: `node --check` across 96 JS files passed; `bash -n install/install.sh`, `git diff --check` passed.
- Independent review closed cancellation confirmation/frozen OIDs, withdrawal failed-refresh fallback, actual polling readiness/cleanup, persisted fill-notification retry, consistent near-break-even split estimate.
- Browser connector exercised with synthetic injected wallet only; HTTP approval → actual owner/signer client/config boundary tested offline. Public Outcome wallet payout endpoint verified HTTP 200.
- `.env` and `data/config.json` byte-identical to verified encrypted prework backup (AES-256-CBC PBKDF2 200000 iterations). Existing live wallet/network untouched.
- No real wallet approval, trades, transfers, withdrawals or production startup. Windows installer not executed on this Linux host. Campaign eligibility is external and not guaranteed by builder code. Delivery across a crash after Telegram acceptance but before DB acknowledgement may duplicate; recovery/retry dedup otherwise verified.
- Protected AGENTS.md update requires user approval; older statements there about aliases/tests/migration are superseded by verified current code and README, not silently edited.
