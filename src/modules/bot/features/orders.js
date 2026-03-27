import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
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

    if (!config.walletAddress) {
      await ctx.editMessageText('Wallet not configured. Use /setup first.', {
        reply_markup: new InlineKeyboard().text('Back', 'back_menu'),
      });
      return;
    }

    await ctx.editMessageText('Loading orders...');

    const chatId = ctx.chat.id;
    busyLocks.set(chatId, true);

    try {
      // Fetch open orders from HL
      const allOrders = await hlClient.getOpenOrders(config.walletAddress);
      const ordersList = Array.isArray(allOrders) ? allOrders : [];

      // Filter for outcome orders
      const outcomeOrders = ordersList.filter((o) => isOutcomeToken(o.coin));

      if (outcomeOrders.length === 0) {
        await ctx.editMessageText('No open outcome orders.', {
          reply_markup: new InlineKeyboard()
            .text('Refresh', 'orders:refresh')
            .text('Back', 'back_menu'),
        });
        return;
      }

      let text = 'Your Open Orders\n\n';
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
        const price = order.limitPx || order.px || order.price || 'N/A';
        const size = order.sz || order.size || order.origSz || 'N/A';
        const orderType = order.orderType || 'Limit';

        text += `${i + 1}. ${question}\n`;
        text += `   ${side} ${orderSide} | ${orderType}\n`;
        text += `   Price: ${price} | Size: ${size}\n`;
        if (oid) text += `   OID: ${String(oid).slice(0, 12)}...\n`;
        text += '\n';

        // Cancel button per order
        const safeOid = encodeURIComponent(oid);
        keyboard.text(`Cancel #${i + 1}`, `order:cancel:${safeOid}`);
        if ((i + 1) % 2 === 0) keyboard.row();
      }

      keyboard.row();
      if (outcomeOrders.length > 1) {
        keyboard.text('Cancel All', 'orders:cancelall');
      }
      keyboard.text('Refresh', 'orders:refresh');
      keyboard.text('Back', 'back_menu');

      await ctx.editMessageText(text, { reply_markup: keyboard });
    } catch (error) {
      const logCtx = createContext('bot', 'showOrders');
      safeLogError(logCtx, error);
      await ctx.editMessageText('Error loading orders. Try again.', {
        reply_markup: new InlineKeyboard()
          .text('Try Again', 'orders:refresh')
          .text('Back', 'back_menu'),
      });
    } finally {
      busyLocks.delete(chatId);
    }
  }

  async function cancelOrder(ctx, oid) {
    const config = await loadConfig();

    if (!config.walletAddress) {
      await ctx.editMessageText('Wallet not configured.', {
        reply_markup: new InlineKeyboard().text('Back', 'back_menu'),
      });
      return;
    }

    const chatId = ctx.chat.id;
    busyLocks.set(chatId, true);

    try {
      await ctx.editMessageText('Cancelling order...');
      const orders = await hlClient.getOpenOrders(config.walletAddress);
      const order = Array.isArray(orders)
        ? orders.find((entry) => String(entry.oid) === String(oid))
        : null;
      if (!order?.coin) {
        throw new Error('Order not found in open orders');
      }
      await hlClient.cancelOrder(order.coin, oid);
      await ctx.editMessageText(`Order cancelled: ${String(oid).slice(0, 16)}`, {
        reply_markup: new InlineKeyboard()
          .text('View Orders', 'orders:refresh')
          .text('Back', 'back_menu'),
      });
    } catch (error) {
      const logCtx = createContext('bot', 'cancelOrder');
      safeLogError(logCtx, error);
      await ctx.editMessageText('Failed to cancel order. It may have already been filled.', {
        reply_markup: new InlineKeyboard()
          .text('Try Again', `order:cancel:${encodeURIComponent(oid)}`)
          .text('Back', 'orders:refresh'),
      });
    } finally {
      busyLocks.delete(chatId);
    }
  }

  async function cancelAllOrders(ctx) {
    const config = await loadConfig();

    if (!config.walletAddress) {
      await ctx.editMessageText('Wallet not configured.', {
        reply_markup: new InlineKeyboard().text('Back', 'back_menu'),
      });
      return;
    }

    const chatId = ctx.chat.id;
    busyLocks.set(chatId, true);

    try {
      await ctx.editMessageText('Cancelling all orders...');
      await hlClient.cancelAllOrders();
      await ctx.editMessageText('All orders cancelled.', {
        reply_markup: new InlineKeyboard()
          .text('View Orders', 'orders:refresh')
          .text('Back', 'back_menu'),
      });
    } catch (error) {
      const logCtx = createContext('bot', 'cancelAllOrders');
      safeLogError(logCtx, error);
      await ctx.editMessageText('Failed to cancel orders. Try again.', {
        reply_markup: new InlineKeyboard()
          .text('Try Again', 'orders:cancelall')
          .text('Back', 'orders:refresh'),
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
