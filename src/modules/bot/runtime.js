import { randomBytes } from 'node:crypto';
/**
 * Shared runtime state for the HIP-4 Telegram bot.
 *
 * Keeps mutable singletons (bot instance, user state maps, hlClient)
 * that are shared across feature modules and routers.
 */

// ─── Bot instance ────────────────────────────────────────────────

export let bot = null;
export function setBot(value) {
  bot = value;
}

export let allowedUserId = null;
export function setAllowedUserId(value) {
  allowedUserId = value;
}

// ─── User interaction state ──────────────────────────────────────

/** Map<chatId, { state: string, ...extra }> — tracks per-user input flows */
export const userStates = new Map();

/** Map<chatId, number> — last command timestamp for rate limiting */
export const rateLimits = new Map();

/** Map<chatId, boolean> — busy lock to prevent concurrent operations */
export const busyLocks = new Map();

/** Map<chatId, boolean> — prevents double-tap on confirm buttons */
export const confirmationLocks = new Map();

// ─── HyperLiquid client ─────────────────────────────────────────

/** @type {import('../hyperliquid.js').HLClient|null} */
export let hlClient = null;
export let runtimeGeneration = 0;
export function setHLClient(value) {
  runtimeGeneration++;
  hlClient = value;
}

// ─── Backward-compatible stubs ──────────────────────────────────
// Kept so that the runtime.test.js doesn't break and old imports
// from the Polymarket era don't crash.

export let botClientReady = false;
export function setBotClientReady(value) {
  botClientReady = value;
}

export let botContractsReady = false;
export function setBotContractsReady(value) {
  botContractsReady = value;
}

export let localesCache = {};
export function setLocalesCache(value) {
  localesCache = value || {};
}

export let categoriesCatalogCache = {
  items: null,
  timestamp: 0,
  language: null,
};
export function setCategoriesCatalogCache(value) {
  categoriesCatalogCache = value;
}

// Legacy Polymarket stubs — unused but kept for import compatibility
export let botClientInitPromise = null;
export function setBotClientInitPromise(v) { botClientInitPromise = v; }
export let botClientInitializedWallet = '';
export function setBotClientInitializedWallet(v) { botClientInitializedWallet = v; }
export let botContractsInitPromise = null;
export function setBotContractsInitPromise(v) { botContractsInitPromise = v; }
export let botContractsInitializedWallet = '';
export function setBotContractsInitializedWallet(v) { botContractsInitializedWallet = v; }
export const autoAllowanceReady = new Set();
export const autoAllowanceInFlight = new Map();
export const strategyMarketsCache = new Map();

export const CONFIRMATION_TTL_MS = 120000;
const pendingConfirmations = new Map();
const cleanupTimers = new Map();
let activationQueue = Promise.resolve();
let pendingActivations = 0;
export let runtimeTransitioning = false;
export function runtimeBinding() {
  return `${hlClient?.network || 'unconfigured'}:${String(hlClient?.address || hlClient?.accountAddress || hlClient?.walletAddress || hlClient?.wallet?.address || '').toLowerCase()}`;
}
export function confirmationCallback(chatId, action, state) {
  const token = randomBytes(12).toString('hex');
  const snapshot = structuredClone(state);
  userStates.set(chatId, snapshot);
  pendingConfirmations.set(chatId, { action, token, state: snapshot, binding: runtimeBinding(), expiresAt: Date.now() + CONFIRMATION_TTL_MS });
  return `${action}:${token}`;
}
export function consumeConfirmation(chatId, callback) {
  const pending = pendingConfirmations.get(chatId);
  if (!pending || callback !== `${pending.action}:${pending.token}` || Date.now() >= pending.expiresAt || pending.binding !== runtimeBinding() || userStates.get(chatId) !== pending.state || runtimeTransitioning) return null;
  pendingConfirmations.delete(chatId);
  return pending.action;
}
export function scheduleMessageDeletion(ctx, ids, ttl = 30000) {
  const remove = async () => {
    for (const id of ids.filter(Boolean)) { try { await ctx.api.deleteMessage(ctx.chat.id, id); } catch {} }
  };
  const timer = setTimeout(() => { cleanupTimers.delete(timer); void remove(); }, ttl);
  timer.unref?.();
  cleanupTimers.set(timer, { chatId: ctx.chat.id, remove });
}
export async function invalidateUserState(chatId) {
  userStates.delete(chatId);
  pendingConfirmations.delete(chatId);
  for (const [timer, entry] of cleanupTimers) {
    if (entry.chatId === chatId) { clearTimeout(timer); cleanupTimers.delete(timer); await entry.remove(); }
  }
}
export function isAuthorizedPrivateContext(ctx) {
  return ctx.chat?.type === 'private' && !!ctx.from?.id && String(ctx.from.id) === String(allowedUserId) && String(ctx.chat.id) === String(allowedUserId);
}
/** Shared activation for startup, wallet setup and ephemeral browser connection. */
export function activateHLClient(client, options = {}) {
  pendingActivations++;
  runtimeTransitioning = true;
  const run = activationQueue.then(async () => {
    runtimeTransitioning = true;
    try {
      if ([...busyLocks.values()].some(Boolean)) throw new Error('Financial operation is running');
      const { stopWorkers, startWorkers } = await import('../workers.js');
      await stopWorkers();
      // Fail closed if persistence or database activation fails: never retain an
      // old signing client against a newly selected account/network cache.
      setHLClient(null);
      const cleanupIds = new Set([...userStates.keys(), ...[...cleanupTimers.values()].map(entry => entry.chatId)]);
      for (const id of cleanupIds) await invalidateUserState(id);
      pendingConfirmations.clear();
      strategyMarketsCache.clear(); autoAllowanceReady.clear(); autoAllowanceInFlight.clear();
      categoriesCatalogCache = { items: null, timestamp: 0, language: null };
      const { initDatabase } = await import('../database.js');
      initDatabase({ network: client?.network || 'testnet', accountAddress: client?.address || client?.accountAddress || client?.walletAddress || client?.wallet?.address });
      if (options.persist) await options.persist();
      setHLClient(client);
      if (client && options.startWorkers !== false) startWorkers({ hlClient: client, bot, chatId: allowedUserId, ...options.workers });
      return client;
    } finally { pendingActivations--; runtimeTransitioning = pendingActivations > 0; }
  });
  activationQueue = run.catch(() => {});
  return run;
}
export async function createConfiguredHLClient(config, { fetchImpl = fetch } = {}) {
  const { validateWalletConfig, verifyAgentAuthorization } = await import('../auth.js');
  const { HLClient } = await import('../hyperliquid.js');
  const key = await validateWalletConfig(config);
  if (config.authMode === 'agent') {
    if (!Number.isSafeInteger(config.agentValidUntil) || config.agentValidUntil <= Date.now()) throw new Error('Agent approval expired or invalid; reconnect API wallet');
    await verifyAgentAuthorization(config, { fetchImpl });
  }
  return HLClient.create(key, config.hlNetwork || 'testnet', { accountAddress: config.walletAddress, authMode: config.authMode || 'wallet', builder: config.outcomeBuilderEnabled ? { b: '0xab5dbc057628bc18523c4cdfc0e1e2ebdbecb704', f: 0 } : undefined });
}
