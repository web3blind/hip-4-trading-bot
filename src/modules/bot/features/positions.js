import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { getOutcomeByCoin } from '../../database.js';
import { createContext, safeLogError } from '../../logger.js';
import { busyLocks } from '../runtime.js';
import { isOutcomeCoin as isOutcomeToken, normalizeOutcomeCoin } from '../../hl-encoding.js';

function resolveSide(coin, outcome) {
  if (!outcome || !outcome.sides) return 'Unknown';
  const norm = normalizeOutcomeCoin(coin);
  for (const side of outcome.sides) {
    const sideCoin = normalizeOutcomeCoin(side.coin || '');
    const sideToken = normalizeOutcomeCoin(side.token || '');
    if (sideCoin === norm || sideToken === norm) {
      return side.side === 0 ? 'YES' : 'NO';
    }
  }
  return 'Unknown';
}

function findOutcomeForPosition(coin) {
  const norm = normalizeOutcomeCoin(coin);
  return getOutcomeByCoin(coin)
    || getOutcomeByCoin(norm)
    || getOutcomeByCoin(String(coin).replace('+', '#'))
    || getOutcomeByCoin(String(coin).replace('#', '+'));
}

function toSellCoin(coin, outcome) {
  const norm = normalizeOutcomeCoin(coin);
  if (norm.startsWith('#')) {
    // Verify this coin exists in outcome sides, otherwise return normalized
    if (!outcome?.sides) return norm;
    const match = outcome.sides.find((s) => normalizeOutcomeCoin(s.coin || '') === norm);
    return match?.coin || norm;
  }
  if (!outcome?.sides) return coin;
  const match = outcome.sides.find((side) => side.coin === coin || side.token === coin);
  return match?.coin || norm;
}

export function createPositionsFeature(deps) {
  const { hlClient } = deps;

  async function showPositions(ctx) {
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'en');

    if (!hlClient?.address) {
      await ctx.editMessageText(t('wallet_not_configured_short'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu'),
      });
      return;
    }

    await ctx.editMessageText(t('loading_positions'));

    const chatId = ctx.chat.id;
    busyLocks.set(chatId, true);

    try {
      const balances = await hlClient.getUserBalances(hlClient.address);
      const allBalances = Array.isArray(balances?.balances) ? balances.balances : [];

      const outcomePositions = allBalances.filter((b) => {
        if (!isOutcomeToken(b.coin)) return false;
        const total = parseFloat(b.total || '0');
        return total > 0.0001;
      });

      if (outcomePositions.length === 0) {
        await ctx.editMessageText(t('no_positions'), {
          reply_markup: new InlineKeyboard()
            .text(t('refresh'), 'positions:refresh')
            .text(t('back'), 'back_menu'),
        });
        return;
      }

      let mids = {};
      try {
        mids = await hlClient.getAllMids();
      } catch {
        mids = {};
      }

      let text = `${t('positions_title')}\n\n`;
      const keyboard = new InlineKeyboard();

      for (let i = 0; i < outcomePositions.length; i++) {
        const pos = outcomePositions[i];
        const rawCoin = pos.coin;
        const total = parseFloat(pos.total || '0');
        const outcome = findOutcomeForPosition(rawCoin);
        const sellCoin = toSellCoin(rawCoin, outcome);
        const question = outcome?.question || outcome?.description || sellCoin;
        const side = resolveSide(rawCoin, outcome);

        const normCoin = normalizeOutcomeCoin(rawCoin);
        const midPriceRaw = mids[sellCoin] ?? mids[normCoin] ?? mids[rawCoin];
        const midPrice = midPriceRaw != null ? parseFloat(midPriceRaw) : null;
        const priceStr = midPrice !== null ? midPrice.toFixed(4) : t('na');
        const valueStr = midPrice !== null ? (total * midPrice).toFixed(2) : t('na');

        text += `${i + 1}. ${question}\n`;
        text += `   ${side} | ${t('shares')}: ${total.toFixed(4)} | ${t('price')}: ${priceStr}\n`;
        text += `   ${t('value')}: $${valueStr}\n\n`;

        const safeCoin = encodeURIComponent(sellCoin);
        keyboard.text(t('sell_num', { num: i + 1 }), `pos:sell:${safeCoin}`);
        // Add Limit Sell button — derive outcomeId and side from coin encoding
        const coinNum = sellCoin.replace('#', '');
        const outcomeId = Math.floor(Number(coinNum) / 10);
        const sideStr = Number(coinNum) % 10 === 0 ? 'yes' : 'no';
        keyboard.text(t('limit_num', { num: i + 1 }), `limit:${outcomeId}:${sideStr}:sell`);
        keyboard.row();
      }

      keyboard.row();
      keyboard.text(t('refresh'), 'positions:refresh');
      keyboard.text(t('back'), 'back_menu');

      await ctx.editMessageText(text, { reply_markup: keyboard });
    } catch (error) {
      const logCtx = createContext('bot', 'showPositions');
      safeLogError(logCtx, error);
      await ctx.editMessageText(t('could_not_load', { scope: t('menu_positions') }), {
        reply_markup: new InlineKeyboard()
          .text(t('try_again'), 'positions:refresh')
          .text(t('back'), 'back_menu'),
      });
    } finally {
      busyLocks.delete(chatId);
    }
  }

  return {
    showPositions,
  };
}
