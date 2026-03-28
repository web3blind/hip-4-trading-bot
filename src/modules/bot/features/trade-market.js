/**
 * Market Buy/Sell for HIP-4 Outcomes
 *
 * BUY:  user enters amount in USDC → bot calculates shares at current ask
 * SELL: user enters shares (or % of balance) → bot sells at current bid
 *
 * Both flows have quick-select buttons: 25% / 50% / 75% / Max
 */

import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { toCoin, SIDES } from '../../hl-encoding.js';
import { HLClient } from '../../hyperliquid.js';
import { getDecryptedPrivateKey } from '../../auth.js';
import { userStates, busyLocks, hlClient as runtimeHLClient } from '../runtime.js';
import { mainMenuKeyboard } from '../ui/keyboards.js';
import { formatPrice } from '../ui/formatters.js';

// ─── Helpers ─────────────────────────────────────────────────────

async function getHLClient() {
  if (runtimeHLClient) return runtimeHLClient;
  const config = await loadConfig();
  const pk = await getDecryptedPrivateKey();
  if (!pk) throw new Error('Wallet not configured');
  return await HLClient.create(pk, config.hlNetwork || 'testnet');
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
  if (lowered.includes('minimum') || lowered.includes('$10')) {
    return t ? t('hl_min_10') : 'HyperLiquid requires at least $10 notional.';
  }
  if (lowered.includes('insufficient')) {
    return t ? t('hl_insufficient') : 'Insufficient balance for this order.';
  }
  if (lowered.includes('80%') || lowered.includes('reference price')) {
    return t ? t('hl_reference_price') : 'This market has a stale reference price on HyperLiquid testnet.\nTrading is temporarily unavailable for this side.\nTry a different market or the other side.';
  }
  if (lowered.includes('slippage')) {
    return t ? t('hl_slippage') : 'Price moved too far. Try a smaller size or use a limit order.';
  }
  if (lowered.includes('not found in spot universe')) {
    return t ? t('hl_not_in_universe') : 'This market is not available for trading yet (not in spot universe).';
  }
  if (lowered.includes('nonce')) {
    return t ? t('hl_nonce') : 'The trading session is out of sync. Please try again.';
  }

  return raw.replace(/^error:\s*/i, '').replace(/^exchange error:\s*/i, '');
}

async function replaceOrReply(ctx, text, extra = {}) {
  try {
    await ctx.editMessageText(text, extra);
  } catch {
    await ctx.reply(text, extra);
  }
}

/** Get total available USDC (spot + perp) since auto-funding bridges both */
async function getUsdcBalance(client, address) {
  try {
    const spotBal = await client.getSpotUsdcBalance();
    const perpBal = await client.getPerpBalance();
    return spotBal + perpBal;
  } catch {
    return 0;
  }
}

/** Get shares balance for a specific outcome coin */
async function getSharesBalance(client, address, coin) {
  try {
    const data = await client.getUserBalances(address);
    const balances = data?.balances || [];
    const spotName = coin.replace('#', '@');
    const tokenName = coin.replace('#', '+');
    const entry = balances.find(b =>
      b.coin === coin || b.coin === spotName || b.coin === tokenName
    );
    return entry ? parseFloat(entry.total || entry.available || '0') : 0;
  } catch {
    return 0;
  }
}

/** Build quick-amount keyboard for BUY (USDC amounts) */
function buyAmountKeyboard(outcomeId, usdcBalance, sideStr, t) {
  const kb = new InlineKeyboard();
  if (usdcBalance > 0) {
    const pcts = [25, 50, 75];
    for (const p of pcts) {
      const amt = Math.floor(usdcBalance * p / 100 * 100) / 100;
      if (amt >= 0.01) {
        kb.text(`${p}% ($${amt})`, `mkt_buy_pct:${p}`);
      }
    }
    const maxAmt = Math.floor(usdcBalance * 100) / 100;
    if (maxAmt >= 0.01) {
      kb.text(`${t ? t('max') : 'Max'} ($${maxAmt})`, 'mkt_buy_pct:100');
    }
    kb.row();
  }
  kb.text(t ? t('back') : 'Back', `outcome:${outcomeId}`)
    .text(t ? t('cancel') : 'Cancel', `trade_cancel:${outcomeId}:${sideStr}:buy`);
  return kb;
}

/** Build quick-amount keyboard for SELL (shares amounts) */
function sellAmountKeyboard(outcomeId, sharesBalance, sideStr, t) {
  const kb = new InlineKeyboard();
  if (sharesBalance > 0) {
    const pcts = [25, 50, 75];
    for (const p of pcts) {
      const amt = Math.floor(sharesBalance * p / 100 * 1000) / 1000;
      if (amt > 0) {
        kb.text(`${p}%`, `mkt_sell_pct:${p}`);
      }
    }
    kb.text(t ? t('max') : 'Max', 'mkt_sell_pct:100');
    kb.row();
  }
  kb.text(t ? t('back') : 'Back', `positions:refresh`)
    .text(t ? t('cancel') : 'Cancel', `trade_cancel:${outcomeId}:${sideStr}:sell`);
  return kb;
}

export function createTradeMarketFeature(_deps) {
  async function handleTradeCallback(ctx, outcomeId, sideStr, action) {
    const chatId = ctx.chat.id;
    const t = await getT();
    const side = parseSide(sideStr);

    if (side === null || !['buy', 'sell'].includes(action) || !Number.isFinite(Number(outcomeId))) {
      await ctx.answerCallbackQuery('Invalid trade request');
      return;
    }

    const coin = toCoin(outcomeId, side);
    const sideLabel = side === SIDES.YES ? 'YES' : 'NO';
    const isBuy = action === 'buy';

    let bestAsk = null;
    let bestBid = null;
    let midPrice = null;
    let usdcBalance = 0;
    let sharesBalance = 0;

    try {
      const client = await getHLClient();
      const book = await client.getOrderbook(coin);
      const [bids, asks] = book?.levels || [[], []];
      if (asks?.[0]?.px) bestAsk = Number(asks[0].px);
      if (bids?.[0]?.px) bestBid = Number(bids[0].px);
      midPrice = bestAsk && bestBid ? (bestAsk + bestBid) / 2 : bestAsk || bestBid;

      const address = client.getAddress();
      if (isBuy) {
        usdcBalance = await getUsdcBalance(client, address);
      } else {
        sharesBalance = await getSharesBalance(client, address, coin);
      }
    } catch {
      // continue with whatever data we have
    }

    const priceDisplay = midPrice != null ? formatPrice(midPrice) : t('na');

    if (isBuy && bestAsk == null) {
      const text = `${t('market_buy')} ${sideLabel}\n\n${t('no_asks_available')}`;
      const kb = new InlineKeyboard()
        .text(t('limit_order_btn'), `limit:${outcomeId}:${sideStr}:buy`)
        .row()
        .text(t('back'), `outcome:${outcomeId}`);
      await replaceOrReply(ctx, text, { reply_markup: kb });
      return;
    }

    if (!isBuy && bestBid == null) {
      const text = `${t('market_sell')} ${sideLabel}\n\n${t('no_bids_available')}`;
      const kb = new InlineKeyboard()
        .text(t('limit_order_btn'), `limit:${outcomeId}:${sideStr}:sell`)
        .row()
        .text(t('back'), `outcome:${outcomeId}`);
      await replaceOrReply(ctx, text, { reply_markup: kb });
      return;
    }

    const stateData = {
      state: isBuy ? 'AWAITING_MARKET_BUY_AMOUNT' : 'AWAITING_MARKET_SELL_AMOUNT',
      outcomeId,
      side,
      sideLabel,
      sideStr,
      coin,
      action,
      bestAsk,
      bestBid,
      midPrice,
      usdcBalance,
      sharesBalance,
    };
    userStates.set(chatId, stateData);

    let promptText;
    let keyboard;

    if (isBuy) {
      const balText = usdcBalance > 0 ? `$${usdcBalance.toFixed(2)}` : '$0.00';
      promptText =
        `${t('market_buy')} ${sideLabel}\n` +
        `${t('price')}: ${priceDisplay}\n` +
        `${t('available')}: ${balText} USDC\n\n` +
        t('enter_usdc_to_spend');
      keyboard = buyAmountKeyboard(outcomeId, usdcBalance, sideStr, t);
    } else {
      const sharesText = sharesBalance > 0 ? sharesBalance.toFixed(4) : '0';
      promptText =
        `${t('market_sell')} ${sideLabel}\n` +
        `${t('price')}: ${priceDisplay}\n` +
        `${t('your_shares')}: ${sharesText}\n\n` +
        t('enter_shares_to_sell');
      keyboard = sellAmountKeyboard(outcomeId, sharesBalance, sideStr, t);
    }

    await replaceOrReply(ctx, promptText, { reply_markup: keyboard });
  }

  async function handleBuyPctCallback(ctx, pct) {
    const chatId = ctx.chat.id;
    const state = userStates.get(chatId);
    if (!state || state.state !== 'AWAITING_MARKET_BUY_AMOUNT') return;

    const usdcAmount = Math.floor(state.usdcBalance * pct / 100 * 100) / 100;
    if (usdcAmount < 0.01) {
      await ctx.answerCallbackQuery('Insufficient USDC balance');
      return;
    }
    await ctx.answerCallbackQuery();
    await showBuyConfirmation(ctx, state, usdcAmount);
  }

  async function handleSellPctCallback(ctx, pct) {
    const chatId = ctx.chat.id;
    const state = userStates.get(chatId);
    if (!state || state.state !== 'AWAITING_MARKET_SELL_AMOUNT') return;

    const shares = pct === 100
      ? state.sharesBalance
      : Math.floor(state.sharesBalance * pct / 100 * 1000) / 1000;
    if (shares <= 0) {
      await ctx.answerCallbackQuery('No shares to sell');
      return;
    }
    await ctx.answerCallbackQuery();
    await showSellConfirmation(ctx, state, shares);
  }

  async function handleMarketBuyAmount(ctx, state, text) {
    const t = await getT();
    const usdcAmount = parseNumber(text);
    if (!usdcAmount) {
      await ctx.reply(t('invalid_usdc_amount'), {
        reply_markup: buyAmountKeyboard(state.outcomeId, state.usdcBalance, state.sideStr, t),
      });
      return;
    }
    if (usdcAmount < 10) {
      await ctx.reply(t('min_order_10'), {
        reply_markup: buyAmountKeyboard(state.outcomeId, state.usdcBalance, state.sideStr, t),
      });
      return;
    }
    if (state.usdcBalance > 0 && usdcAmount > state.usdcBalance) {
      await ctx.reply(t('insufficient_balance', { balance: state.usdcBalance.toFixed(2) }), {
        reply_markup: buyAmountKeyboard(state.outcomeId, state.usdcBalance, state.sideStr, t),
      });
      return;
    }
    await showBuyConfirmation(ctx, state, usdcAmount);
  }

  async function handleMarketSellAmount(ctx, state, text) {
    const t = await getT();
    const shares = parseNumber(text);
    if (!shares) {
      await ctx.reply(t('invalid_shares_amount'), {
        reply_markup: sellAmountKeyboard(state.outcomeId, state.sharesBalance, state.sideStr, t),
      });
      return;
    }
    if (state.sharesBalance > 0 && shares > state.sharesBalance * 1.001) {
      await ctx.reply(t('insufficient_shares', { shares: state.sharesBalance.toFixed(4) }), {
        reply_markup: sellAmountKeyboard(state.outcomeId, state.sharesBalance, state.sideStr, t),
      });
      return;
    }
    await showSellConfirmation(ctx, state, shares);
  }

  async function showBuyConfirmation(ctx, state, usdcAmount) {
    const t = await getT();
    const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
    const price = state.bestAsk || state.midPrice || 0;
    const estimatedShares = price > 0 ? (usdcAmount / price) : 0;

    const confirmText =
      `${t('confirm_market_buy')}\n\n` +
      `${t('side')}: ${state.sideLabel}\n` +
      `${t('spend')}: $${usdcAmount.toFixed(2)} USDC\n` +
      `${t('est_price')}: ${price > 0 ? formatPrice(price) : t('na')}\n` +
      `${t('est_shares')}: ${estimatedShares.toFixed(4)}\n` +
      `${t('order_type')}: ${t('market_ioc')}\n\n` +
      t('proceed');

    const keyboard = new InlineKeyboard()
      .text(t('confirm'), 'confirm_market_buy')
      .text(t('edit_amount'), `trade:${state.outcomeId}:${state.sideStr}:buy`)
      .row()
      .text(t('cancel'), `outcome:${state.outcomeId}`);

    userStates.set(chatId, {
      ...state,
      state: 'CONFIRMING_MARKET_BUY',
      usdcAmount,
      amount: estimatedShares,
    });

    await replaceOrReply(ctx, confirmText, { reply_markup: keyboard });
  }

  async function showSellConfirmation(ctx, state, shares) {
    const t = await getT();
    const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
    const price = state.bestBid || state.midPrice || 0;
    const estimatedUsdc = price > 0 ? shares * price : 0;

    const confirmText =
      `${t('confirm_market_sell')}\n\n` +
      `${t('side')}: ${state.sideLabel}\n` +
      `${t('shares')}: ${shares.toFixed(4)}\n` +
      `${t('est_price')}: ${price > 0 ? formatPrice(price) : t('na')}\n` +
      `${t('est_proceeds')}: ~$${estimatedUsdc.toFixed(2)} USDC\n` +
      `${t('order_type')}: ${t('market_ioc')}\n\n` +
      t('proceed');

    const keyboard = new InlineKeyboard()
      .text(t('confirm'), 'confirm_market_sell')
      .text(t('edit_shares'), `trade:${state.outcomeId}:${state.sideStr}:sell`)
      .row()
      .text(t('cancel'), `positions:refresh`);

    userStates.set(chatId, {
      ...state,
      state: 'CONFIRMING_MARKET_SELL',
      amount: shares,
    });

    await replaceOrReply(ctx, confirmText, { reply_markup: keyboard });
  }

  async function executeConfirmedMarketBuy(ctx) {
    const chatId = ctx.chat.id;
    const state = userStates.get(chatId);
    const t = await getT();

    if (!state || state.state !== 'CONFIRMING_MARKET_BUY') {
      await replaceOrReply(ctx, t('session_expired'), { reply_markup: mainMenuKeyboard() });
      userStates.delete(chatId);
      return;
    }

    busyLocks.set(chatId, true);
    try {
      await replaceOrReply(ctx, t('checking_funding'));

      const client = await getHLClient();

      // Auto-fund: ensure perp account has enough USDC for this buy
      const requiredUsdc = (state.usdcAmount || (state.amount * (state.bestAsk || state.midPrice || 1))) * 1.1;
      const funded = await client.ensureOutcomeFunding(requiredUsdc);
      if (!funded) {
        await replaceOrReply(ctx, t('insufficient_funds_deposit'), { reply_markup: mainMenuKeyboard() });
        userStates.delete(chatId);
        busyLocks.delete(chatId);
        return;
      }

      await replaceOrReply(ctx, t('placing_market_buy'));

      const result = await client.placeMarketOrder(state.coin, true, state.amount);

      const statuses = result?.response?.data?.statuses || [];
      const filled = statuses.find(s => s.filled);
      const resting = statuses.find(s => s.resting);
      const errStatus = statuses.find(s => s.error);

      let resultText;
      if (filled) {
        resultText =
          `${t('market_buy_executed')}\n\n` +
          `${t('side')}: ${state.sideLabel}\n` +
          `${t('spent')}: $${state.usdcAmount.toFixed(2)} USDC\n` +
          `${t('filled')}: ${filled.filled.totalSz} ${t('shares').toLowerCase()}\n` +
          `${t('avg_price')}: ${formatPrice(filled.filled.avgPx)}`;
      } else if (resting) {
        resultText = t('order_resting', { oid: resting.resting.oid });
      } else if (errStatus) {
        resultText = t('order_rejected', { error: normalizeHlError(errStatus.error, t) });
      } else {
        resultText = t('order_submitted');
      }

      await replaceOrReply(ctx, resultText, { reply_markup: mainMenuKeyboard() });
    } catch (error) {
      await replaceOrReply(ctx, t('order_failed_short', { error: normalizeHlError(error, t) }), { reply_markup: mainMenuKeyboard() });
    } finally {
      userStates.delete(chatId);
      busyLocks.delete(chatId);
    }
  }

  async function executeConfirmedMarketSell(ctx) {
    const chatId = ctx.chat.id;
    const state = userStates.get(chatId);
    const t = await getT();

    if (!state || state.state !== 'CONFIRMING_MARKET_SELL') {
      await replaceOrReply(ctx, t('session_expired'), { reply_markup: mainMenuKeyboard() });
      userStates.delete(chatId);
      return;
    }

    busyLocks.set(chatId, true);
    try {
      await replaceOrReply(ctx, t('placing_market_sell'));

      const client = await getHLClient();
      const result = await client.placeMarketOrder(state.coin, false, state.amount);

      const statuses = result?.response?.data?.statuses || [];
      const filled = statuses.find(s => s.filled);
      const resting = statuses.find(s => s.resting);
      const errStatus = statuses.find(s => s.error);

      let resultText;
      if (filled) {
        resultText =
          `${t('market_sell_executed')}\n\n` +
          `${t('side')}: ${state.sideLabel}\n` +
          `${t('sold')}: ${filled.filled.totalSz} ${t('shares').toLowerCase()}\n` +
          `${t('avg_price')}: ${formatPrice(filled.filled.avgPx)}\n` +
          `${t('proceeds')}: ~$${(Number(filled.filled.totalSz) * Number(filled.filled.avgPx)).toFixed(2)} USDC`;
      } else if (resting) {
        resultText = t('order_resting', { oid: resting.resting.oid });
      } else if (errStatus) {
        resultText = t('order_rejected', { error: normalizeHlError(errStatus.error, t) });
      } else {
        resultText = t('order_submitted');
      }

      await replaceOrReply(ctx, resultText, { reply_markup: mainMenuKeyboard() });
    } catch (error) {
      await replaceOrReply(ctx, t('order_failed_short', { error: normalizeHlError(error, t) }), { reply_markup: mainMenuKeyboard() });
    } finally {
      userStates.delete(chatId);
      busyLocks.delete(chatId);
    }
  }

  async function cancelTradeFlow(ctx, outcomeId, sideStr, action) {
    const chatId = ctx.chat.id;
    const t = await getT();
    userStates.delete(chatId);

    if (action === 'sell') {
      await replaceOrReply(ctx, t('sell_cancelled'), {
        reply_markup: new InlineKeyboard()
          .text(t('back_to_positions'), 'positions:refresh')
          .text(t('back_to_market'), `outcome:${outcomeId}`),
      });
      return;
    }

    await replaceOrReply(ctx, t('trade_cancelled'), {
      reply_markup: new InlineKeyboard()
        .text(t('back_to_market'), `outcome:${outcomeId}`)
        .row()
        .text(t('main_menu_btn'), 'back_menu'),
    });
  }

  return {
    handleTradeCallback,
    handleBuyPctCallback,
    handleSellPctCallback,
    handleMarketBuyAmount,
    handleMarketSellAmount,
    executeConfirmedMarketBuy,
    executeConfirmedMarketSell,
    cancelTradeFlow,
  };
}
