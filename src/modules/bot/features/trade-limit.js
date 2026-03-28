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

async function getT() {
  const config = await loadConfig();
  return await getTranslator(config.language || 'en');
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

function normalizeHlError(error, t) {
  const raw = String(error?.message || error || '').trim();
  if (!raw) return t ? t('hl_something_wrong') : 'Something went wrong while talking to HyperLiquid.';

  const lowered = raw.toLowerCase();
  if (lowered.includes('minimum') || lowered.includes('$10') || lowered.includes('10 usdc')) {
    return t ? t('hl_min_10') : 'HyperLiquid requires at least $10 notional.';
  }
  if (lowered.includes('insufficient')) {
    return t ? t('hl_insufficient') : 'Insufficient balance for this order.';
  }
  if (lowered.includes('80% away from the reference price') || lowered.includes('reference price')) {
    return t ? t('hl_limit_ref_price') : 'Price is too far from HyperLiquid reference price. Move it closer to the current market.';
  }
  if (lowered.includes('nonce')) {
    return t ? t('hl_nonce') : 'The trading session is out of sync. Please try again.';
  }

  return raw.replace(/^error:\s*/i, '').replace(/^exchange error:\s*/i, '');
}

// ─── Quick-amount keyboards ─────────────────────────────────────

/** Percentage buttons for limit BUY (USDC amounts) */
function limitBuyAmountKeyboard(outcomeId, usdcBalance, t) {
  const kb = new InlineKeyboard();
  if (usdcBalance > 0) {
    const pcts = [25, 50, 75];
    for (const p of pcts) {
      const amt = Math.floor(usdcBalance * p / 100 * 100) / 100;
      if (amt >= 10) {
        kb.text(`${p}% ($${amt})`, `lim_buy_pct:${p}`);
      }
    }
    const maxAmt = Math.floor(usdcBalance * 100) / 100;
    if (maxAmt >= 10) {
      kb.text(`${t ? t('max') : 'Max'} ($${maxAmt})`, 'lim_buy_pct:100');
    }
    kb.row();
  }
  kb.text(t ? t('cancel') : 'Cancel', `outcome:${outcomeId}`);
  return kb;
}

/** Percentage buttons for limit SELL (shares amounts) */
function limitSellAmountKeyboard(outcomeId, sharesBalance, t) {
  const kb = new InlineKeyboard();
  if (sharesBalance > 0) {
    const pcts = [25, 50, 75];
    for (const p of pcts) {
      const amt = Math.floor(sharesBalance * p / 100 * 1000) / 1000;
      if (amt > 0) {
        kb.text(`${p}%`, `lim_sell_pct:${p}`);
      }
    }
    kb.text(t ? t('max') : 'Max', 'lim_sell_pct:100');
    kb.row();
  }
  kb.text(t ? t('cancel') : 'Cancel', `outcome:${outcomeId}`);
  return kb;
}

// ─── Feature factory ────────────────────────────────────────────

export function createTradeLimitFeature(_deps) {
  /**
   * Handle the initial limit trade callback from outcome-details.
   * Callback format: limit:{outcomeId}:{side}:{action}
   */
  async function handleLimitCallback(ctx, outcomeId, sideStr, action) {
    const chatId = ctx.chat.id;
    const t = await getT();
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

    const refDisplay = midPrice != null ? formatPrice(midPrice) : t('na');
    const actionLabel = isBuy ? t('market_buy') : t('market_sell');

    const promptText =
      `${isBuy ? t('limit_buy') : t('limit_sell')} ${sideLabel}\n` +
      `${t('current_mid')}: ${refDisplay}\n\n` +
      t('enter_limit_price');

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
      .text(t('cancel'), `outcome:${outcomeId}`);

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
    const t = await getT();
    const price = parseNumber(text);

    if (!price || price <= 0 || price >= 1) {
      await ctx.reply(t('invalid_limit_price'), {
        reply_markup: new InlineKeyboard().text(t('cancel'), `outcome:${state.outcomeId}`),
      });
      return;
    }

    const priceDisplay = formatPrice(price);
    let usdcBalance = 0;
    let sharesBalance = 0;

    try {
      const client = await getHLClient();
      if (state.isBuy) {
        const spotBal = await client.getSpotUsdcBalance();
        const perpBal = await client.getPerpBalance();
        usdcBalance = spotBal + perpBal;
      } else {
        const address = client.getAddress();
        const data = await client.getUserBalances(address);
        const balances = data?.balances || [];
        const coin = state.coin;
        const spotName = coin.replace('#', '@');
        const tokenName = coin.replace('#', '+');
        const entry = balances.find(b =>
          b.coin === coin || b.coin === spotName || b.coin === tokenName
        );
        sharesBalance = entry ? parseFloat(entry.total || '0') : 0;
      }
    } catch {}

    userStates.set(chatId, {
      ...state,
      state: 'AWAITING_LIMIT_SIZE',
      limitPrice: price,
      usdcBalance,
      sharesBalance,
    });

    let promptText;
    let keyboard;

    if (state.isBuy) {
      const balText = usdcBalance > 0 ? `\n${t('available')}: $${usdcBalance.toFixed(2)} USDC` : '';
      promptText =
        `${t('limit_buy')} ${state.sideLabel}\n` +
        `${t('price')}: ${priceDisplay}${balText}\n\n` +
        t('enter_usdc_amount_limit');
      keyboard = limitBuyAmountKeyboard(state.outcomeId, usdcBalance, t);
    } else {
      const sharesText = sharesBalance > 0 ? `\n${t('your_shares')}: ${sharesBalance.toFixed(4)}` : '';
      promptText =
        `${t('limit_sell')} ${state.sideLabel}\n` +
        `${t('price')}: ${priceDisplay}${sharesText}\n\n` +
        t('enter_shares_to_sell_limit');
      keyboard = limitSellAmountKeyboard(state.outcomeId, sharesBalance, t);
    }

    await ctx.reply(promptText, { reply_markup: keyboard });
  }

  /**
   * Handle size input for limit order -> show confirmation.
   * For BUY: input is USDC amount, convert to shares.
   * For SELL: input is shares directly.
   */
  async function handleLimitSize(ctx, state, text) {
    const chatId = ctx.chat.id;
    const t = await getT();
    const inputAmount = parseNumber(text);

    if (!inputAmount) {
      const hint = state.isBuy
        ? t('invalid_usdc_amount_limit')
        : t('invalid_shares_limit');
      await ctx.reply(hint, {
        reply_markup: new InlineKeyboard().text(t('cancel'), `outcome:${state.outcomeId}`),
      });
      return;
    }

    let size;
    let usdcAmount;

    if (state.isBuy) {
      // Input is USDC, calculate shares
      usdcAmount = inputAmount;
      size = usdcAmount / state.limitPrice;
      if (usdcAmount < 10) {
        await ctx.reply(t('min_order_10'), {
          reply_markup: new InlineKeyboard().text(t('cancel'), `outcome:${state.outcomeId}`),
        });
        return;
      }
    } else {
      // Input is shares
      size = inputAmount;
      usdcAmount = size * state.limitPrice;
    }

    const actionLabel = state.isBuy ? 'BUY' : 'SELL';

    let confirmText;
    if (state.isBuy) {
      confirmText =
        `${t('confirm_limit', { action: actionLabel })}\n\n` +
        `${t('side')}: ${state.sideLabel}\n` +
        `${t('price')}: ${formatPrice(state.limitPrice)}\n` +
        `${t('spend')}: ${formatUSDC(usdcAmount)}\n` +
        `${t('est_shares')}: ${size.toFixed(4)}\n` +
        `${t('order_type')}: ${t('limit_gtc')}\n\n` +
        t('proceed');
    } else {
      confirmText =
        `${t('confirm_limit', { action: actionLabel })}\n\n` +
        `${t('side')}: ${state.sideLabel}\n` +
        `${t('price')}: ${formatPrice(state.limitPrice)}\n` +
        `${t('shares')}: ${size.toFixed(4)}\n` +
        `${t('est_proceeds')}: ${formatUSDC(usdcAmount)}\n` +
        `${t('order_type')}: ${t('limit_gtc')}\n\n` +
        t('proceed');
    }

    const keyboard = new InlineKeyboard()
      .text(t('confirm'), 'confirm_limit_order')
      .text(t('cancel'), `outcome:${state.outcomeId}`);

    userStates.set(chatId, {
      ...state,
      state: 'CONFIRMING_LIMIT_ORDER',
      size,
      usdcAmount,
    });

    await ctx.reply(confirmText, { reply_markup: keyboard });
  }

  /**
   * Execute the confirmed limit order.
   */
  async function executeConfirmedLimit(ctx) {
    const chatId = ctx.chat.id;
    const state = userStates.get(chatId);
    const t = await getT();

    if (!state || state.state !== 'CONFIRMING_LIMIT_ORDER') {
      try { await ctx.editMessageText(t('session_expired'), { reply_markup: mainMenuKeyboard() }); } catch {}
      userStates.delete(chatId);
      return;
    }

    busyLocks.set(chatId, true);
    try {
      const client = await getHLClient();

      // Auto-fund for limit buys (sells don't need perp funding)
      if (state.isBuy) {
        try { await ctx.editMessageText(t('checking_funding')); } catch {}
        const requiredUsdc = state.limitPrice * state.size * 1.1;
        const funded = await client.ensureOutcomeFunding(requiredUsdc);
        if (!funded) {
          await ctx.editMessageText(t('insufficient_funds_deposit'), { reply_markup: mainMenuKeyboard() });
          userStates.delete(chatId);
          busyLocks.delete(chatId);
          return;
        }
      }

      try { await ctx.editMessageText(t('placing_limit_order')); } catch {}

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
          `${t('limit_order_placed')}\n\n` +
          `${t('side')}: ${state.sideLabel}\n` +
          `${state.isBuy ? 'BUY' : 'SELL'} ${state.size} @ ${formatPrice(state.limitPrice)}\n` +
          `OID: ${resting.resting.oid}`;
      } else if (filled) {
        resultText =
          `${t('limit_order_filled')}\n\n` +
          `${t('side')}: ${state.sideLabel}\n` +
          `${t('filled')}: ${filled.filled.totalSz} ${t('shares').toLowerCase()}\n` +
          `${t('avg_price')}: ${formatPrice(filled.filled.avgPx)}\n` +
          `OID: ${filled.filled.oid}`;
      } else {
        resultText = t('order_submitted_raw', { response: JSON.stringify(result?.response?.data?.statuses || result?.status || 'unknown') });
      }

      await ctx.editMessageText(resultText, { reply_markup: mainMenuKeyboard() });
    } catch (error) {
      const errMsg = normalizeHlError(error, t);
      await ctx.editMessageText(t('order_failed_with_msg', { error: errMsg }), { reply_markup: mainMenuKeyboard() });
    } finally {
      userStates.delete(chatId);
      busyLocks.delete(chatId);
    }
  }

  /**
   * Handle buy percentage callback (lim_buy_pct:25/50/75/100).
   */
  async function handleBuyPctCallback(ctx, pct) {
    const chatId = ctx.chat.id;
    const state = userStates.get(chatId);
    if (!state || state.state !== 'AWAITING_LIMIT_SIZE' || !state.isBuy) return;

    const usdcAmount = pct === 100
      ? Math.floor(state.usdcBalance * 100) / 100
      : Math.floor(state.usdcBalance * pct / 100 * 100) / 100;

    if (usdcAmount < 10) {
      const t = await getT();
      await ctx.answerCallbackQuery(t('insufficient_usdc_min'));
      return;
    }
    await ctx.answerCallbackQuery();

    // Feed into the same confirmation flow
    await handleLimitSize(ctx, state, String(usdcAmount));
  }

  /**
   * Handle sell percentage callback (lim_sell_pct:25/50/75/100).
   */
  async function handleSellPctCallback(ctx, pct) {
    const chatId = ctx.chat.id;
    const state = userStates.get(chatId);
    if (!state || state.state !== 'AWAITING_LIMIT_SIZE' || state.isBuy) return;

    const shares = pct === 100
      ? state.sharesBalance
      : Math.floor(state.sharesBalance * pct / 100 * 1000) / 1000;

    if (shares <= 0) {
      const t = await getT();
      await ctx.answerCallbackQuery(t('no_shares_to_sell'));
      return;
    }
    await ctx.answerCallbackQuery();

    await handleLimitSize(ctx, state, String(shares));
  }

  return {
    handleLimitCallback,
    handleLimitPrice,
    handleLimitSize,
    handleBuyPctCallback,
    handleSellPctCallback,
    executeConfirmedLimit,
  };
}
