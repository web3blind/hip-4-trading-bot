/**
 * Market Buy/Sell for HIP-4 Outcomes
 *
 * Handles the flow:
 *   outcome-details -> trade:{outcomeId}:{side}:{action} callback
 *   -> ask for amount (USDC for buy, shares for sell)
 *   -> show confirmation with price + estimated fills
 *   -> execute via HLClient.placeOrder() with IOC (market)
 */

import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { toCoin, SIDES } from '../../hl-encoding.js';
import { HLClient } from '../../hyperliquid.js';
import { getDecryptedPrivateKey } from '../../auth.js';
import { userStates, busyLocks } from '../runtime.js';
import { mainMenuKeyboard, backKeyboard } from '../ui/keyboards.js';
import { formatPrice, formatUSDC } from '../ui/formatters.js';
import { getOutcomeById } from '../../database.js';

// ─── Helpers ─────────────────────────────────────────────────────

async function getHLClient() {
  const config = await loadConfig();
  const pk = await getDecryptedPrivateKey();
  if (!pk) throw new Error('Wallet not configured');
  return HLClient.create(pk, config.network || 'testnet');
}

function parseSide(sideStr) {
  const s = (sideStr || '').toLowerCase();
  if (s === 'yes') return SIDES.YES;
  if (s === 'no') return SIDES.NO;
  return null;
}

function parseAmount(text) {
  const normalized = String(text || '').trim().replace(',', '.');
  const num = Number(normalized);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

// ─── Feature factory ────────────────────────────────────────────

export function createTradeMarketFeature(_deps) {
  /**
   * Handle the initial trade callback from outcome-details.
   * Callback format: trade:{outcomeId}:{side}:{action}
   */
  async function handleTradeCallback(ctx, outcomeId, sideStr, action) {
    const config = await loadConfig();
    const lang = config.language || 'en';
    const t = await getTranslator(lang);
    const chatId = ctx.chat.id;
    const side = parseSide(sideStr);

    if (side === null || !['buy', 'sell'].includes(action)) {
      await ctx.answerCallbackQuery('Invalid trade parameters');
      return;
    }

    const coin = toCoin(outcomeId, side);
    const sideLabel = side === SIDES.YES ? 'YES' : 'NO';

    // Fetch current price for display
    let midPrice = null;
    let bestAsk = null;
    let bestBid = null;
    try {
      const client = await getHLClient();
      const book = await client.getOrderbook(coin);
      const [bids, asks] = book?.levels || [[], []];
      if (asks?.[0]?.px) bestAsk = Number(asks[0].px);
      if (bids?.[0]?.px) bestBid = Number(bids[0].px);
      midPrice = bestAsk && bestBid ? (bestAsk + bestBid) / 2 : bestAsk || bestBid;
    } catch {
      // price unavailable
    }

    const priceDisplay = midPrice != null ? formatPrice(midPrice) : 'N/A';
    const isBuy = action === 'buy';

    let promptText;
    if (isBuy) {
      promptText =
        `Market BUY ${sideLabel}\n` +
        `Current price: ${priceDisplay}\n\n` +
        `Enter the number of shares to buy:`;
    } else {
      promptText =
        `Market SELL ${sideLabel}\n` +
        `Current price: ${priceDisplay}\n\n` +
        `Enter the number of shares to sell:`;
    }

    userStates.set(chatId, {
      state: isBuy ? 'AWAITING_MARKET_BUY_AMOUNT' : 'AWAITING_MARKET_SELL_AMOUNT',
      outcomeId,
      side,
      sideLabel,
      coin,
      action,
      bestAsk,
      bestBid,
      midPrice,
    });

    const keyboard = new InlineKeyboard()
      .text('Cancel', `outcome:${outcomeId}`);

    try {
      await ctx.editMessageText(promptText, { reply_markup: keyboard });
    } catch {
      await ctx.reply(promptText, { reply_markup: keyboard });
    }
  }

  /**
   * Handle the amount input for market buy.
   */
  async function handleMarketBuyAmount(ctx, state, text) {
    const chatId = ctx.chat.id;
    const amount = parseAmount(text);

    if (!amount) {
      await ctx.reply('Invalid amount. Please enter a positive number.', {
        reply_markup: new InlineKeyboard().text('Cancel', `outcome:${state.outcomeId}`),
      });
      return;
    }

    // Show confirmation
    const priceDisplay = state.bestAsk != null ? formatPrice(state.bestAsk) : (state.midPrice != null ? formatPrice(state.midPrice) : 'N/A');

    const confirmText =
      `Confirm Market BUY\n\n` +
      `Side: ${state.sideLabel}\n` +
      `Shares: ${amount}\n` +
      `Est. price: ${priceDisplay}\n` +
      `Order type: Market (IOC)\n\n` +
      `Proceed?`;

    const keyboard = new InlineKeyboard()
      .text('Confirm', 'confirm_market_buy')
      .text('Cancel', `outcome:${state.outcomeId}`);

    userStates.set(chatId, {
      ...state,
      state: 'CONFIRMING_MARKET_BUY',
      amount,
    });

    await ctx.reply(confirmText, { reply_markup: keyboard });
  }

  /**
   * Handle the amount input for market sell.
   */
  async function handleMarketSellAmount(ctx, state, text) {
    const chatId = ctx.chat.id;
    const amount = parseAmount(text);

    if (!amount) {
      await ctx.reply('Invalid amount. Please enter a positive number.', {
        reply_markup: new InlineKeyboard().text('Cancel', `outcome:${state.outcomeId}`),
      });
      return;
    }

    const priceDisplay = state.bestBid != null ? formatPrice(state.bestBid) : (state.midPrice != null ? formatPrice(state.midPrice) : 'N/A');

    const confirmText =
      `Confirm Market SELL\n\n` +
      `Side: ${state.sideLabel}\n` +
      `Shares: ${amount}\n` +
      `Est. price: ${priceDisplay}\n` +
      `Order type: Market (IOC)\n\n` +
      `Proceed?`;

    const keyboard = new InlineKeyboard()
      .text('Confirm', 'confirm_market_sell')
      .text('Cancel', `outcome:${state.outcomeId}`);

    userStates.set(chatId, {
      ...state,
      state: 'CONFIRMING_MARKET_SELL',
      amount,
    });

    await ctx.reply(confirmText, { reply_markup: keyboard });
  }

  /**
   * Execute a confirmed market buy.
   */
  async function executeConfirmedMarketBuy(ctx) {
    const chatId = ctx.chat.id;
    const state = userStates.get(chatId);

    if (!state || state.state !== 'CONFIRMING_MARKET_BUY') {
      try { await ctx.editMessageText('Session expired. Please start again.', { reply_markup: mainMenuKeyboard() }); } catch {}
      userStates.delete(chatId);
      return;
    }

    busyLocks.set(chatId, true);
    try {
      await ctx.editMessageText('Placing market buy order...');

      const client = await getHLClient();
      const result = await client.placeMarketOrder(state.coin, true, state.amount);

      const statuses = result?.response?.data?.statuses || [];
      const filled = statuses.find(s => s.filled);
      const resting = statuses.find(s => s.resting);

      let resultText;
      if (filled) {
        resultText =
          `Market BUY executed!\n\n` +
          `Side: ${state.sideLabel}\n` +
          `Filled: ${filled.filled.totalSz} shares\n` +
          `Avg price: ${formatPrice(filled.filled.avgPx)}\n` +
          `OID: ${filled.filled.oid}`;
      } else if (resting) {
        resultText =
          `Order placed (resting on book)\n\n` +
          `Side: ${state.sideLabel}\n` +
          `OID: ${resting.resting.oid}`;
      } else {
        resultText = `Order submitted.\n\nResponse: ${JSON.stringify(result?.response?.data?.statuses || result?.status || 'unknown')}`;
      }

      await ctx.editMessageText(resultText, { reply_markup: mainMenuKeyboard() });
    } catch (error) {
      const errMsg = error?.message || 'Unknown error';
      await ctx.editMessageText(`Order failed: ${errMsg}`, { reply_markup: mainMenuKeyboard() });
    } finally {
      userStates.delete(chatId);
      busyLocks.delete(chatId);
    }
  }

  /**
   * Execute a confirmed market sell.
   */
  async function executeConfirmedMarketSell(ctx) {
    const chatId = ctx.chat.id;
    const state = userStates.get(chatId);

    if (!state || state.state !== 'CONFIRMING_MARKET_SELL') {
      try { await ctx.editMessageText('Session expired. Please start again.', { reply_markup: mainMenuKeyboard() }); } catch {}
      userStates.delete(chatId);
      return;
    }

    busyLocks.set(chatId, true);
    try {
      await ctx.editMessageText('Placing market sell order...');

      const client = await getHLClient();
      const result = await client.placeMarketOrder(state.coin, false, state.amount);

      const statuses = result?.response?.data?.statuses || [];
      const filled = statuses.find(s => s.filled);
      const resting = statuses.find(s => s.resting);

      let resultText;
      if (filled) {
        resultText =
          `Market SELL executed!\n\n` +
          `Side: ${state.sideLabel}\n` +
          `Filled: ${filled.filled.totalSz} shares\n` +
          `Avg price: ${formatPrice(filled.filled.avgPx)}\n` +
          `OID: ${filled.filled.oid}`;
      } else if (resting) {
        resultText =
          `Order placed (resting on book)\n\n` +
          `Side: ${state.sideLabel}\n` +
          `OID: ${resting.resting.oid}`;
      } else {
        resultText = `Order submitted.\n\nResponse: ${JSON.stringify(result?.response?.data?.statuses || result?.status || 'unknown')}`;
      }

      await ctx.editMessageText(resultText, { reply_markup: mainMenuKeyboard() });
    } catch (error) {
      const errMsg = error?.message || 'Unknown error';
      await ctx.editMessageText(`Order failed: ${errMsg}`, { reply_markup: mainMenuKeyboard() });
    } finally {
      userStates.delete(chatId);
      busyLocks.delete(chatId);
    }
  }

  return {
    handleTradeCallback,
    handleMarketBuyAmount,
    handleMarketSellAmount,
    executeConfirmedMarketBuy,
    executeConfirmedMarketSell,
  };
}
