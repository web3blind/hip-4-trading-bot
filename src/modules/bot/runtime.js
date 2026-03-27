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
export function setHLClient(value) {
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
