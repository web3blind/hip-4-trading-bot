/**
 * HIP-4 Outcome Formatters
 *
 * All formatters output plain text (no Markdown/HTML) for
 * maximum Telegram + TalkBack accessibility.
 */

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
 * @param {Array} outcomes - array of outcome objects with question, prices
 * @param {number} page - current page (1-based)
 * @param {number} totalPages - total pages
 * @returns {string}
 */
export function formatOutcomeList(outcomes, page, totalPages) {
  if (!outcomes || outcomes.length === 0) {
    return 'No outcomes found.';
  }

  let text = `Outcomes (page ${page}/${totalPages})\n\n`;

  outcomes.forEach((outcome, index) => {
    const num = (page - 1) * 5 + index + 1;
    const question = outcome.question || outcome.description || 'Unknown outcome';
    const yesPrice = outcome.yesPrice != null ? formatPricePercent(outcome.yesPrice) : 'N/A';
    const noPrice = outcome.noPrice != null ? formatPricePercent(outcome.noPrice) : 'N/A';

    const s0 = outcome.side0Name || 'YES';
    const s1 = outcome.side1Name || 'NO';
    text += `${num}. ${question}\n`;
    text += `   ${s0}: ${yesPrice}  |  ${s1}: ${noPrice}\n\n`;
  });

  return text.trimEnd();
}

// ─── Events list (Level 1) ──────────────────────────────────────

export function formatEventsList(events, page, totalPages) {
  if (!events || events.length === 0) {
    return 'No markets available.';
  }

  let text = `Markets (page ${page}/${totalPages})\n\n`;

  events.forEach((event, index) => {
    const num = (page - 1) * 5 + index + 1;

    if (event.type === 'question') {
      text += `${num}. ${event.name}\n`;
      text += `   ${event.outcomeCount} outcomes\n\n`;
    } else {
      // Standalone outcome
      const yesPrice = event.yesPrice != null ? formatPricePercent(event.yesPrice) : 'N/A';
      const noPrice = event.noPrice != null ? formatPricePercent(event.noPrice) : 'N/A';
      const s0 = event.side0Name || 'YES';
      const s1 = event.side1Name || 'NO';
      text += `${num}. ${event.name}\n`;
      text += `   ${s0}: ${yesPrice}  |  ${s1}: ${noPrice}\n\n`;
    }
  });

  return text.trimEnd();
}

// ─── Event outcomes (Level 2) ───────────────────────────────────

export function formatEventOutcomes(event) {
  let text = `${event.name}\n`;
  if (event.description) {
    text += `${event.description}\n`;
  }
  text += '\nOutcomes:\n\n';

  for (const o of event.outcomes) {
    const yesPrice = o.yesPrice != null ? formatPricePercent(o.yesPrice) : 'N/A';
    const noPrice = o.noPrice != null ? formatPricePercent(o.noPrice) : 'N/A';
    const s0 = o.side0Name || 'YES';
    const s1 = o.side1Name || 'NO';
    text += `${o.name}\n`;
    text += `  ${s0}: ${yesPrice}  |  ${s1}: ${noPrice}\n\n`;
  }

  return text.trimEnd();
}

// ─── Outcome detail ────────────────────────────────────────────

/**
 * Format detailed view of a single outcome with orderbook.
 * @param {object} outcome - outcome data (question, description, sides)
 * @param {object} orderbook - { bids: [[price, size], ...], asks: [[price, size], ...] }
 * @param {object} prices - { yes: string|number, no: string|number }
 * @returns {string}
 */
export function formatOutcomeDetail(outcome, orderbook, prices) {
  const question = outcome.question || outcome.description || 'Unknown outcome';
  const description = outcome.description || '';

  let text = `${question}\n`;
  if (description && description !== question) {
    text += `${description}\n`;
  }
  text += '\n';

  // Prices
  const yesPrice = prices?.yes != null ? formatPrice(prices.yes) : 'N/A';
  const noPrice = prices?.no != null ? formatPrice(prices.no) : 'N/A';
  text += `YES: ${yesPrice}\n`;
  text += `NO: ${noPrice}\n`;

  // Spread
  if (prices?.yes != null && prices?.no != null) {
    const spread = Math.abs(1 - Number(prices.yes) - Number(prices.no));
    text += `Spread: ${(spread * 100).toFixed(2)}%\n`;
  }

  text += '\n';

  // Mini orderbook (YES side)
  if (orderbook && (orderbook.bids?.length || orderbook.asks?.length)) {
    text += 'Orderbook (YES):\n';

    if (orderbook.asks?.length) {
      text += 'Asks:\n';
      const asks = orderbook.asks.slice(0, 3);
      asks.forEach(([price, size]) => {
        text += `  ${formatPrice(price)}  size: ${Number(size).toFixed(2)}\n`;
      });
    }

    if (orderbook.bids?.length) {
      text += 'Bids:\n';
      const bids = orderbook.bids.slice(0, 3);
      bids.forEach(([price, size]) => {
        text += `  ${formatPrice(price)}  size: ${Number(size).toFixed(2)}\n`;
      });
    }
  }

  return text.trimEnd();
}

// ─── Positions ─────────────────────────────────────────────────

/**
 * Format a single position.
 */
export function formatPosition(position) {
  const coin = position.coin || 'Unknown';
  const side = (position.side || '').toUpperCase();
  const size = position.size || '0';
  const entry = position.entry_price || position.entryPrice || '0';

  let text = `${coin} ${side}\n`;
  text += `  Size: ${size}\n`;
  text += `  Entry: ${formatPrice(entry)}`;
  return text;
}

/**
 * Format all positions.
 */
export function formatPositionsList(positions) {
  if (!positions || positions.length === 0) {
    return 'No open positions.';
  }

  let text = `Positions (${positions.length})\n\n`;
  positions.forEach((pos, index) => {
    text += `${index + 1}. ${formatPosition(pos)}\n\n`;
  });
  return text.trimEnd();
}

// ─── Orders ────────────────────────────────────────────────────

/**
 * Format a single order.
 */
export function formatOrder(order) {
  const coin = order.coin || 'Unknown';
  const side = (order.side || '').toUpperCase();
  const type = order.order_type || order.orderType || 'Limit';
  const price = order.price || '0';
  const size = order.size || '0';
  const status = order.status || 'open';

  let text = `${coin} ${side} ${type}\n`;
  text += `  Price: ${formatPrice(price)}\n`;
  text += `  Size: ${size}\n`;
  text += `  Status: ${status}`;

  if (order.oid) {
    text += `\n  OID: ${order.oid}`;
  }

  return text;
}

/**
 * Format all orders.
 */
export function formatOrdersList(orders) {
  if (!orders || orders.length === 0) {
    return 'No orders.';
  }

  let text = `Orders (${orders.length})\n\n`;
  orders.forEach((ord, index) => {
    text += `${index + 1}. ${formatOrder(ord)}\n\n`;
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
