import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { getOutcomeByCoin } from '../../database.js';
import { createContext, safeLogError } from '../../logger.js';
import { busyLocks } from '../runtime.js';

/**
 * Check if a coin is an outcome token (HIP-4).
 */
function isOutcomeToken(coin) {
  if (!coin) return false;
  const c = String(coin).trim();
  return c.startsWith('#') || c.startsWith('+') || c.startsWith('@');
}

/**
 * Resolve side label from coin and DB.
 */
function resolveSide(coin, outcome) {
  if (!outcome || !outcome.sides) return 'Unknown';
  for (const side of outcome.sides) {
    if (side.coin === coin) {
      return side.side === 0 ? 'YES' : 'NO';
    }
  }
  return 'Unknown';
}

/**
 * Orders feature for HyperLiquid HIP-4 outcomes.
 *
 * @param {object} deps
 * @param {import('../../hyperliquid.js').HLClient} deps.hlClient
 */
export function createOrdersFeature(deps) {
  const { hlClient } = deps;

  async function showOrders(ctx) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'en');

    if (!config.walletAddress) {
      await ctx.editMessageText(t('wallet_not_configured_setup'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu'),
      });
      return;
    }

    await ctx.editMessageText(t('loading_orders'));

    const chatId = ctx.chat.id;
    busyLocks.set(chatId, true);

    try {
      // Fetch open orders from HL
      const allOrders = await hlClient.getOpenOrders(config.walletAddress);
      const ordersList = Array.isArray(allOrders) ? allOrders : [];

      // Filter for outcome orders
      const outcomeOrders = ordersList.filter((o) => isOutcomeToken(o.coin));

      if (outcomeOrders.length === 0) {
        await ctx.editMessageText(t('no_open_orders'), {
          reply_markup: new InlineKeyboard()
            .text(t('refresh'), 'orders:refresh')
            .text(t('back'), 'back_menu'),
        });
        return;
      }

      let text = `${t('open_orders_title')}\n\n`;
      const keyboard = new InlineKeyboard();

      for (let i = 0; i < outcomeOrders.length; i++) {
        const order = outcomeOrders[i];
        const coin = order.coin;
        const oid = order.oid || order.orderId || order.id || '';

        // Look up outcome from DB
        const outcome = getOutcomeByCoin(coin);
        const question = outcome?.question || coin;
        const side = resolveSide(coin, outcome);

        const orderSide = order.side === 'B' ? 'BUY' : order.side === 'A' ? 'SELL' : (order.side || 'Unknown');
        const price = order.limitPx || order.px || order.price || t('na');
        const size = order.sz || order.size || order.origSz || t('na');
        const orderType = order.orderType || 'Limit';

        text += `${i + 1}. ${question}\n`;
        text += `   ${side} ${orderSide} | ${orderType}\n`;
        text += `   ${t('price')}: ${price} | ${t('size')}: ${size}\n`;
        if (oid) text += `   OID: ${String(oid).slice(0, 12)}...\n`;
        text += '\n';

        // Cancel button per order
        const safeOid = encodeURIComponent(oid);
        keyboard.text(t('cancel_num', { num: i + 1 }), `order:cancel:${safeOid}`);
        if ((i + 1) % 2 === 0) keyboard.row();
      }

      keyboard.row();
      if (outcomeOrders.length > 1) {
        keyboard.text(t('cancel_all'), 'orders:cancelall');
      }
      keyboard.text(t('refresh'), 'orders:refresh');
      keyboard.text(t('back'), 'back_menu');

      await ctx.editMessageText(text, { reply_markup: keyboard });
    } catch (error) {
      const logCtx = createContext('bot', 'showOrders');
      safeLogError(logCtx, error);
      await ctx.editMessageText(t('could_not_load', { scope: t('menu_orders') }), {
        reply_markup: new InlineKeyboard()
          .text(t('try_again'), 'orders:refresh')
          .text(t('back'), 'back_menu'),
      });
    } finally {
      busyLocks.delete(chatId);
    }
  }

  async function cancelOrder(ctx, oid) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'en');

    if (!config.walletAddress) {
      await ctx.editMessageText(t('wallet_not_configured_setup'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu'),
      });
      return;
    }

    const chatId = ctx.chat.id;
    busyLocks.set(chatId, true);

    try {
      await ctx.editMessageText(t('cancelling_order'));
      const orders = await hlClient.getOpenOrders(config.walletAddress);
      const order = Array.isArray(orders)
        ? orders.find((entry) => String(entry.oid) === String(oid))
        : null;
      if (!order?.coin) {
        throw new Error('Order not found in open orders');
      }
      await hlClient.cancelOrder(order.coin, oid);
      await ctx.editMessageText(t('order_cancelled_short', { oid: String(oid).slice(0, 16) }), {
        reply_markup: new InlineKeyboard()
          .text(t('view_orders'), 'orders:refresh')
          .text(t('back'), 'back_menu'),
      });
    } catch (error) {
      const logCtx = createContext('bot', 'cancelOrder');
      safeLogError(logCtx, error);
      await ctx.editMessageText(t('cancel_order_failed'), {
        reply_markup: new InlineKeyboard()
          .text(t('try_again'), `order:cancel:${encodeURIComponent(oid)}`)
          .text(t('back'), 'orders:refresh'),
      });
    } finally {
      busyLocks.delete(chatId);
    }
  }

  async function cancelAllOrders(ctx) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'en');

    if (!config.walletAddress) {
      await ctx.editMessageText(t('wallet_not_configured_setup'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu'),
      });
      return;
    }

    const chatId = ctx.chat.id;
    busyLocks.set(chatId, true);

    try {
      await ctx.editMessageText(t('cancelling_all_orders'));
      await hlClient.cancelAllOrders();
      await ctx.editMessageText(t('all_orders_cancelled'), {
        reply_markup: new InlineKeyboard()
          .text(t('view_orders'), 'orders:refresh')
          .text(t('back'), 'back_menu'),
      });
    } catch (error) {
      const logCtx = createContext('bot', 'cancelAllOrders');
      safeLogError(logCtx, error);
      await ctx.editMessageText(t('cancel_all_failed'), {
        reply_markup: new InlineKeyboard()
          .text(t('try_again'), 'orders:cancelall')
          .text(t('back'), 'orders:refresh'),
      });
    } finally {
      busyLocks.delete(chatId);
    }
  }

  return {
    showOrders,
    cancelOrder,
    cancelAllOrders,
  };
}
