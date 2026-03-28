/**
 * HIP-4 Outcome Formatters
 *
 * All formatters output plain text (no Markdown/HTML) for
 * maximum Telegram + TalkBack accessibility.
 *
 * Functions accept an optional `t` translation function.
 * When t is provided, labels are translated; otherwise English fallbacks.
 */

// Helper
const L = (t, key, fallback) => (t ? t(key) : fallback);

// ─── Price / USDC helpers ──────────────────────────────────────

/**
 * Format a 0-1 price as both dollar and percentage.
 * e.g. 0.73 => "$0.73 (73%)"
 */
export function formatPrice(price) {
  if (price === null || price === undefined) return 'N/A';
  const num = Number(price);
  if (!Number.isFinite(num)) return 'N/A';
  const pct = (num * 100).toFixed(1);
  return `$${num.toFixed(4)} (${pct}%)`;
}

/**
 * Short percentage-only display.
 * e.g. 0.73 => "73.0%"
 */
export function formatPricePercent(price) {
  if (price === null || price === undefined) return 'N/A';
  const num = Number(price);
  if (!Number.isFinite(num)) return 'N/A';
  return `${(num * 100).toFixed(1)}%`;
}

/**
 * Format a USDC amount.
 * e.g. 1234.5 => "$1,234.50"
 */
export function formatUSDC(amount) {
  const num = Number(amount);
  if (!Number.isFinite(num)) return '$0.00';
  return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ─── Outcome list ──────────────────────────────────────────────

/**
 * Format a paginated list of outcomes for the browse view.
 */
export function formatOutcomeList(outcomes, page, totalPages, t) {
  if (!outcomes || outcomes.length === 0) {
    return L(t, 'no_outcomes', 'No outcomes found.');
  }

  let text = L(t, 'outcomes_page', `Outcomes (page ${page}/${totalPages})`).replace('{{page}}', page).replace('{{total}}', totalPages) + '\n\n';

  outcomes.forEach((outcome, index) => {
    const num = (page - 1) * 5 + index + 1;
    const question = outcome.question || outcome.description || L(t, 'unknown', 'Unknown outcome');
    const yesPrice = outcome.yesPrice != null ? formatPricePercent(outcome.yesPrice) : L(t, 'na', 'N/A');
    const noPrice = outcome.noPrice != null ? formatPricePercent(outcome.noPrice) : L(t, 'na', 'N/A');

    const s0 = outcome.side0Name || 'YES';
    const s1 = outcome.side1Name || 'NO';
    text += `${num}. ${question}\n`;
    text += `   ${s0}: ${yesPrice}  |  ${s1}: ${noPrice}\n\n`;
  });

  return text.trimEnd();
}

// ─── Events list (Level 1) ──────────────────────────────────────

export function formatEventsList(events, page, totalPages, t) {
  if (!events || events.length === 0) {
    return L(t, 'no_markets_available', 'No markets available.');
  }

  let text = L(t, 'markets_page', `Markets (page ${page}/${totalPages})`).replace('{{page}}', page).replace('{{total}}', totalPages) + '\n\n';

  events.forEach((event, index) => {
    const num = (page - 1) * 5 + index + 1;

    if (event.type === 'question') {
      text += `${num}. ${event.name}\n`;
      text += `   ${event.outcomeCount} ${L(t, 'outcomes_label', 'outcomes')}\n\n`;
    } else {
      // Standalone outcome — use parsed priceBinary or raw name
      const parsed = formatPriceBinaryDescription(event.description);
      const title = parsed ? parsed.split('\n')[0] : event.name;
      const yesPrice = event.yesPrice != null ? formatPricePercent(event.yesPrice) : L(t, 'na', 'N/A');
      const noPrice = event.noPrice != null ? formatPricePercent(event.noPrice) : L(t, 'na', 'N/A');
      const s0 = event.side0Name || 'YES';
      const s1 = event.side1Name || 'NO';
      text += `${num}. ${title}\n`;
      text += `   ${s0}: ${yesPrice}  |  ${s1}: ${noPrice}\n\n`;
    }
  });

  return text.trimEnd();
}

// ─── Event outcomes (Level 2) ───────────────────────────────────

export function formatEventOutcomes(event, t) {
  let text = `${event.name}\n`;
  if (event.description) {
    text += `${event.description}\n`;
  }
  text += `\n${L(t, 'outcomes_label', 'Outcomes')}:\n\n`;

  for (const o of event.outcomes) {
    const yesPrice = o.yesPrice != null ? formatPricePercent(o.yesPrice) : L(t, 'na', 'N/A');
    const noPrice = o.noPrice != null ? formatPricePercent(o.noPrice) : L(t, 'na', 'N/A');
    const s0 = o.side0Name || 'YES';
    const s1 = o.side1Name || 'NO';
    text += `${o.name}\n`;
    text += `  ${s0}: ${yesPrice}  |  ${s1}: ${noPrice}\n\n`;
  }

  return text.trimEnd();
}

// ─── priceBinary description parser ────────────────────────────

/**
 * Parse a priceBinary description into human-readable lines.
 * Input:  "class:priceBinary|underlying:BTC|expiry:20260329-0300|targetPrice:66220|period:1d"
 * Output: "BTC > $66,220\nExpiry: Mar 29, 2026 03:00 UTC\nPeriod: 1d"
 */
function formatPriceBinaryDescription(description) {
  if (!description || !description.startsWith('class:priceBinary')) return null;

  const parts = {};
  for (const seg of description.split('|')) {
    const idx = seg.indexOf(':');
    if (idx > 0) parts[seg.slice(0, idx)] = seg.slice(idx + 1);
  }

  if (!parts.underlying || !parts.targetPrice) return null;

  const lines = [];
  const price = Number(parts.targetPrice).toLocaleString('en-US');
  lines.push(`${parts.underlying} > $${price}`);

  if (parts.expiry) {
    // Parse "20260329-0300" → "Mar 29, 2026 03:00 UTC"
    const m = parts.expiry.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
    if (m) {
      const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`);
      if (!isNaN(d.getTime())) {
        lines.push(`Expiry: ${d.toUTCString().replace(' GMT', ' UTC')}`);
      } else {
        lines.push(`Expiry: ${parts.expiry}`);
      }
    } else {
      lines.push(`Expiry: ${parts.expiry}`);
    }
  }

  if (parts.period) {
    lines.push(`Period: ${parts.period}`);
  }

  return lines.join('\n');
}

// ─── Outcome detail ────────────────────────────────────────────

/**
 * Format detailed view of a single outcome with orderbook.
 */
export function formatOutcomeDetail(outcome, orderbook, prices, t) {
  const question = outcome.question || outcome.description || L(t, 'unknown', 'Unknown outcome');
  const description = outcome.description || '';

  let text = `${question}\n`;

  // Format priceBinary descriptions nicely, show raw for others
  const parsed = formatPriceBinaryDescription(description);
  if (parsed) {
    text += `${parsed}\n`;
  } else if (description && description !== question) {
    text += `${description}\n`;
  }
  text += '\n';

  // Prices
  const yesPrice = prices?.yes != null ? formatPrice(prices.yes) : L(t, 'na', 'N/A');
  const noPrice = prices?.no != null ? formatPrice(prices.no) : L(t, 'na', 'N/A');
  text += `YES: ${yesPrice}\n`;
  text += `NO: ${noPrice}\n`;

  // Spread
  if (prices?.yes != null && prices?.no != null) {
    const spread = Math.abs(1 - Number(prices.yes) - Number(prices.no));
    text += `${L(t, 'spread', 'Spread')}: ${(spread * 100).toFixed(2)}%\n`;
  }

  text += '\n';

  // Mini orderbook (YES side)
  if (orderbook && (orderbook.bids?.length || orderbook.asks?.length)) {
    text += `${L(t, 'orderbook_yes', 'Orderbook (YES)')}:\n`;

    if (orderbook.asks?.length) {
      text += `${L(t, 'asks_label', 'Asks')}:\n`;
      const asks = orderbook.asks.slice(0, 3);
      asks.forEach(([price, size]) => {
        text += `  ${formatPrice(price)}  ${L(t, 'size', 'size')}: ${Number(size).toFixed(2)}\n`;
      });
    }

    if (orderbook.bids?.length) {
      text += `${L(t, 'bids_label', 'Bids')}:\n`;
      const bids = orderbook.bids.slice(0, 3);
      bids.forEach(([price, size]) => {
        text += `  ${formatPrice(price)}  ${L(t, 'size', 'size')}: ${Number(size).toFixed(2)}\n`;
      });
    }
  }

  return text.trimEnd();
}

// ─── Positions ─────────────────────────────────────────────────

/**
 * Format a single position.
 */
export function formatPosition(position, t) {
  const coin = position.coin || L(t, 'unknown', 'Unknown');
  const side = (position.side || '').toUpperCase();
  const size = position.size || '0';
  const entry = position.entry_price || position.entryPrice || '0';

  let text = `${coin} ${side}\n`;
  text += `  ${L(t, 'size', 'Size')}: ${size}\n`;
  text += `  ${L(t, 'entry', 'Entry')}: ${formatPrice(entry)}`;
  return text;
}

/**
 * Format all positions.
 */
export function formatPositionsList(positions, t) {
  if (!positions || positions.length === 0) {
    return L(t, 'no_open_positions', 'No open positions.');
  }

  let text = L(t, 'positions_count', `Positions (${positions.length})`).replace('{{count}}', positions.length) + '\n\n';
  positions.forEach((pos, index) => {
    text += `${index + 1}. ${formatPosition(pos, t)}\n\n`;
  });
  return text.trimEnd();
}

// ─── Orders ────────────────────────────────────────────────────

/**
 * Format a single order.
 */
export function formatOrder(order, t) {
  const coin = order.coin || L(t, 'unknown', 'Unknown');
  const side = (order.side || '').toUpperCase();
  const type = order.order_type || order.orderType || 'Limit';
  const price = order.price || '0';
  const size = order.size || '0';
  const status = order.status || 'open';

  let text = `${coin} ${side} ${type}\n`;
  text += `  ${L(t, 'price', 'Price')}: ${formatPrice(price)}\n`;
  text += `  ${L(t, 'size', 'Size')}: ${size}\n`;
  text += `  ${L(t, 'status', 'Status')}: ${status}`;

  if (order.oid) {
    text += `\n  OID: ${order.oid}`;
  }

  return text;
}

/**
 * Format all orders.
 */
export function formatOrdersList(orders, t) {
  if (!orders || orders.length === 0) {
    return L(t, 'no_orders_short', 'No orders.');
  }

  let text = L(t, 'orders_count', `Orders (${orders.length})`).replace('{{count}}', orders.length) + '\n\n';
  orders.forEach((ord, index) => {
    text += `${index + 1}. ${formatOrder(ord, t)}\n\n`;
  });
  return text.trimEnd();
}

// ─── Utility formatters kept from old codebase ─────────────────

export function escapeHtml(raw) {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function normalizeOutcomeSideHint(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (!normalized) return null;

  if (normalized === 'YES' || normalized === 'Y' || normalized === 'UP' || normalized === '1' || normalized === 'ДА') {
    return 'YES';
  }

  if (normalized === 'NO' || normalized === 'N' || normalized === 'DOWN' || normalized === '0' || normalized === 'НЕТ') {
    return 'NO';
  }

  return null;
}

export function parsePercentInput(raw) {
  const normalized = String(raw ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(',', '.');

  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) {
    return null;
  }

  return Number(value.toFixed(2));
}

export function parsePositiveNumberInput(raw) {
  const normalized = String(raw ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(',', '.');

  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Number(value.toFixed(2));
}

export function parseUnitIntervalInput(raw, digits = 4) {
  const normalized = String(raw ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(',', '.');

  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Number(value.toFixed(Math.max(1, Math.floor(digits))));
}

export function parseNonNegativeIntegerInput(raw) {
  const normalized = String(raw ?? '').trim().replace(/\s+/g, '');
  if (!/^\d+$/.test(normalized)) {
    return null;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.floor(value);
}
