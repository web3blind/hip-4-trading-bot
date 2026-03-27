import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getOutcomeByCoin } from '../../database.js';
import { createContext, safeLogError } from '../../logger.js';
import { busyLocks } from '../runtime.js';

function isOutcomeToken(coin) {
  if (!coin) return false;
  const c = String(coin).trim();
  return c.startsWith('#') || c.startsWith('+') || c.startsWith('@');
}

function resolveSide(coin, outcome) {
  if (!outcome || !outcome.sides) return 'Unknown';
  for (const side of outcome.sides) {
    if (side.coin === coin || side.token === coin) {
      return side.side === 0 ? 'YES' : 'NO';
    }
  }
  return 'Unknown';
}

function findOutcomeForPosition(coin) {
  return getOutcomeByCoin(coin)
    || getOutcomeByCoin(String(coin).replace('@', '#'))
    || getOutcomeByCoin(String(coin).replace('+', '#'))
    || getOutcomeByCoin(String(coin).replace('#', '@'))
    || getOutcomeByCoin(String(coin).replace('#', '+'));
}

function toSellCoin(coin, outcome) {
  if (String(coin).startsWith('#')) return coin;
  if (!outcome?.sides) return coin;
  const match = outcome.sides.find((side) => side.coin === coin || side.token === coin);
  return match?.coin || coin;
}

export function createPositionsFeature(deps) {
  const { hlClient } = deps;

  async function showPositions(ctx) {
    const config = await loadConfig();

    if (!config.walletAddress) {
      await ctx.editMessageText('Wallet not configured yet. Create or import a wallet first.', {
        reply_markup: new InlineKeyboard().text('Back', 'back_menu'),
      });
      return;
    }

    await ctx.editMessageText('Loading positions...');

    const chatId = ctx.chat.id;
    busyLocks.set(chatId, true);

    try {
      const balances = await hlClient.getUserBalances(config.walletAddress);
      const allBalances = Array.isArray(balances?.balances) ? balances.balances : [];

      const outcomePositions = allBalances.filter((b) => {
        if (!isOutcomeToken(b.coin)) return false;
        const total = parseFloat(b.total || '0');
        return total > 0.0001;
      });

      if (outcomePositions.length === 0) {
        await ctx.editMessageText('No outcome positions found.', {
          reply_markup: new InlineKeyboard()
            .text('Refresh', 'positions:refresh')
            .text('Back', 'back_menu'),
        });
        return;
      }

      let mids = {};
      try {
        mids = await hlClient.getAllMids();
      } catch {
        mids = {};
      }

      let text = 'Your Positions\n\n';
      const keyboard = new InlineKeyboard();

      for (let i = 0; i < outcomePositions.length; i++) {
        const pos = outcomePositions[i];
        const rawCoin = pos.coin;
        const total = parseFloat(pos.total || '0');
        const outcome = findOutcomeForPosition(rawCoin);
        const sellCoin = toSellCoin(rawCoin, outcome);
        const question = outcome?.question || outcome?.description || sellCoin;
        const side = resolveSide(rawCoin, outcome);

        const midPriceRaw = mids[sellCoin] ?? mids[rawCoin];
        const midPrice = midPriceRaw != null ? parseFloat(midPriceRaw) : null;
        const priceStr = midPrice !== null ? midPrice.toFixed(4) : 'N/A';
        const valueStr = midPrice !== null ? (total * midPrice).toFixed(2) : 'N/A';

        text += `${i + 1}. ${question}\n`;
        text += `   ${side} | Shares: ${total.toFixed(4)} | Price: ${priceStr}\n`;
        text += `   Value: $${valueStr}\n\n`;

        const safeCoin = encodeURIComponent(sellCoin);
        keyboard.text(`Sell #${i + 1}`, `pos:sell:${safeCoin}`);
        if ((i + 1) % 2 === 0) keyboard.row();
      }

      keyboard.row();
      keyboard.text('Refresh', 'positions:refresh');
      keyboard.text('Back', 'back_menu');

      await ctx.editMessageText(text, { reply_markup: keyboard });
    } catch (error) {
      const logCtx = createContext('bot', 'showPositions');
      safeLogError(logCtx, error);
      await ctx.editMessageText('Could not load positions right now. Please try again.', {
        reply_markup: new InlineKeyboard()
          .text('Try Again', 'positions:refresh')
          .text('Back', 'back_menu'),
      });
    } finally {
      busyLocks.delete(chatId);
    }
  }

  return {
    showPositions,
  };
}
