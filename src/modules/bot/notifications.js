/**
 * Notification helpers for HyperLiquid HIP-4 Outcome Trading Bot.
 *
 * Simple helpers that send formatted messages via the bot instance.
 */

import { createContext, safeLogWarn } from '../logger.js';
import { loadConfig } from '../config.js';
import { getTranslator } from '../i18n.js';

export async function notifyCompleteSetUpdate(bot, chatId, attempt) {
  if (!bot || !chatId) return false;
  const config=await loadConfig(),t=await getTranslator(config.language||'en');
  const counts=attempt.legs.map(l=>`${l.coin}: ${Number(l.filledSize||0)}/${l.size}`);
  try {
    await bot.api.sendMessage(chatId,`${t('set_update')} #${attempt.questionId} (${attempt.state})\n${counts.join('\n')}\n${t('set_monitor_note')}`);
    return true;
  } catch {return false;}
}

export async function notifyBundlePortfolio(bot,chatId,snapshot,kind) {
  if(!bot || !chatId) return false;
  const config=await loadConfig(),t=await getTranslator(config.language||'en');
  const amount=kind==='closed'?snapshot.net:snapshot.indicativePnl;
  const percent=typeof snapshot.cost==='number' && snapshot.cost>0?` (${(amount/snapshot.cost*100).toFixed(2)}%)`:'';
  return sendNotification(bot,chatId,`${t('bundle_title')} ${String(snapshot.label||'#'+snapshot.questionId).slice(0,100)}\n${t(kind==='closed'?'bundle_net':'bundle_indicative')}: $${amount.toFixed(2)}${percent}\n${kind==='closed'?'':t('bundle_caveat')}`,
    {reply_markup:{inline_keyboard:[[{text:t('bundle_title'),callback_data:`bundle_detail:${snapshot.id}`}]]}});
}

export async function notifyCompleteSet(bot, chatId, question, quote) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');
  const a=question.description.match(/(?:^|\|)participantA:([^|]+)/)?.[1];
  const b=question.description.match(/(?:^|\|)participantB:([^|]+)/)?.[1];
  const label=a&&b?`${a.slice(0,55)} — ${b.slice(0,55)}`:`${String(question.name).slice(0,60)} #${question.question}`;
  const text=`${t('set_alert_title')}\n${label}\n${t('set_legs')}: ${quote.orders.length}\n${t('set_shares')}: ${quote.shares}\n`+
    `${t('set_spend')}: $${quote.maxSpend.toFixed(2)}\n${t('set_max_cost')}: $${quote.worstCost.toFixed(2)}\n`+
    `${t('set_fee_max')}: $${quote.feeMax.toFixed(2)}\n${t('set_net_floor')}: $${quote.netLowerBound.toFixed(2)}\n`+
    `${t('set_fee_warning')}\n${t('set_quote_expiry')}`;
  return sendNotification(bot,chatId,text,{reply_markup:{inline_keyboard:[[{
    text:t('set_check_button'),callback_data:`set_open:${question.question}`
  }]]}});
}

/**
 * Send a generic notification message to a chat.
 *
 * @param {object} bot - Grammy bot instance
 * @param {string|number} chatId - Telegram chat ID
 * @param {string} message - Message text
 * @param {object} [options] - Extra options (reply_markup, parse_mode, etc.)
 */
export async function sendNotification(bot, chatId, message, options = {}) {
  if (!bot || !chatId || !message) return false;

  try {
    await bot.api.sendMessage(chatId, message, options);
    return true;
  } catch (error) {
    const ctx = createContext('notifications', 'sendNotification');
    safeLogWarn(ctx, 'Failed to send notification', { message: error?.message });
    return false;
  }
}

/**
 * Notify user that an order has been filled.
 *
 * @param {object} bot - Grammy bot instance
 * @param {string|number} chatId - Telegram chat ID
 * @param {object} order - Order details
 * @param {string} order.oid - Order ID
 * @param {string} order.coin - Coin/token
 * @param {string} order.question - Outcome question
 * @param {string} order.side - BUY/SELL
 * @param {string} order.price - Fill price
 * @param {string} order.size - Size filled
 */
export async function notifyOrderFilled(bot, chatId, order) {
  if (!bot || !chatId) return;

  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');

  const question = order.question || order.coin || t('unknown');
  const side = order.side || t('unknown');
  const price = Number.isFinite(Number(order.price)) && order.price !== ''
    ? String(Number(Number(order.price).toFixed(8))) : t('na');
  const size = Number.isFinite(Number(order.size)) && order.size !== ''
    ? String(Number(Number(order.size).toFixed(8))) : t('na');
  const oid = order.oid ? String(order.oid).slice(0, 12) + '...' : '';

  const message =
    `${t('notif_order_filled')}\n\n` +
    `${question}\n` +
    `${side} | ${t('price')}: ${price} | ${t('size')}: ${size}\n` +
    (oid ? `OID: ${oid}\n` : '');

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: t('menu_positions'), callback_data: 'positions:refresh' },
        { text: t('menu_orders'), callback_data: 'orders:refresh' },
      ],
    ],
  };

  return sendNotification(bot, chatId, message, { reply_markup: replyMarkup });
}

/**
 * Notify user of a significant position change.
 *
 * @param {object} bot - Grammy bot instance
 * @param {string|number} chatId - Telegram chat ID
 * @param {object} position - Position change details
 * @param {string} position.coin - Coin
 * @param {string} position.question - Outcome question
 * @param {string} position.side - YES/NO
 * @param {string} position.oldSize - Previous size
 * @param {string} position.newSize - New size
 */
export async function notifyPositionChange(bot, chatId, position) {
  if (!bot || !chatId) return;

  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');

  const question = position.question || position.coin || t('unknown');
  const side = position.side || t('unknown');
  const oldSize = parseFloat(position.oldSize || '0').toFixed(4);
  const newSize = parseFloat(position.newSize || '0').toFixed(4);

  const increased = parseFloat(position.newSize) > parseFloat(position.oldSize);
  const direction = increased ? t('notif_position_increased') : t('notif_position_decreased');

  const message =
    `${direction}\n\n` +
    `${question}\n` +
    `${side} | ${oldSize} → ${newSize}`;

  const replyMarkup = {
    inline_keyboard: [
      [{ text: t('notif_view_positions'), callback_data: 'positions:refresh' }],
    ],
  };

  await sendNotification(bot, chatId, message, { reply_markup: replyMarkup });
}
