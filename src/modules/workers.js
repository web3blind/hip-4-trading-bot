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
  upsertPosition,
  deletePosition,
  getPositions as getDbPositions,
  upsertOrder,
  getOrders as getDbOrders,
  getOrderByOid,
  deleteOrder,
  getOutcomeByCoin,
} from './database.js';
import { createContext, safeLogError, safeLogWarn, safeLogInfo } from './logger.js';
import { notifyOrderFilled, notifyPositionChange } from './bot/notifications.js';

// ─── Configuration ───────────────────────────────────────────────

const MINUTE_MS = 60 * 1000;
const DEFAULT_SYNC_POSITIONS_MS = 2 * MINUTE_MS;
const DEFAULT_MONITOR_ORDERS_MS = 30 * 1000;

const workerTimers = new Map();
const workerRunning = new Set();
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

  const wrapped = async () => {
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
  const c = String(coin).trim();
  return c.startsWith('#') || c.startsWith('+');
}

// ─── syncPositionsWorker ─────────────────────────────────────────

async function syncPositionsWorker() {
  const config = await loadConfig();
  if (!config.walletAddress || !hlClient) return;

  const ctx = createContext('workers', 'syncPositions');

  try {
    const balances = await hlClient.getUserBalances(config.walletAddress);
    const allBalances = Array.isArray(balances?.balances) ? balances.balances : [];

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
      const coin = bal.coin;
      liveCoinSet.add(coin);

      const total = parseFloat(bal.total || '0');
      const hold = parseFloat(bal.hold || '0');
      const entryPrice = bal.entryPx || bal.avgPrice || '0';

      // Determine side from DB
      const outcome = getOutcomeByCoin(coin);
      let side = 'unknown';
      if (outcome?.sides) {
        for (const s of outcome.sides) {
          if (s.coin === coin) {
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

async function monitorOrdersWorker() {
  const config = await loadConfig();
  if (!config.walletAddress || !hlClient) return;

  const ctx = createContext('workers', 'monitorOrders');

  try {
    // Fetch current open orders from HL
    const allOrders = await hlClient.getOpenOrders(config.walletAddress);
    const ordersList = Array.isArray(allOrders) ? allOrders : [];

    // Filter for outcome orders
    const liveOrders = ordersList.filter((o) => isOutcomeToken(o.coin));
    const liveOidSet = new Set(liveOrders.map((o) => o.oid || o.orderId || o.id).filter(Boolean));

    // Upsert live orders into DB
    for (const order of liveOrders) {
      const oid = order.oid || order.orderId || order.id || '';
      if (!oid) continue;

      const orderSide = order.side === 'B' ? 'BUY' : order.side === 'A' ? 'SELL' : (order.side || 'unknown');
      const orderType = order.orderType || 'Limit';
      const price = order.limitPx || order.px || order.price || '';
      const size = order.sz || order.size || order.origSz || '';

      upsertOrder({
        coin: order.coin,
        side: orderSide,
        orderType,
        price,
        size,
        oid,
        status: 'open',
      });
    }

    // Check DB orders that are no longer in live set — they may have been filled or cancelled
    const dbOrders = getDbOrders('open');

    for (const dbOrder of dbOrders) {
      if (!dbOrder.oid) continue;
      if (liveOidSet.has(dbOrder.oid)) continue;

      // Order disappeared from live — check fills to determine if filled
      let wasFilled = false;
      try {
        const fills = await hlClient.getUserFills(config.walletAddress);
        const fillsList = Array.isArray(fills) ? fills : [];
        wasFilled = fillsList.some(
          (f) => f.oid === dbOrder.oid || f.orderId === dbOrder.oid
        );
      } catch {
        // Can't determine — mark as unknown for now
      }

      if (wasFilled) {
        // Update DB status
        upsertOrder({
          coin: dbOrder.coin,
          side: dbOrder.side,
          orderType: dbOrder.order_type,
          price: dbOrder.price,
          size: dbOrder.size,
          oid: dbOrder.oid,
          status: 'filled',
        });

        // Notify user
        if (notifyChatId && botInstance) {
          const outcome = getOutcomeByCoin(dbOrder.coin);
          const question = outcome?.question || dbOrder.coin;
          try {
            await notifyOrderFilled(botInstance, notifyChatId, {
              oid: dbOrder.oid,
              coin: dbOrder.coin,
              question,
              side: dbOrder.side,
              price: dbOrder.price,
              size: dbOrder.size,
            });
          } catch (err) {
            safeLogWarn(ctx, 'Failed to send fill notification', { message: err?.message });
          }
        }
      } else {
        // Likely cancelled or expired — remove from tracking
        deleteOrder(dbOrder.oid);
      }
    }

    safeLogInfo(ctx, `Monitored orders: ${liveOrders.length} open, ${dbOrders.length} tracked`);
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

  const syncMs = options.syncPositionsMs || DEFAULT_SYNC_POSITIONS_MS;
  const monitorMs = options.monitorOrdersMs || DEFAULT_MONITOR_ORDERS_MS;

  scheduleWorker('syncPositions', syncMs, syncPositionsWorker);
  scheduleWorker('monitorOrders', monitorMs, monitorOrdersWorker);

  workersStarted = true;

  const ctx = createContext('workers', 'startWorkers');
  safeLogInfo(ctx, 'All workers started', {
    syncPositionsMs: syncMs,
    monitorOrdersMs: monitorMs,
    notifyChatConfigured: Boolean(notifyChatId),
  });
}

/**
 * Stop all background workers.
 */
export function stopWorkers() {
  for (const [name, timer] of workerTimers.entries()) {
    clearInterval(timer);
    const ctx = createContext('workers', 'stopWorkers');
    safeLogInfo(ctx, `Stopped worker: ${name}`);
  }
  workerTimers.clear();
  workerRunning.clear();
  workersStarted = false;
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
