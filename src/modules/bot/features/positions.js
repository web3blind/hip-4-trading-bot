import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getOutcomeByCoin } from '../../database.js';
import { createContext, safeLogError } from '../../logger.js';
import { busyLocks } from '../runtime.js';

/**
 * Check if a coin is an outcome token (HIP-4).
 * Outcome coins start with '#' (e.g. "#21460")
 * and outcome tokens start with '+' (e.g. "+21460").
 */
function isOutcomeToken(coin) {
  if (!coin) return false;
  const c = String(coin).trim();
  return c.startsWith('#') || c.startsWith('+');
}

/**
 * Resolve side label (YES/NO) from balance coin and DB lookup.
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
 * Positions feature for HyperLiquid HIP-4 outcomes.
 *
 * @param {object} deps
 * @param {import('../../hyperliquid.js').HLClient} deps.hlClient
 */
export function createPositionsFeature(deps) {
  const { hlClient } = deps;

  async function showPositions(ctx) {
    const config = await loadConfig();

    if (!config.walletAddress) {
      await ctx.editMessageText('Wallet not configured. Use /setup first.', {
        reply_markup: new InlineKeyboard().text('Back', 'back_menu'),
      });
      return;
    }

    await ctx.editMessageText('Loading positions...');

    const chatId = ctx.chat.id;
    busyLocks.set(chatId, true);

    try {
      // Fetch user spot balances from HL
      const balances = await hlClient.getUserBalances(config.walletAddress);

      // balances is { balances: [{ coin, token, hold, total }] }
      const allBalances = Array.isArray(balances?.balances) ? balances.balances : [];

      // Filter for outcome tokens only, with non-zero balance
      const outcomePositions = allBalances.filter((b) => {
        if (!isOutcomeToken(b.coin)) return false;
        const total = parseFloat(b.total || '0');
        return total > 0.0001; // filter dust
      });

      if (outcomePositions.length === 0) {
        await ctx.editMessageText('No outcome positions found.', {
          reply_markup: new InlineKeyboard()
            .text('Refresh', 'positions:refresh')
            .text('Back', 'back_menu'),
        });
        return;
      }

      // Fetch mid prices for current value
      let mids = {};
      try {
        mids = await hlClient.getAllMids();
      } catch {
        // non-fatal — we'll just skip current price display
      }

      let text = 'Your Positions\n\n';
      const keyboard = new InlineKeyboard();

      for (let i = 0; i < outcomePositions.length; i++) {
        const pos = outcomePositions[i];
        const coin = pos.coin;
        const total = parseFloat(pos.total || '0');

        // Look up outcome details from DB
        const outcome = getOutcomeByCoin(coin);
        const question = outcome?.question || coin;
        const side = resolveSide(coin, outcome);

        // Current mid price
        const midPrice = mids[coin] ? parseFloat(mids[coin]) : null;
        const priceStr = midPrice !== null ? midPrice.toFixed(4) : 'N/A';
        const valueStr = midPrice !== null ? (total * midPrice).toFixed(2) : 'N/A';

        text += `${i + 1}. ${question}\n`;
        text += `   ${side} | Size: ${total.toFixed(2)} | Price: ${priceStr}\n`;
        text += `   Value: $${valueStr}\n\n`;

        // Sell button per position — encode coin in callback
        const safeCoin = encodeURIComponent(coin);
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
      await ctx.editMessageText('Error loading positions. Try again.', {
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
