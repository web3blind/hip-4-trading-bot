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

export function mainMenuKeyboard(t) {
  const label = (key, fallback) => (t ? t(key) : fallback);

  return new InlineKeyboard()
    .text(label('menu_markets', 'Markets'), 'outcomes:page:1')
    .text(label('menu_positions', 'Positions'), 'positions')
    .row()
    .text(label('menu_orders', 'Orders'), 'orders')
    .text(label('menu_settings', 'Settings'), 'settings');
}

// Alias for backward compat
export async function getMainMenuKeyboard(lang) {
  return mainMenuKeyboard(null);
}

// ─── Outcomes list (paginated) ─────────────────────────────────

export function outcomesListKeyboard(outcomes, page, totalPages, t) {
  const keyboard = new InlineKeyboard();

  if (outcomes && outcomes.length > 0) {
    outcomes.forEach((outcome) => {
      const label = (outcome.question || outcome.description || 'Unknown').slice(0, 50);
      keyboard.text(label, `outcome:${outcome.outcomeId || outcome.outcome_id}`).row();
    });
  }

  // Pagination row
  const navButtons = [];
  if (page > 1) {
    navButtons.push({ text: '< Prev', data: `outcomes:page:${page - 1}` });
  }
  if (page < totalPages) {
    navButtons.push({ text: 'Next >', data: `outcomes:page:${page + 1}` });
  }

  if (navButtons.length > 0) {
    navButtons.forEach(btn => keyboard.text(btn.text, btn.data));
    keyboard.row();
  }

  keyboard.text('Back', 'back_menu');

  return keyboard;
}

// ─── Outcome detail ────────────────────────────────────────────

export function outcomeDetailKeyboard(outcomeId, t) {
  return new InlineKeyboard()
    .text('Buy YES', `trade:${outcomeId}:yes:buy`)
    .text('Buy NO', `trade:${outcomeId}:no:buy`)
    .row()
    .text('Sell YES', `trade:${outcomeId}:yes:sell`)
    .text('Sell NO', `trade:${outcomeId}:no:sell`)
    .row()
    .text('Back to list', 'outcomes:page:1');
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
