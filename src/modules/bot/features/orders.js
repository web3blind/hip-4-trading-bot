import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { getOutcomeByCoin } from '../../database.js';
import { createContext, safeLogError } from '../../logger.js';
import { busyLocks, userStates, confirmationCallback, invalidateUserState, runtimeBinding } from '../runtime.js';
import { isOutcomeCoin as isOutcomeToken, normalizeOutcomeCoin } from '../../hl-encoding.js';

/**
 * Check if a coin is an outcome token (HIP-4).
 */
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

  async function showOrders(ctx, page = 1) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'en');

    if (!hlClient?.address) {
      await ctx.editMessageText(t('wallet_not_configured_setup'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu'),
      });
      return;
    }

    await ctx.editMessageText(t('loading_orders'));

    const chatId = ctx.chat.id;
    if (busyLocks.get(chatId)) return;
    busyLocks.set(chatId, true);

    try {
      // Fetch open orders from HL
      const allOrders = await hlClient.getOpenOrders(hlClient.address);
      if (!Array.isArray(allOrders)) throw new Error('Open orders unavailable');
      const ordersList = allOrders;

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

      const pages = Math.ceil(outcomeOrders.length / 8);
      page = Math.min(pages, Math.max(1, Number.isSafeInteger(page) ? page : 1));
      text += `${page}/${pages}\n`;
      for (let i = (page - 1) * 8; i < Math.min(page * 8, outcomeOrders.length); i++) {
        const order = outcomeOrders[i];
        const coin = order.coin;
        const oid = order.oid || order.orderId || order.id || '';

        // Look up outcome from DB
        const outcome = getOutcomeByCoin(coin);
        const question = String(outcome?.question || coin).slice(0, 160);
        const side = resolveSide(coin, outcome);

        const orderSide = order.side === 'B' ? 'BUY' : order.side === 'A' ? 'SELL' : 'Unknown';
        const price = String(order.limitPx || order.px || order.price || t('na')).slice(0, 32);
        const size = String(order.sz || order.size || order.origSz || t('na')).slice(0, 32);
        const orderType = String(order.orderType || 'Limit').slice(0, 32);

        text += `${i + 1}. ${question}\n`;
        text += `   ${side} ${orderSide} | ${orderType}\n`;
        text += `   ${t('price')}: ${price} | ${t('size')}: ${size}\n`;
        if (oid) text += `   OID: ${oid}\n`;
        text += '\n';

        // Cancel button per order
        const safeOid = encodeURIComponent(oid);
        keyboard.text(t('cancel_num', { num: i + 1 }), `order:cancel:${safeOid}`);
        if ((i + 1) % 2 === 0) keyboard.row();
      }

      keyboard.row();
      if (page > 1) keyboard.text('←', `orders:page:${page - 1}`);
      if (page < pages) keyboard.text('→', `orders:page:${page + 1}`);
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

  // Bound messages independently of the number of reviewed OIDs.
  async function sendLines(ctx, lines, keyboard) {
    const chunks = []; let chunk = '';
    for (const line of lines) {
      if (chunk.length + line.length > 3000) { chunks.push(chunk); chunk = ''; }
      chunk += line + '\n';
    }
    if (chunk) chunks.push(chunk);
    for (let i = 0; i < chunks.length; i++) {
      const extra = i === chunks.length - 1 ? { reply_markup: keyboard } : {};
      if (i === 0) await ctx.editMessageText(chunks[i], extra);
      else await ctx.reply(chunks[i], extra);
    }
  }

  async function reviewCancellation(ctx, oid = null) {
    const chatId = ctx.chat.id;
    if (!hlClient?.address || busyLocks.get(chatId)) return;
    busyLocks.set(chatId, true);
    let ru = false;
    const binding = runtimeBinding();
    try {
      ru = (await loadConfig()).language === 'ru';
      const open = await hlClient.getOpenOrders(hlClient.address);
      if (!Array.isArray(open)) throw new Error('Open orders unavailable');
      const reviewed = open.filter(o => isOutcomeToken(o.coin) && (oid === null || String(o.oid) === oid))
        .map(o => ({ coin: normalizeOutcomeCoin(o.coin), oid: Number(o.oid) }));
      if (!reviewed.length || reviewed.some(o => !Number.isSafeInteger(o.oid) || o.oid <= 0)) throw new Error('No valid open orders');
      if (binding !== runtimeBinding()) throw new Error('Account changed');
      const callback = confirmationCallback(chatId, 'confirm_cancel_orders', { state: 'CONFIRMING_CANCEL_ORDERS', reviewed, binding });
      await sendLines(ctx, [ru ? 'Проверка отмены: только перечисленные ордера.' : 'Review cancellation: only the listed orders.',
        `${hlClient.network}: ${hlClient.address}`, ...reviewed.map(o => `${o.coin} — OID: ${o.oid}`),
        ru ? 'Новые ордера не затрагиваются. Подтверждение действует 2 минуты.' : 'New orders are excluded. Confirmation expires in 2 minutes.'],
      new InlineKeyboard().text(ru ? 'Подтвердить' : 'Confirm', callback).text(ru ? 'Назад' : 'Back', 'orders:refresh'));
    } catch (error) {
      await invalidateUserState(chatId);
      safeLogError(createContext('bot', 'reviewCancellation'), error);
      await ctx.editMessageText(ru ? 'Не удалось проверить ордера. Обновите список.' : 'Cannot review orders. Refresh the list.', {
        reply_markup: new InlineKeyboard().text(ru ? 'Обновить' : 'Refresh', 'orders:refresh'),
      });
    } finally { busyLocks.delete(chatId); }
  }

  async function executeCancellation(ctx) {
    const chatId = ctx.chat.id;
    const state = userStates.get(chatId);
    if (!state || state.state !== 'CONFIRMING_CANCEL_ORDERS' || state.binding !== runtimeBinding() || busyLocks.get(chatId)) return;
    busyLocks.set(chatId, true);
    const reviewed = structuredClone(state.reviewed);
    await invalidateUserState(chatId);
    try {
      const ru = (await loadConfig()).language === 'ru';
      const lines = [ru ? 'Результаты отмены:' : 'Cancellation results:'];
      // Each client's cancellation checks the exchange status AND exact OID readback.
      // Never retry an uncertain request or fetch new orders for cancellation.
      for (const order of reviewed) {
        let status;
        try {
          const result = await hlClient.cancelOrder(order.coin, order.oid);
          status = result?.verifiedCancelled?.some(oid => Number(oid) === order.oid)
            ? (ru ? 'отмена подтверждена' : 'cancellation verified')
            : (ru ? 'результат неизвестен; проверьте ордер' : 'unknown; inspect order');
        } catch (error) {
          const rejected = error.cancelErrors?.find(e => Number(e.oid) === order.oid);
          status = rejected
            ? (ru ? 'отмена отклонена; проверьте ордер' : 'cancellation rejected; inspect order')
            : (ru ? 'отмена не подтверждена; проверьте ордер, без автоповтора' : 'cancellation not verified; inspect order, no automatic retry');
          safeLogError(createContext('bot', 'executeCancellation'), error);
        }
        lines.push(`OID: ${order.oid} — ${status}`);
      }
      await sendLines(ctx, lines, new InlineKeyboard().text(ru ? 'Обновить' : 'Refresh', 'orders:refresh'));
    } finally { busyLocks.delete(chatId); await invalidateUserState(chatId); }
  }

  return {
    showOrders,
    cancelOrder: (ctx, oid) => reviewCancellation(ctx, oid),
    cancelAllOrders: ctx => reviewCancellation(ctx),
    executeCancellation,
  };
}
