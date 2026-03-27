/**
 * Notification helpers for HyperLiquid HIP-4 Outcome Trading Bot.
 *
 * Simple helpers that send formatted messages via the bot instance.
 */

import { createContext, safeLogWarn } from '../logger.js';

/**
 * Send a generic notification message to a chat.
 *
 * @param {object} bot - Grammy bot instance
 * @param {string|number} chatId - Telegram chat ID
 * @param {string} message - Message text
 * @param {object} [options] - Extra options (reply_markup, parse_mode, etc.)
 */
export async function sendNotification(bot, chatId, message, options = {}) {
  if (!bot || !chatId || !message) return;

  try {
    await bot.api.sendMessage(chatId, message, options);
  } catch (error) {
    const ctx = createContext('notifications', 'sendNotification');
    safeLogWarn(ctx, 'Failed to send notification', { message: error?.message });
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

  const question = order.question || order.coin || 'Unknown';
  const side = order.side || 'Unknown';
  const price = order.price || 'N/A';
  const size = order.size || 'N/A';
  const oid = order.oid ? String(order.oid).slice(0, 12) + '...' : '';

  const message =
    `Order Filled!\n\n` +
    `${question}\n` +
    `${side} | Price: ${price} | Size: ${size}\n` +
    (oid ? `OID: ${oid}\n` : '');

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: 'Positions', callback_data: 'positions:refresh' },
        { text: 'Orders', callback_data: 'orders:refresh' },
      ],
    ],
  };

  await sendNotification(bot, chatId, message, { reply_markup: replyMarkup });
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

  const question = position.question || position.coin || 'Unknown';
  const side = position.side || 'Unknown';
  const oldSize = parseFloat(position.oldSize || '0').toFixed(2);
  const newSize = parseFloat(position.newSize || '0').toFixed(2);

  const direction = parseFloat(position.newSize) > parseFloat(position.oldSize) ? 'Increased' : 'Decreased';

  const message =
    `Position ${direction}\n\n` +
    `${question}\n` +
    `${side} | ${oldSize} -> ${newSize}`;

  const replyMarkup = {
    inline_keyboard: [
      [{ text: 'View Positions', callback_data: 'positions:refresh' }],
    ],
  };

  await sendNotification(bot, chatId, message, { reply_markup: replyMarkup });
}
