/**
 * Limit Buy/Sell for HIP-4 Outcomes
 *
 * Handles the flow:
 *   outcome-details -> limit:{outcomeId}:{side}:{action} callback
 *   -> ask for price
 *   -> ask for size (shares)
 *   -> show confirmation
 *   -> execute via HLClient.placeOrder() with GTC
 */

import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { toCoin, SIDES } from '../../hl-encoding.js';
import { HLClient } from '../../hyperliquid.js';
import { getDecryptedPrivateKey } from '../../auth.js';
import { userStates, busyLocks } from '../runtime.js';
import { mainMenuKeyboard } from '../ui/keyboards.js';
import { formatPrice, formatUSDC } from '../ui/formatters.js';

// ─── Helpers ─────────────────────────────────────────────────────

async function getHLClient() {
  const config = await loadConfig();
  const pk = await getDecryptedPrivateKey();
  if (!pk) throw new Error('Wallet not configured');
  return await HLClient.create(pk, config.network || 'testnet');
}

function parseSide(sideStr) {
  const s = (sideStr || '').toLowerCase();
  if (s === 'yes') return SIDES.YES;
  if (s === 'no') return SIDES.NO;
  return null;
}

function parseNumber(text) {
  const normalized = String(text || '').trim().replace(',', '.');
  const num = Number(normalized);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

function normalizeHlError(error) {
  const raw = String(error?.message || error || '').trim();
  if (!raw) return 'Something went wrong while talking to HyperLiquid.';

  const lowered = raw.toLowerCase();
  if (lowered.includes('minimum') || lowered.includes('$10') || lowered.includes('10 usdc')) {
    return 'HyperLiquid requires at least $10 notional.';
  }
  if (lowered.includes('insufficient')) {
    return 'Insufficient balance for this order.';
  }
  if (lowered.includes('80% away from the reference price') || lowered.includes('reference price')) {
    return 'Price is too far from HyperLiquid reference price. Move it closer to the current market.';
  }
  if (lowered.includes('nonce')) {
    return 'The trading session is out of sync. Please try again.';
  }

  return raw.replace(/^error:\s*/i, '').replace(/^exchange error:\s*/i, '');
}

// ─── Feature factory ────────────────────────────────────────────

export function createTradeLimitFeature(_deps) {
  /**
   * Handle the initial limit trade callback from outcome-details.
   * Callback format: limit:{outcomeId}:{side}:{action}
   */
  async function handleLimitCallback(ctx, outcomeId, sideStr, action) {
    const chatId = ctx.chat.id;
    const side = parseSide(sideStr);

    if (side === null || !['buy', 'sell'].includes(action)) {
      await ctx.answerCallbackQuery('Invalid parameters');
      return;
    }

    const coin = toCoin(outcomeId, side);
    const sideLabel = side === SIDES.YES ? 'YES' : 'NO';
    const isBuy = action === 'buy';

    // Get current price for reference
    let midPrice = null;
    try {
      const client = await getHLClient();
      const book = await client.getOrderbook(coin);
      const [bids, asks] = book?.levels || [[], []];
      const bestAsk = asks?.[0]?.px ? Number(asks[0].px) : null;
      const bestBid = bids?.[0]?.px ? Number(bids[0].px) : null;
      midPrice = bestAsk && bestBid ? (bestAsk + bestBid) / 2 : bestAsk || bestBid;
    } catch {
      // price unavailable
    }

    const refDisplay = midPrice != null ? formatPrice(midPrice) : 'N/A';
    const actionLabel = isBuy ? 'BUY' : 'SELL';

    const promptText =
      `Limit ${actionLabel} ${sideLabel}\n` +
      `Current mid: ${refDisplay}\n\n` +
      `Enter your limit price (0-1):`;

    userStates.set(chatId, {
      state: 'AWAITING_LIMIT_PRICE',
      outcomeId,
      side,
      sideLabel,
      coin,
      action,
      isBuy,
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
   * Handle price input for limit order.
   */
  async function handleLimitPrice(ctx, state, text) {
    const chatId = ctx.chat.id;
    const price = parseNumber(text);

    if (!price || price <= 0 || price >= 1) {
      await ctx.reply('Invalid price. Enter a value between 0 and 1 (e.g. 0.65).', {
        reply_markup: new InlineKeyboard().text('Cancel', `outcome:${state.outcomeId}`),
      });
      return;
    }

    userStates.set(chatId, {
      ...state,
      state: 'AWAITING_LIMIT_SIZE',
      limitPrice: price,
    });

    const priceDisplay = formatPrice(price);
    const promptText =
      `Limit ${state.isBuy ? 'BUY' : 'SELL'} ${state.sideLabel}\n` +
      `Price: ${priceDisplay}\n\n` +
      `Enter the number of shares:`;

    await ctx.reply(promptText, {
      reply_markup: new InlineKeyboard().text('Cancel', `outcome:${state.outcomeId}`),
    });
  }

  /**
   * Handle size input for limit order -> show confirmation.
   */
  async function handleLimitSize(ctx, state, text) {
    const chatId = ctx.chat.id;
    const size = parseNumber(text);

    if (!size) {
      await ctx.reply('Invalid size. Enter a positive number.', {
        reply_markup: new InlineKeyboard().text('Cancel', `outcome:${state.outcomeId}`),
      });
      return;
    }

    const cost = state.limitPrice * size;
    const actionLabel = state.isBuy ? 'BUY' : 'SELL';

    const confirmText =
      `Confirm Limit ${actionLabel}\n\n` +
      `Side: ${state.sideLabel}\n` +
      `Price: ${formatPrice(state.limitPrice)}\n` +
      `Size: ${size} shares\n` +
      `Est. cost: ${formatUSDC(cost)}\n` +
      `Order type: Limit (GTC)\n\n` +
      `Proceed?`;

    const keyboard = new InlineKeyboard()
      .text('Confirm', 'confirm_limit_order')
      .text('Cancel', `outcome:${state.outcomeId}`);

    userStates.set(chatId, {
      ...state,
      state: 'CONFIRMING_LIMIT_ORDER',
      size,
    });

    await ctx.reply(confirmText, { reply_markup: keyboard });
  }

  /**
   * Execute the confirmed limit order.
   */
  async function executeConfirmedLimit(ctx) {
    const chatId = ctx.chat.id;
    const state = userStates.get(chatId);

    if (!state || state.state !== 'CONFIRMING_LIMIT_ORDER') {
      try { await ctx.editMessageText('Session expired. Please start again.', { reply_markup: mainMenuKeyboard() }); } catch {}
      userStates.delete(chatId);
      return;
    }

    busyLocks.set(chatId, true);
    try {
      const client = await getHLClient();

      // Auto-fund for limit buys (sells don't need perp funding)
      if (state.isBuy) {
        try { await ctx.editMessageText('Checking funding...'); } catch {}
        const requiredUsdc = state.limitPrice * state.size * 1.1;
        const funded = await client.ensureOutcomeFunding(requiredUsdc);
        if (!funded) {
          await ctx.editMessageText('Insufficient funds. Please deposit USDC first.', { reply_markup: mainMenuKeyboard() });
          userStates.delete(chatId);
          busyLocks.delete(chatId);
          return;
        }
      }

      try { await ctx.editMessageText('Placing limit order...'); } catch {}

      const result = await client.placeOrder(
        state.coin,
        state.isBuy,
        state.limitPrice,
        state.size,
        'Limit',
      );

      const statuses = result?.response?.data?.statuses || [];
      const resting = statuses.find(s => s.resting);
      const filled = statuses.find(s => s.filled);

      let resultText;
      if (resting) {
        resultText =
          `Limit order placed!\n\n` +
          `Side: ${state.sideLabel}\n` +
          `${state.isBuy ? 'BUY' : 'SELL'} ${state.size} @ ${formatPrice(state.limitPrice)}\n` +
          `OID: ${resting.resting.oid}`;
      } else if (filled) {
        resultText =
          `Limit order filled immediately!\n\n` +
          `Side: ${state.sideLabel}\n` +
          `Filled: ${filled.filled.totalSz} shares\n` +
          `Avg price: ${formatPrice(filled.filled.avgPx)}\n` +
          `OID: ${filled.filled.oid}`;
      } else {
        resultText = `Order submitted.\n\nResponse: ${JSON.stringify(result?.response?.data?.statuses || result?.status || 'unknown')}`;
      }

      await ctx.editMessageText(resultText, { reply_markup: mainMenuKeyboard() });
    } catch (error) {
      const errMsg = normalizeHlError(error);
      await ctx.editMessageText(`Order failed: ${errMsg}`, { reply_markup: mainMenuKeyboard() });
    } finally {
      userStates.delete(chatId);
      busyLocks.delete(chatId);
    }
  }

  return {
    handleLimitCallback,
    handleLimitPrice,
    handleLimitSize,
    executeConfirmedLimit,
  };
}
