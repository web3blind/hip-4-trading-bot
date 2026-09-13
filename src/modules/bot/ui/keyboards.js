import { InlineKeyboard } from 'grammy';

/**
 * HIP-4 Outcome Keyboards
 *
 * All keyboard builders accept an optional `t` translation function.
 * When t is provided, labels are translated; otherwise English fallbacks are used.
 */

// Helper: get label from t() or use fallback
const label = (t, key, fallback) => (t ? t(key) : fallback);

// ─── Language selection (kept from old codebase) ───────────────

export function getLanguageSelectionKeyboard() {
  return new InlineKeyboard()
    .text('🇷🇺 Русский', 'select_lang:ru')
    .row()
    .text('🇬🇧 English', 'select_lang:en');
}

// ─── Main menu ─────────────────────────────────────────────────

export function mainMenuKeyboard(t, { walletConfigured = true } = {}) {
  const kb = new InlineKeyboard();

  if (!walletConfigured) {
    kb.text(label(t, 'init_wallet', 'Init Wallet'), 'init_wallet').row();
    kb.text(label(t, 'menu_settings', 'Settings'), 'settings');
    return kb;
  }

  kb.text(label(t, 'menu_markets', 'Markets'), 'outcomes:page:1')
    .text(label(t, 'menu_positions', 'Positions'), 'positions')
    .row()
    .text(label(t, 'menu_orders', 'Orders'), 'orders')
    .text(label(t, 'menu_wallet', 'Wallet'), 'wallet')
    .row()
    .text(label(t, 'menu_search', 'Search'), 'search_markets')
    .text(label(t, 'menu_settings', 'Settings'), 'settings');
  return kb;
}

// Alias — checks wallet config state
export async function getMainMenuKeyboard(lang) {
  const { isWalletConfigured } = await import('../../config.js');
  const { getTranslator } = await import('../../i18n.js');
  const configured = await isWalletConfigured();
  const t = await getTranslator(lang || 'en');
  return mainMenuKeyboard(t, { walletConfigured: configured });
}

// ─── Events list (Level 1: questions + standalones) ─────────────

export function outcomesListKeyboard(events, page, totalPages, t) {
  const keyboard = new InlineKeyboard();

  if (events && events.length > 0) {
    events.forEach((event) => {
      if (event.type === 'question') {
        const lbl = (event.name || 'Event').slice(0, 50);
        keyboard.text(lbl, `event:${event.questionId}`).row();
      } else {
        // Standalone outcome — go directly to detail
        const lbl = (event.name || 'Outcome').slice(0, 50);
        keyboard.text(lbl, `outcome:${event.outcomeId}`).row();
      }
    });
  }

  // Pagination
  const navButtons = [];
  if (page > 1) navButtons.push({ text: label(t, 'prev', '< Prev'), data: `outcomes:page:${page - 1}` });
  if (page < totalPages) navButtons.push({ text: label(t, 'next', 'Next >'), data: `outcomes:page:${page + 1}` });
  if (navButtons.length > 0) {
    navButtons.forEach(btn => keyboard.text(btn.text, btn.data));
    keyboard.row();
  }

  keyboard.text(label(t, 'back', 'Back'), 'back_menu');
  return keyboard;
}

// ─── Event outcomes (Level 2: outcomes within a question) ───────

export function eventOutcomesKeyboard(event, t) {
  const keyboard = new InlineKeyboard();

  if (event.outcomes && event.outcomes.length > 0) {
    for (const o of event.outcomes) {
      const price = o.yesPrice != null ? ` (${(o.yesPrice * 100).toFixed(0)}%)` : '';
      const lbl = ((o.displayName || o.name) + price).slice(0, 50);
      keyboard.text(lbl, `outcome:${o.outcomeId}`).row();
    }
  }

  if (event.page > 1) keyboard.text('‹', `event:${event.questionId}:${event.page - 1}`);
  if (event.page < event.totalPages) keyboard.text('›', `event:${event.questionId}:${event.page + 1}`);
  if (event.totalPages > 1) keyboard.row();
  keyboard.text(label(t, 'back_to_markets', 'Back to markets'), 'outcomes:page:1');
  return keyboard;
}

// ─── Outcome detail ────────────────────────────────────────────

export function outcomeDetailKeyboard(outcomeId, t, tradeable) {
  const kb = new InlineKeyboard();
  const tr = tradeable || { yesBuy: true, yesSell: true, noBuy: true, noSell: true };

  // Market buttons — only show if orderbook has liquidity
  const marketRow = [];
  if (tr.yesBuy) marketRow.push({ text: label(t, 'buy_yes', 'Buy YES'), data: `trade:${outcomeId}:yes:buy` });
  if (tr.noBuy) marketRow.push({ text: label(t, 'buy_no', 'Buy NO'), data: `trade:${outcomeId}:no:buy` });
  if (marketRow.length > 0) {
    marketRow.forEach(b => kb.text(b.text, b.data));
    kb.row();
  }

  const sellRow = [];
  if (tr.yesSell) sellRow.push({ text: label(t, 'sell_yes', 'Sell YES'), data: `trade:${outcomeId}:yes:sell` });
  if (tr.noSell) sellRow.push({ text: label(t, 'sell_no', 'Sell NO'), data: `trade:${outcomeId}:no:sell` });
  if (sellRow.length > 0) {
    sellRow.forEach(b => kb.text(b.text, b.data));
    kb.row();
  }

  // Limit buttons — only if coin is in spot universe
  const limitRow = [];
  if (tr.yesInUniverse !== false) limitRow.push({ text: label(t, 'limit_yes', 'Limit YES'), data: `limit:${outcomeId}:yes:buy` });
  if (tr.noInUniverse !== false) limitRow.push({ text: label(t, 'limit_no', 'Limit NO'), data: `limit:${outcomeId}:no:buy` });
  if (limitRow.length > 0) {
    limitRow.forEach(b => kb.text(b.text, b.data));
    kb.row();
  }

  // Split Buy (arbitrage) button — only if arb exists
  if (tr.splitArb) {
    const profitLabel = tr.splitArb.profitPct.toFixed(1);
    const splitLabel = t ? t('split_buy_btn', { profit: profitLabel }) : `Split Buy (profit ${profitLabel}%)`;
    kb.text(splitLabel, `split:${outcomeId}`).row();
  }

  kb.text(label(t, 'back_to_list', 'Back to list'), 'outcomes:page:1');
  return kb;
}

// ─── Trade confirmation ────────────────────────────────────────

export function tradeConfirmKeyboard(outcomeId, side, action, t) {
  return new InlineKeyboard()
    .text(label(t, 'confirm', 'Confirm'), `trade_confirm:${outcomeId}:${side}:${action}`)
    .text(label(t, 'cancel', 'Cancel'), `outcome:${outcomeId}`);
}

// ─── Positions list ────────────────────────────────────────────

export function positionsKeyboard(positions, t) {
  const keyboard = new InlineKeyboard();

  if (positions && positions.length > 0) {
    positions.forEach((pos, index) => {
      const lbl = `${pos.coin} ${(pos.side || '').toUpperCase()}`;
      keyboard.text(lbl, `position:${index}`).row();
    });
  }

  keyboard.text(label(t, 'refresh', 'Refresh'), 'positions').row();
  keyboard.text(label(t, 'back', 'Back'), 'back_menu');

  return keyboard;
}

// ─── Orders list ───────────────────────────────────────────────

export function ordersKeyboard(orders, t) {
  const keyboard = new InlineKeyboard();

  if (orders && orders.length > 0) {
    orders.forEach((order) => {
      const lbl = `${order.coin} ${(order.side || '').toUpperCase()} ${order.order_type || ''}`.trim();
      const oid = order.oid || order.id;
      keyboard.text(lbl, `order:${oid}`).row();
    });
  }

  keyboard.text(label(t, 'refresh', 'Refresh'), 'orders').row();
  keyboard.text(label(t, 'back', 'Back'), 'back_menu');

  return keyboard;
}

// ─── Generic back button ───────────────────────────────────────

export function backKeyboard(callbackData, t) {
  return new InlineKeyboard()
    .text(label(t, 'back', 'Back'), callbackData || 'back_menu');
}

// ─── Settings ──────────────────────────────────────────────────

export function settingsKeyboard(t) {
  return new InlineKeyboard()
    .text(label(t, 'language_btn', 'Language'), 'settings:language')
    .row()
    .text(label(t, 'network_btn', 'Network'), 'settings:network')
    .row()
    .text(label(t, 'notifications_btn', 'Notifications'), 'settings:notifications')
    .row()
    .text(label(t, 'back', 'Back'), 'back_menu');
}
