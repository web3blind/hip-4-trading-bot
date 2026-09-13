/**
 * Background workers for HyperLiquid HIP-4 Outcome Trading Bot.
 *
 * Two simple workers:
 *   1) syncPositionsWorker — periodically fetch positions from HL API, update database
 *   2) monitorOrdersWorker — periodically check order status, notify on fills
 */

import { loadConfig } from './config.js';
import { HLClient } from './hyperliquid.js';
import {
  canonicalOid,
  upsertPosition,
  deletePosition,
  getPositions as getDbPositions,
  upsertOrder,
  getOrders as getDbOrders,
  getOrderByOid,
  markOrderFillNotificationDelivered,
  deleteOrder,
  getOutcomeByCoin,
  getPriceAlertState,
  updatePriceAlertState,
} from './database.js';
import { createContext, safeLogError, safeLogWarn, safeLogInfo } from './logger.js';
import { notifyOrderFilled, notifyPositionChange } from './bot/notifications.js';

// ─── Configuration ───────────────────────────────────────────────

const MINUTE_MS = 60 * 1000;
const DEFAULT_SYNC_POSITIONS_MS = 2 * MINUTE_MS;
const DEFAULT_MONITOR_ORDERS_MS = 30 * 1000;
const DEFAULT_MONITOR_PRICES_MS = 60 * 1000;

const workerTimers = new Map();
const workerRunning = new Set();
const workerTasks = new Set();
let workersStarted = false;

/** @type {HLClient|null} */
let hlClient = null;
/** @type {object|null} */
let botInstance = null;
/** @type {string} */
let notifyChatId = '';

// ─── Worker scheduler ────────────────────────────────────────────

function scheduleWorker(name, intervalMs, handler) {
  if (workerTimers.has(name)) {
    clearInterval(workerTimers.get(name));
  }

  const run = async () => {
    if (workerRunning.has(name)) {
      const ctx = createContext('workers', name);
      safeLogWarn(ctx, `Skipping — previous run still active`);
      return;
    }

    workerRunning.add(name);
    try {
      await handler();
    } catch (error) {
      const ctx = createContext('workers', name);
      safeLogError(ctx, error);
    } finally {
      workerRunning.delete(name);
    }
  };

  const wrapped = () => {
    const task = run(); workerTasks.add(task);
    task.finally(() => workerTasks.delete(task));
    return task;
  };

  // Run once immediately, then on interval
  wrapped();
  const timer = setInterval(wrapped, intervalMs);
  workerTimers.set(name, timer);

  const ctx = createContext('workers', 'scheduleWorker');
  safeLogInfo(ctx, `Scheduled worker: ${name} (every ${intervalMs}ms)`);
}

// ─── Utility ─────────────────────────────────────────────────────

/**
 * Check if a coin is an outcome token (HIP-4).
 */
function isOutcomeToken(coin) {
  if (!coin) return false;
  return /^[#+][0-9]*[01]$/.test(String(coin));
}

// ─── syncPositionsWorker ─────────────────────────────────────────

export async function syncPositionsWorker() {
  const config = await loadConfig();
  if (!config.walletAddress || !hlClient) return;

  const ctx = createContext('workers', 'syncPositions');

  try {
    const balances = await hlClient.getUserBalances(config.walletAddress);
    if (!Array.isArray(balances?.balances)) throw new Error('Invalid balance response; retaining cache');
    const allBalances = balances.balances;
    for (const balance of allBalances.filter(b => isOutcomeToken(b?.coin))) {
      if (typeof balance.total !== 'string' || !/^\d+(?:\.\d+)?$/.test(balance.total) || !Number.isFinite(Number(balance.total))) {
        throw new Error('Invalid outcome balance; retaining cache');
      }
    }

    // Filter for outcome tokens with non-zero balance
    const outcomeBalances = allBalances.filter((b) => {
      if (!isOutcomeToken(b.coin)) return false;
      const total = parseFloat(b.total || '0');
      return total > 0.0001;
    });

    // Get current DB positions for change detection
    const dbPositions = getDbPositions();
    const dbMap = new Map(dbPositions.map((p) => [p.coin, p]));
    const liveCoinSet = new Set();

    for (const bal of outcomeBalances) {
      const coin = bal.coin.replace(/^\+/, '#');
      liveCoinSet.add(coin);

      const total = parseFloat(bal.total || '0');
      const hold = parseFloat(bal.hold || '0');
      const explicit = Number(bal.entryPx || bal.avgPrice);
      const entryNtl = Number(bal.entryNtl);
      const entryPrice = Number.isFinite(explicit) && explicit > 0 ? explicit :
        Number.isFinite(entryNtl) && entryNtl > 0 && total > 0 ? entryNtl / total : '';

      // Only the + token spelling aliases a # outcome.
      const normCoin = coin.startsWith('+') ? '#' + coin.slice(1) : coin;
      const outcome = getOutcomeByCoin(coin) || getOutcomeByCoin(normCoin);
      let side = 'unknown';
      if (outcome?.sides) {
        for (const s of outcome.sides) {
          const sCoin = s.coin?.startsWith('+') ? '#' + s.coin.slice(1) : s.coin;
          if (s.coin === coin || sCoin === normCoin) {
            side = s.side === 0 ? 'YES' : 'NO';
            break;
          }
        }
      }

      const existingPos = dbMap.get(coin);
      const sizeChanged = !existingPos || Math.abs(parseFloat(existingPos.size) - total) > 0.001;

      upsertPosition({ coin, side, size: total.toString(), entryPrice: entryPrice.toString() });

      // Notify if position changed significantly and this isn't first sync
      if (existingPos && sizeChanged && notifyChatId && botInstance) {
        const question = outcome?.question || coin;
        try {
          await notifyPositionChange(botInstance, notifyChatId, {
            coin,
            question,
            side,
            oldSize: existingPos.size,
            newSize: total.toString(),
          });
        } catch (err) {
          safeLogWarn(ctx, 'Failed to send position change notification', { message: err?.message });
        }
      }
    }

    // Remove positions that no longer exist
    for (const dbPos of dbPositions) {
      if (!liveCoinSet.has(dbPos.coin)) {
        deletePosition(dbPos.coin);
      }
    }

    safeLogInfo(ctx, `Synced ${outcomeBalances.length} outcome positions`);
  } catch (error) {
    safeLogError(ctx, error);
  }
}

// ─── monitorOrdersWorker ─────────────────────────────────────────

/** Reconcile authoritative status and actual fills; absence is never cancellation. */
export async function monitorOrdersWorker() {
  const config = await loadConfig();
  if (!config.walletAddress || !hlClient) return;
  const ctx = createContext('workers', 'monitorOrders');
  try {
    const live = await hlClient.getOpenOrders(config.walletAddress);
    if (!Array.isArray(live)) throw new Error('Invalid open orders response');
    const tracked = getDbOrders().filter(o => ['open', 'partial', 'unknown'].includes(o.status) || (o.status === 'filled' && o.fill_notification_status === 'pending'));
    const liveOids = new Set();
    for (const order of live.filter(o => isOutcomeToken(o.coin))) {
      const oid = canonicalOid(order.oid ?? order.orderId ?? order.id);
      const existing = getOrderByOid(oid);
      // A stale open-order snapshot must not reopen a confirmed terminal fill.
      if (existing?.status === 'filled') continue;
      liveOids.add(oid);
      upsertOrder({ coin: order.coin.replace(/^\+/, '#'), side: order.side === 'B' ? 'BUY' : 'SELL',
        orderType: order.orderType || 'Limit', price: order.limitPx || order.px,
        size: order.origSz || existing?.size || order.sz, oid, status: 'open' });
    }
    let fills;
    try { fills = await hlClient.getUserFills(config.walletAddress); } catch { fills = null; }
    for (const order of tracked) {
      const oid = canonicalOid(order.oid);
      if (liveOids.has(oid)) continue;
      let statusResult = null;
      try { statusResult = await hlClient.getOrderStatus(oid, config.walletAddress); } catch {}
      const exchangeStatus = statusResult?.order?.status || (statusResult?.status !== 'order' ? statusResult?.status : null);
      const matching = Array.isArray(fills) ? fills.filter(f => String(f.oid ?? f.orderId) === oid) : [];
      // Deduplicate API fills by exchange trade identity (not price/size).
      const seen = new Set();
      const unique = matching.filter(f => { const key = f.tid ?? (f.hash ? `${f.hash}:${f.time}:${f.sz}` : null); if (key === null) return true; if (seen.has(key)) return false; seen.add(key); return true; });
      const filledSize = unique.reduce((n, f) => n + (Number(f.sz) || 0), 0);
      const fillNtl = unique.reduce((n, f) => n + (Number(f.sz) || 0) * (Number(f.px) || 0), 0);
      let status = 'unknown';
      if (order.status === 'filled' || exchangeStatus === 'filled') status = 'filled';
      else if (/cancel|reject|expired/i.test(exchangeStatus || '')) status = 'cancelled';
      else if (exchangeStatus === 'open') status = filledSize > 0 ? 'partial' : 'open';
      else if (filledSize > 0) status = filledSize >= Number(order.size) ? 'filled' : 'partial';
      upsertOrder({ coin: order.coin, side: order.side, orderType: order.order_type,
        price: order.price, size: order.size, oid, status, fillNotificationStatus: status === 'filled' ? 'pending' : null });
      const validFills = unique.length > 0 && unique.every(f =>
        Number.isFinite(Number(f.sz)) && Number(f.sz) > 0 &&
        Number.isFinite(Number(f.px)) && Number(f.px) > 0 && Number(f.px) <= 1);
      if (status === 'filled' && validFills && Number.isFinite(filledSize) && Number.isFinite(fillNtl) &&
          getOrderByOid(oid).fill_notification_status === 'pending' && botInstance && notifyChatId) {
        const delivered = await notifyOrderFilled(botInstance, notifyChatId, { oid, coin: order.coin,
          question: getOutcomeByCoin(order.coin)?.question || order.coin, side: order.side,
          price: fillNtl / filledSize, size: String(filledSize) });
        if (delivered) markOrderFillNotificationDelivered(oid);
      }
    }
  } catch (error) { safeLogError(ctx, error); }
}

// ─── monitorPricesWorker ──────────────────────────────────────────

async function monitorPricesWorker() {
  if (!hlClient || !notifyChatId) return;

  const ctx = createContext('workers', 'monitorPrices');

  try {
    const config = await loadConfig();
    const notifications = config?.notifications || {};
    const thresholdPercent = Number(notifications.priceChangePercent ?? 10);
    const repeatStepPercent = Number(notifications.priceRepeatStepPercent ?? 2);
    const cooldownMs = Number(notifications.alertCooldownSeconds ?? 300) * 1000;

    // Get current positions from DB
    const positions = getDbPositions();
    if (!positions || positions.length === 0) return;

    // Get current prices
    let mids = {};
    try {
      mids = await hlClient.getAllMids();
    } catch { return; }

    for (const pos of positions) {
      const coin = pos.coin;
      if (!coin) continue;

      const size = parseFloat(pos.size || '0');
      if (size <= 0.01) continue; // skip dust

      // Ordinary @ spot coins must never use outcome prices.
      if (!isOutcomeToken(coin)) continue;
      const normCoin = coin.startsWith('+') ? '#' + coin.slice(1) : coin;

      const currentPriceStr = mids[normCoin];
      if (!currentPriceStr) continue;
      const currentPrice = parseFloat(currentPriceStr);
      if (!currentPrice || currentPrice <= 0) continue;

      const entryPrice = parseFloat(pos.entry_price || '0');
      // Use entry price as reference, or skip if no entry price
      if (!entryPrice || entryPrice <= 0) continue;

      // Calculate percentage change from entry
      const changePercent = Math.abs((currentPrice - entryPrice) / entryPrice) * 100;
      if (changePercent < thresholdPercent) continue;

      // Check cooldown and repeat step
      const alertState = getPriceAlertState(normCoin);
      const now = Date.now();

      if (alertState) {
        // Cooldown check
        if (alertState.last_alert_time && (now - alertState.last_alert_time < cooldownMs)) continue;

        // Repeat step: only notify again if price moved further
        const lastAlertPrice = parseFloat(alertState.last_price || '0');
        if (lastAlertPrice > 0) {
          const stepChange = Math.abs((currentPrice - lastAlertPrice) / lastAlertPrice) * 100;
          if (stepChange < repeatStepPercent) continue;
        }
      }

      // Send notification
      const direction = currentPrice >= entryPrice ? '+' : '-';
      const value = (size * currentPrice).toFixed(2);
      const { formatPrice } = await import('./bot/ui/formatters.js');

      // Resolve outcome name
      let outcomeName = normCoin;
      try {
        const outcome = getOutcomeByCoin(normCoin);
        if (outcome?.question) outcomeName = outcome.question;
      } catch {}

      const message =
        `Price Alert\n\n` +
        `${outcomeName}\n` +
        `Price: ${formatPrice(currentPrice)}\n` +
        `Entry: ${formatPrice(entryPrice)}\n` +
        `Change: ${direction}${changePercent.toFixed(1)}%\n` +
        `Value: $${value}\n` +
        `Shares: ${size.toFixed(4)}`;

      try {
        await botInstance.api.sendMessage(notifyChatId, message, {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Positions', callback_data: 'positions' }, { text: 'Orders', callback_data: 'orders' }]
            ]
          }
        });
      } catch { continue; }

      updatePriceAlertState(normCoin, currentPrice, now);
    }
  } catch (error) {
    safeLogError(ctx, error);
  }
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Start all background workers.
 *
 * @param {object} options
 * @param {HLClient} options.hlClient - HyperLiquid client instance
 * @param {object} options.bot - Grammy bot instance (for notifications)
 * @param {string} [options.chatId] - Chat ID for notifications
 * @param {number} [options.syncPositionsMs] - Sync interval (default 2 min)
 * @param {number} [options.monitorOrdersMs] - Monitor interval (default 30s)
 */
export function startWorkers(options = {}) {
  if (workersStarted) {
    const ctx = createContext('workers', 'startWorkers');
    safeLogWarn(ctx, 'Workers already started, skipping');
    return;
  }

  hlClient = options.hlClient || null;
  botInstance = options.bot || null;
  notifyChatId = options.chatId || process.env.WORKERS_NOTIFICATIONS_CHAT_ID || process.env.TELEGRAM_ALLOWED_USER_ID || '';

  const syncMs = options.syncPositionsMs || Number(process.env.WORKERS_SYNC_POSITIONS_MS) || DEFAULT_SYNC_POSITIONS_MS;
  const monitorMs = options.monitorOrdersMs || Number(process.env.WORKERS_MONITOR_ORDERS_MS) || DEFAULT_MONITOR_ORDERS_MS;
  const monitorPricesMs = options.monitorPricesMs || Number(process.env.WORKERS_MONITOR_PRICES_MS) || DEFAULT_MONITOR_PRICES_MS;

  scheduleWorker('syncPositions', syncMs, syncPositionsWorker);
  scheduleWorker('monitorOrders', monitorMs, monitorOrdersWorker);
  scheduleWorker('monitorPrices', monitorPricesMs, monitorPricesWorker);

  workersStarted = true;

  const ctx = createContext('workers', 'startWorkers');
  safeLogInfo(ctx, 'All workers started', {
    syncPositionsMs: syncMs,
    monitorOrdersMs: monitorMs,
    monitorPricesMs,
    notifyChatConfigured: Boolean(notifyChatId),
  });
}

/**
 * Stop all background workers.
 */
export async function stopWorkers() {
  for (const [name, timer] of workerTimers.entries()) {
    clearInterval(timer);
    const ctx = createContext('workers', 'stopWorkers');
    safeLogInfo(ctx, `Stopped worker: ${name}`);
  }
  workerTimers.clear();
  await Promise.allSettled([...workerTasks]);
  workersStarted = false;
  hlClient = null; botInstance = null; notifyChatId = '';
}

/**
 * Get worker health snapshot.
 */
export function getWorkersHealthSnapshot() {
  return {
    workersStarted,
    running: Array.from(workerRunning),
    scheduled: Array.from(workerTimers.keys()),
    notifyChatConfigured: Boolean(notifyChatId),
    hlClientConfigured: Boolean(hlClient),
  };
}
