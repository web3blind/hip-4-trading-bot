import { InlineKeyboard } from 'grammy';

/**
 * HIP-4 Outcome Keyboards
 *
 * All keyboard builders accept an optional `t` translation function.
 * For now we use plain English string literals as default.
 */

// ─── Language selection (kept from old codebase) ───────────────

export function getLanguageSelectionKeyboard() {
  return new InlineKeyboard()
    .text('🇷🇺 Русский', 'select_lang:ru')
    .row()
    .text('🇬🇧 English', 'select_lang:en');
}

// ─── Main menu ─────────────────────────────────────────────────

export function mainMenuKeyboard(t, { walletConfigured = true } = {}) {
  const label = (key, fallback) => (t ? t(key) : fallback);

  const kb = new InlineKeyboard();

  if (!walletConfigured) {
    kb.text('Init Wallet', 'init_wallet').row();
    kb.text(label('menu_settings', 'Settings'), 'settings');
    return kb;
  }

  kb.text(label('menu_markets', 'Markets'), 'outcomes:page:1')
    .text(label('menu_positions', 'Positions'), 'positions')
    .row()
    .text(label('menu_orders', 'Orders'), 'orders')
    .text('Wallet', 'wallet')
    .row()
    .text(label('menu_settings', 'Settings'), 'settings');
  return kb;
}

// Alias — checks wallet config state
export async function getMainMenuKeyboard(lang) {
  const { isWalletConfigured } = await import('../../config.js');
  const configured = await isWalletConfigured();
  return mainMenuKeyboard(null, { walletConfigured: configured });
}

// ─── Events list (Level 1: questions + standalones) ─────────────

export function outcomesListKeyboard(events, page, totalPages, t) {
  const keyboard = new InlineKeyboard();

  if (events && events.length > 0) {
    events.forEach((event) => {
      if (event.type === 'question') {
        const label = (event.name || 'Event').slice(0, 50);
        keyboard.text(label, `event:${event.questionId}`).row();
      } else {
        // Standalone outcome — go directly to detail
        const label = (event.name || 'Outcome').slice(0, 50);
        keyboard.text(label, `outcome:${event.outcomeId}`).row();
      }
    });
  }

  // Pagination
  const navButtons = [];
  if (page > 1) navButtons.push({ text: '< Prev', data: `outcomes:page:${page - 1}` });
  if (page < totalPages) navButtons.push({ text: 'Next >', data: `outcomes:page:${page + 1}` });
  if (navButtons.length > 0) {
    navButtons.forEach(btn => keyboard.text(btn.text, btn.data));
    keyboard.row();
  }

  keyboard.text('Back', 'back_menu');
  return keyboard;
}

// ─── Event outcomes (Level 2: outcomes within a question) ───────

export function eventOutcomesKeyboard(event) {
  const keyboard = new InlineKeyboard();

  if (event.outcomes && event.outcomes.length > 0) {
    for (const o of event.outcomes) {
      const price = o.yesPrice != null ? ` (${(o.yesPrice * 100).toFixed(0)}%)` : '';
      const label = (o.name + price).slice(0, 50);
      keyboard.text(label, `outcome:${o.outcomeId}`).row();
    }
  }

  keyboard.text('Back to markets', 'outcomes:page:1');
  return keyboard;
}

// ─── Outcome detail ────────────────────────────────────────────

export function outcomeDetailKeyboard(outcomeId, t, tradeable) {
  const kb = new InlineKeyboard();
  const tr = tradeable || { yesBuy: true, yesSell: true, noBuy: true, noSell: true };

  // Market buttons — only show if orderbook has liquidity
  const marketRow = [];
  if (tr.yesBuy) marketRow.push({ text: 'Buy YES', data: `trade:${outcomeId}:yes:buy` });
  if (tr.noBuy) marketRow.push({ text: 'Buy NO', data: `trade:${outcomeId}:no:buy` });
  if (marketRow.length > 0) {
    marketRow.forEach(b => kb.text(b.text, b.data));
    kb.row();
  }

  const sellRow = [];
  if (tr.yesSell) sellRow.push({ text: 'Sell YES', data: `trade:${outcomeId}:yes:sell` });
  if (tr.noSell) sellRow.push({ text: 'Sell NO', data: `trade:${outcomeId}:no:sell` });
  if (sellRow.length > 0) {
    sellRow.forEach(b => kb.text(b.text, b.data));
    kb.row();
  }

  // Limit buttons — only if coin is in spot universe
  const limitRow = [];
  if (tr.yesInUniverse !== false) limitRow.push({ text: 'Limit YES', data: `limit:${outcomeId}:yes:buy` });
  if (tr.noInUniverse !== false) limitRow.push({ text: 'Limit NO', data: `limit:${outcomeId}:no:buy` });
  if (limitRow.length > 0) {
    limitRow.forEach(b => kb.text(b.text, b.data));
    kb.row();
  }

  kb.text('Back to list', 'outcomes:page:1');
  return kb;
}

// ─── Trade confirmation ────────────────────────────────────────

export function tradeConfirmKeyboard(outcomeId, side, action, t) {
  return new InlineKeyboard()
    .text('Confirm', `trade_confirm:${outcomeId}:${side}:${action}`)
    .text('Cancel', `outcome:${outcomeId}`);
}

// ─── Positions list ────────────────────────────────────────────

export function positionsKeyboard(positions, t) {
  const keyboard = new InlineKeyboard();

  if (positions && positions.length > 0) {
    positions.forEach((pos, index) => {
      const label = `${pos.coin} ${(pos.side || '').toUpperCase()}`;
      keyboard.text(label, `position:${index}`).row();
    });
  }

  keyboard.text('Refresh', 'positions').row();
  keyboard.text('Back', 'back_menu');

  return keyboard;
}

// ─── Orders list ───────────────────────────────────────────────

export function ordersKeyboard(orders, t) {
  const keyboard = new InlineKeyboard();

  if (orders && orders.length > 0) {
    orders.forEach((order) => {
      const label = `${order.coin} ${(order.side || '').toUpperCase()} ${order.order_type || ''}`.trim();
      const oid = order.oid || order.id;
      keyboard.text(label, `order:${oid}`).row();
    });
  }

  keyboard.text('Refresh', 'orders').row();
  keyboard.text('Back', 'back_menu');

  return keyboard;
}

// ─── Generic back button ───────────────────────────────────────

export function backKeyboard(callbackData, t) {
  return new InlineKeyboard()
    .text('Back', callbackData || 'back_menu');
}

// ─── Settings ──────────────────────────────────────────────────

export function settingsKeyboard(t) {
  return new InlineKeyboard()
    .text('Language', 'settings:language')
    .row()
    .text('Network', 'settings:network')
    .row()
    .text('Back', 'back_menu');
}
