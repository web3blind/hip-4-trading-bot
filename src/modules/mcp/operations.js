import { randomBytes, createHash } from 'node:crypto';
import { InlineKeyboard } from 'grammy';
import { isOutcomeCoin, normalizeOutcomeCoin } from '../hl-encoding.js';
import { isMcpCredentialCurrent } from './key-store.js';
import { loadConfig } from '../config.js';
import { getTranslator } from '../i18n.js';
import { fetchAndCacheOutcomes, getCachedOutcome, normalizeMarketFilters } from '../bot/features/outcomes.js';
import { bot, allowedUserId, hlClient, runtimeBinding, runtimeTransitioning, busyLocks,
  confirmationCallback, userStates, isAuthorizedPrivateContext } from '../bot/runtime.js';

const ACTION_TTL = 120_000;
const HISTORY_TTL = 600_000;
const actions = new Map();
const requests = new Map();
const translate = async () => getTranslator((await loadConfig()).language || 'en');
const safeText = value => String(value ?? '').slice(0, 180).replace(/[\x00-\x1f\x7f]/g, ' ')
  .replace(/hip4mcp_[A-Za-z0-9_-]{43}|0x[a-fA-F0-9]{64}/g, '[REDACTED]');
const number = (value, max = 1_000_000) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) throw new Error('Invalid positive amount');
  return value;
};
const page = value => Number.isSafeInteger(value) && value >= 1 && value <= 100 ? value : 1;
function coin(value) {
  if (typeof value !== 'string' || !isOutcomeCoin(value)) throw new Error('HIP-4 outcome coin required');
  return normalizeOutcomeCoin(value);
}
function fingerprint(value) {
  const ordered = Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}
function prune() {
  const now = Date.now();
  for (const [id, a] of actions) {
    if (a.status === 'pending' && (now >= a.expiresAt || a.binding !== runtimeBinding())) a.status = 'expired';
    if (now >= a.createdAt + HISTORY_TTL) actions.delete(id);
  }
  for (const [id, v] of requests) if (now >= v.createdAt + HISTORY_TTL) requests.delete(id);
}
export function clearMcpActions() { actions.clear(); requests.clear(); }
const view = a => ({ action_id: a.id, status: a.status, expires_at: new Date(a.expiresAt).toISOString(),
  ...(a.result ? { result: a.result } : {}) });

async function prepareAction(operation, args, client) {
  const base = { operation, coin: coin(args.coin) };
  if (operation === 'request_market_order' || operation === 'request_limit_order') {
    if (typeof args.is_buy !== 'boolean') throw new Error('is_buy must be boolean');
    if (operation === 'request_market_order') {
      const amount = number(args.amount);
      const slippage = args.slippage_pct == null ? 2 : number(args.slippage_pct, 20);
      const reviewed = await client.prepareMarketOrder(base.coin, args.is_buy, amount, slippage);
      return { ...base, reviewed, label: `${args.is_buy ? 'BUY' : 'SELL'} MARKET ${base.coin}; ${args.is_buy ? 'max budget USDC' : 'shares'}: ${amount}; price cap: ${reviewed.price}; size: ${reviewed.size}; max spend: ${reviewed.maxSpend ?? 'n/a'}` };
    }
    const price = number(args.price, 1);
    if (price >= 1) throw new Error('Price must be less than 1');
    const size = number(args.size);
    const reviewed = await client.prepareOrder({ coin: base.coin, isBuy: args.is_buy, price, size, orderType: 'Limit' });
    return { ...base, reviewed, label: `${args.is_buy ? 'BUY' : 'SELL'} LIMIT ${base.coin}; price: ${reviewed.price}; shares: ${reviewed.size}; max spend: ${reviewed.maxSpend ?? 'n/a'}` };
  }
  if (operation === 'request_cancel_orders') {
    if (!Array.isArray(args.oids) || args.oids.length < 1 || args.oids.length > 5 ||
        !args.oids.every(v => Number.isSafeInteger(v) && v > 0) || new Set(args.oids).size !== args.oids.length) throw new Error('1-5 unique numeric OIDs required');
    const orders = await client.getOpenOrders();
    if (!Array.isArray(orders)) throw new Error('Orders unavailable');
    if (!args.oids.every(oid => orders.some(o => isOutcomeCoin(o.coin) && coin(o.coin) === base.coin && Number(o.oid ?? o.orderId ?? o.id) === oid))) throw new Error('Order not open for requested outcome');
    return { ...base, oids: [...args.oids], label: `CANCEL ${base.coin} OID: ${args.oids.join(', ')}` };
  }
  throw new Error('Unsupported trade request');
}

async function executeAction(a, client) {
  if (a.binding !== runtimeBinding() || !await isMcpCredentialCurrent(a.credential)) throw new Error('Account or MCP key changed');
  if (a.operation === 'request_cancel_orders') {
    const orders = await client.getOpenOrders();
    if (!Array.isArray(orders) || !a.oids.every(oid => orders.some(o => isOutcomeCoin(o.coin) && coin(o.coin) === a.coin && Number(o.oid ?? o.orderId ?? o.id) === oid))) throw new Error('Reviewed order no longer open');
    const results = [];
    for (const oid of a.oids) {
      try { await client.cancelOrder(a.coin, oid); results.push({ oid, status: 'submitted' }); }
      catch { results.push({ oid, status: 'unknown' }); break; }
    }
    return { cancellations: results };
  }
  const r = a.reviewed;
  if (r.isBuy) {
    // Spot collateral check only; NEVER call ensureOutcomeFunding (may transfer).
    if ((await client.getSpotUsdcBalance()) < r.maxSpend) throw new Error('Insufficient Spot USDC; no transfer attempted');
  } else {
    const balances = await client.getUserBalances();
    const held = (balances?.balances || []).find(b => isOutcomeCoin(b.coin) && coin(b.coin) === a.coin);
    if (!held || Number(held.total) - Number(held.hold) < r.size) throw new Error('Insufficient unheld outcome shares');
  }
  // There is no fallback from IOC to resting GTC, nor any implicit transfer.
  const response = await client.placeOrders([r]);
  const statuses = response?.response?.data?.statuses;
  if (!Array.isArray(statuses) || statuses.length !== 1) return { execution: 'unknown' };
  const status = statuses[0];
  if (status?.filled) return { execution: 'filled', oid: Number(status.filled.oid) || undefined };
  if (status?.resting) return { execution: r.orderType === 'Market' ? 'unknown' : 'resting', oid: Number(status.resting.oid) || undefined };
  return { execution: 'unknown' };
}

export async function handleMcpApproval(ctx) {
  if (!isAuthorizedPrivateContext(ctx)) return;
  const id = userStates.get(ctx.chat.id)?.actionId;
  const a = actions.get(id);
  if (!a || a.status !== 'pending' || a.expiresAt <= Date.now() || a.binding !== runtimeBinding() ||
      !await isMcpCredentialCurrent(a.credential) || runtimeTransitioning) {
    if (a && a.status === 'pending') a.status = 'expired';
    await ctx.reply((await translate())('mcp_trade_invalid'));
    return;
  }
  if (busyLocks.get(ctx.chat.id)) return;
  busyLocks.set(ctx.chat.id, true);
  a.status = 'executing'; // one-time before first await to prevent replay
  try {
    const client = hlClient;
    if (!client?.address || a.binding !== runtimeBinding()) throw new Error('Account changed');
    a.result = await executeAction(a, client);
    a.status = a.result.execution === 'unknown' || a.result.cancellations?.some(x => x.status === 'unknown') ? 'unknown' : 'done';
    await ctx.reply((await translate())('mcp_trade_result', { id: a.id, status: a.status }));
  } catch {
    a.status = 'unknown'; // Fail closed: network failure may follow submission.
    await ctx.reply((await translate())('mcp_trade_unknown', { id: a.id }));
  } finally { busyLocks.delete(ctx.chat.id); }
}
export async function handleMcpRejection(ctx) {
  if (!isAuthorizedPrivateContext(ctx)) return;
  const id = ctx.callbackQuery?.data?.split(':')[2];
  const a = actions.get(id);
  if (a?.status === 'pending') a.status = 'rejected';
  await ctx.editMessageText((await translate())('mcp_trade_rejected'));
}

export async function mcpOperation(operation, args, credential, dependencies = {}) {
  if (!credential || typeof args !== 'object' || !args || Array.isArray(args)) throw new Error('Invalid request');
  if (!await isMcpCredentialCurrent(credential)) throw new Error('MCP key revoked');
  const client = dependencies.client ?? hlClient;
  const accountBinding = dependencies.binding?.() ?? runtimeBinding();
  prune();
  const read = new Set(['get_bot_status', 'list_markets', 'get_market', 'get_orderbook', 'get_balances', 'get_positions', 'get_open_orders', 'get_recent_fills', 'get_action_status']);
  const trade = new Set(['request_market_order', 'request_limit_order', 'request_cancel_orders']);
  if (!read.has(operation) && !trade.has(operation)) throw new Error('Operation not allowed');
  if (trade.has(operation) && credential.scope !== 'trade') throw new Error('Trade scope required');
  if (operation === 'get_bot_status') return { ready: !!client?.address, network: client?.network ?? null, broker: 'private', trade_requires_telegram_approval: true };
  if (!client?.address || runtimeTransitioning) throw new Error('Trading account unavailable');
  if (operation === 'get_action_status') {
    const a = actions.get(args.action_id);
    return a && a.credential.id === credential.id && a.credential.generation === credential.generation ? view(a) : { status: 'not_found' };
  }
  if (trade.has(operation)) {
    if (!bot?.api || !allowedUserId || busyLocks.get(Number(allowedUserId)) || busyLocks.get(String(allowedUserId))) throw new Error('Telegram approval unavailable');
    if (typeof args.request_id !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(args.request_id)) throw new Error('Unique request_id required');
    const key = `${credential.id}:${credential.generation}:${args.request_id}`;
    const fp = fingerprint({ operation, ...args });
    const prev = requests.get(key);
    if (prev) {
      if (prev.fingerprint !== fp) throw new Error('request_id reused with different arguments');
      if (prev.inFlight) return prev.inFlight;
      const old = actions.get(prev.actionId);
      if (!old) throw new Error('Request already used; inspect exchange before retrying');
      return view(old);
    }
    const inFlightCount = [...requests.values()].filter(r => r.inFlight).length;
    if (actions.size + inFlightCount >= 100 || requests.size >= 500) throw new Error('MCP action queue full');
    const own = [...requests.entries()].filter(([id]) => id.startsWith(`${credential.id}:${credential.generation}:`));
    if (own.filter(([, r]) => Date.now() - r.createdAt < 60_000).length >= 10) throw new Error('MCP request rate limit');
    if (own.some(([, r]) => r.inFlight || ['pending', 'executing'].includes(actions.get(r.actionId)?.status))) {
      throw new Error('Complete or reject the pending MCP action first');
    }
    let resolveFlight, rejectFlight;
    const inFlight = new Promise((resolve, reject) => { resolveFlight = resolve; rejectFlight = reject; });
    inFlight.catch(() => {}); // An unobserved first request must not become an unhandled rejection.
    const reservation = { fingerprint: fp, actionId: null, inFlight, createdAt: Date.now() };
    requests.set(key, reservation); // reserve synchronously, before price/book/network awaits
    try {
      const prepared = await prepareAction(operation, args, client);
      if (accountBinding !== (dependencies.binding?.() ?? runtimeBinding()) || !await isMcpCredentialCurrent(credential)) throw new Error('Account or key changed');
      const id = randomBytes(10).toString('hex');
      const a = { id, ...prepared, credential, binding: accountBinding, status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + ACTION_TTL };
      actions.set(id, a);
      reservation.actionId = id;
      const t = await translate();
      const callback = confirmationCallback(Number(allowedUserId), 'confirm_mcp_action', { state: 'MCP_APPROVAL', actionId: id });
      await bot.api.sendMessage(Number(allowedUserId), t('mcp_trade_review', {
        network: safeText(client.network), address: safeText(client.address), details: safeText(a.label)
      }), {
        reply_markup: new InlineKeyboard().text(t('mcp_trade_approve'), callback).text(t('mcp_trade_reject'), `mcp:reject:${id}`),
      });
      const result = view(a);
      reservation.inFlight = null;
      resolveFlight(result);
      return result;
    } catch (error) {
      if (!reservation.actionId) requests.delete(key);
      else { const a = actions.get(reservation.actionId); if (a) a.status = 'unavailable'; reservation.inFlight = null; }
      rejectFlight(error);
      throw error;
    }
  }
  if (operation === 'get_balances') return { spot_usdc_available: await client.getSpotUsdcBalance(), outcome_usdc_available: await client.getAvailableUsdc(), network: client.network };
  if (operation === 'get_positions') {
    const balances = await client.getUserBalances(); const mids = await client.getAllMids();
    const rows = (balances?.balances || []).filter(b => isOutcomeCoin(b.coin) && Number.isFinite(Number(b.total)) && Number(b.total) > 0);
    return { total: rows.length, items: rows.slice((page(args.page) - 1) * 20, page(args.page) * 20).map(b => {
      const mark = Number(mids?.[coin(b.coin)] ?? mids?.[b.coin]); const basis = Number(b.entryNtl); const size = Number(b.total);
      const validMark = Number.isFinite(mark) && mark >= 0 && mark <= 1;
      const pct = validMark && Number.isFinite(basis) && basis > 0 ? (mark * size / basis - 1) * 100 : NaN;
      return { coin: coin(b.coin), shares: size, mid: validMark ? mark : null,
        return_pct: Number.isFinite(pct) ? Number(pct.toFixed(2)) : null };
    }) };
  }
  if (operation === 'get_open_orders') {
    const rows = (await client.getOpenOrders()).filter(o => isOutcomeCoin(o.coin));
    return { total: rows.length, items: rows.slice((page(args.page) - 1) * 20, page(args.page) * 20).map(o => ({ coin: coin(o.coin), oid: Number(o.oid ?? o.orderId ?? o.id), side: o.side === 'B' ? 'buy' : 'sell', price: Number(o.limitPx ?? o.px), size: Number(o.sz ?? o.size) })) };
  }
  if (operation === 'get_recent_fills') {
    const rows = (await client.getUserFills()).filter(f => isOutcomeCoin(f.coin));
    return { total: rows.length, items: rows.slice((page(args.page) - 1) * 20, page(args.page) * 20).map(f => ({ coin: coin(f.coin), side: f.side === 'B' ? 'buy' : 'sell', price: Number(f.px), size: Number(f.sz), time: Number(f.time), oid: Number(f.oid) })) };
  }
  if (operation === 'get_orderbook') {
    const book = await client.getOrderbook(coin(args.coin));
    return { coin: coin(args.coin), levels: (book?.levels || []).slice(0, 2).map(side => (side || []).slice(0, 5).map(l => ({ price: Number(l.px), size: Number(l.sz) }))) };
  }
  if (operation === 'get_market' || operation === 'list_markets') {
    const events = await fetchAndCacheOutcomes(client);
    if (operation === 'get_market') {
      const entry = getCachedOutcome(args.outcome_id);
      if (!entry) return { status: 'not_found' };
      return { outcome_id: entry.outcomeId, yes_coin: entry.coin0, no_coin: entry.coin1,
        name: safeText(entry.displayName || entry.name), description: safeText(entry.description),
        status: safeText(entry.status), venue: safeText(entry.venue), category: entry.category,
        yes_price_cached: entry.yesPrice ?? null, no_price_cached: entry.noPrice ?? null,
        cached_prices_not_executable: true };
    }
    const filters = normalizeMarketFilters(args.category, args.venue);
    const rows = events.flatMap(event => {
      if (filters.category !== 'all' && event.category !== filters.category) return [];
      const members = event.type === 'standalone' ? [event.outcome] : event.outcomes;
      return members.filter(o => filters.venue === 'all' || o.venue === filters.venue).map(o => ({
        outcome_id: o.outcomeId, name: safeText(o.displayName || o.name), event: safeText(event.name),
        category: event.category, venue: safeText(o.venue), status: safeText(o.status),
        yes_coin: o.coin0, no_coin: o.coin1,
        yes_price_cached: o.yesPrice ?? null, no_price_cached: o.noPrice ?? null
      }));
    });
    return { total: rows.length, page: page(args.page), cached_prices_not_executable: true,
      items: rows.slice((page(args.page) - 1) * 20, page(args.page) * 20) };
  }
  throw new Error('Operation not allowed');
}
