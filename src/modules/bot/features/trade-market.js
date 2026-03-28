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
  if (lowered.includes('minimum') || lowered.includes('$10')) {
    return 'HyperLiquid requires at least $10 notional.';
  }
  if (lowered.includes('insufficient')) {
    return 'Insufficient balance for this order.';
  }
  if (lowered.includes('80%') || lowered.includes('reference price')) {
    return 'This market has a stale reference price on HyperLiquid testnet.\nTrading is temporarily unavailable for this side.\nTry a different market or the other side.';
  }
  if (lowered.includes('slippage')) {
    return 'Price moved too far. Try a smaller size or use a limit order.';
  }
  if (lowered.includes('not found in spot universe')) {
    return 'This market is not available for trading yet (not in spot universe).';
  }
  if (lowered.includes('nonce')) {
    return 'The trading session is out of sync. Please try again.';
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
function buyAmountKeyboard(outcomeId, usdcBalance, sideStr) {
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
      kb.text(`Max ($${maxAmt})`, 'mkt_buy_pct:100');
    }
    kb.row();
  }
  kb.text('Back', `outcome:${outcomeId}`)
    .text('Cancel', `trade_cancel:${outcomeId}:${sideStr}:buy`);
  return kb;
}

/** Build quick-amount keyboard for SELL (shares amounts) */
function sellAmountKeyboard(outcomeId, sharesBalance, sideStr) {
  const kb = new InlineKeyboard();
  if (sharesBalance > 0) {
    const pcts = [25, 50, 75];
    for (const p of pcts) {
      const amt = Math.floor(sharesBalance * p / 100 * 1000) / 1000;
      if (amt > 0) {
        kb.text(`${p}%`, `mkt_sell_pct:${p}`);
      }
    }
    kb.text('Max', 'mkt_sell_pct:100');
    kb.row();
  }
  kb.text('Back', `positions:refresh`)
    .text('Cancel', `trade_cancel:${outcomeId}:${sideStr}:sell`);
  return kb;
}

export function createTradeMarketFeature(_deps) {
  async function handleTradeCallback(ctx, outcomeId, sideStr, action) {
    const chatId = ctx.chat.id;
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

    const priceDisplay = midPrice != null ? formatPrice(midPrice) : 'N/A';

    if (isBuy && bestAsk == null) {
      const text = `Market BUY ${sideLabel}\n\nNo asks are available right now, so a market buy cannot be placed.\nTry a limit order instead.`;
      const kb = new InlineKeyboard()
        .text('Limit order', `limit:${outcomeId}:${sideStr}:buy`)
        .row()
        .text('Back', `outcome:${outcomeId}`);
      await replaceOrReply(ctx, text, { reply_markup: kb });
      return;
    }

    if (!isBuy && bestBid == null) {
      const text = `Market SELL ${sideLabel}\n\nNo bids are available right now, so a market sell cannot be placed.\nTry a limit order instead.`;
      const kb = new InlineKeyboard()
        .text('Limit order', `limit:${outcomeId}:${sideStr}:sell`)
        .row()
        .text('Back', `outcome:${outcomeId}`);
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
        `Market BUY ${sideLabel}\n` +
        `Price: ${priceDisplay}\n` +
        `Available: ${balText} USDC\n\n` +
        `Enter how much USDC to spend:`;
      keyboard = buyAmountKeyboard(outcomeId, usdcBalance, sideStr);
    } else {
      const sharesText = sharesBalance > 0 ? sharesBalance.toFixed(4) : '0';
      promptText =
        `Market SELL ${sideLabel}\n` +
        `Price: ${priceDisplay}\n` +
        `Your shares: ${sharesText}\n\n` +
        `Enter how many shares to sell:`;
      keyboard = sellAmountKeyboard(outcomeId, sharesBalance, sideStr);
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
    const usdcAmount = parseNumber(text);
    if (!usdcAmount) {
      await ctx.reply('Invalid amount. Enter a positive USDC amount, like 25 or 100.50.', {
        reply_markup: buyAmountKeyboard(state.outcomeId, state.usdcBalance, state.sideStr),
      });
      return;
    }
    if (usdcAmount < 10) {
      await ctx.reply('Minimum order value is $10 USDC on HyperLiquid.', {
        reply_markup: buyAmountKeyboard(state.outcomeId, state.usdcBalance, state.sideStr),
      });
      return;
    }
    if (state.usdcBalance > 0 && usdcAmount > state.usdcBalance) {
      await ctx.reply(`Insufficient balance. You have $${state.usdcBalance.toFixed(2)} USDC.`, {
        reply_markup: buyAmountKeyboard(state.outcomeId, state.usdcBalance, state.sideStr),
      });
      return;
    }
    await showBuyConfirmation(ctx, state, usdcAmount);
  }

  async function handleMarketSellAmount(ctx, state, text) {
    const shares = parseNumber(text);
    if (!shares) {
      await ctx.reply('Invalid amount. Enter a positive number of shares, like 10 or 42.5.', {
        reply_markup: sellAmountKeyboard(state.outcomeId, state.sharesBalance, state.sideStr),
      });
      return;
    }
    if (state.sharesBalance > 0 && shares > state.sharesBalance * 1.001) {
      await ctx.reply(`Insufficient shares. You have ${state.sharesBalance.toFixed(4)}.`, {
        reply_markup: sellAmountKeyboard(state.outcomeId, state.sharesBalance, state.sideStr),
      });
      return;
    }
    await showSellConfirmation(ctx, state, shares);
  }

  async function showBuyConfirmation(ctx, state, usdcAmount) {
    const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
    const price = state.bestAsk || state.midPrice || 0;
    const estimatedShares = price > 0 ? (usdcAmount / price) : 0;

    const confirmText =
      `Confirm Market BUY\n\n` +
      `Side: ${state.sideLabel}\n` +
      `Spend: $${usdcAmount.toFixed(2)} USDC\n` +
      `Est. price: ${price > 0 ? formatPrice(price) : 'N/A'}\n` +
      `Est. shares: ${estimatedShares.toFixed(4)}\n` +
      `Order type: Market (IOC)\n\n` +
      `Proceed?`;

    const keyboard = new InlineKeyboard()
      .text('Confirm', 'confirm_market_buy')
      .text('Edit amount', `trade:${state.outcomeId}:${state.sideStr}:buy`)
      .row()
      .text('Cancel', `outcome:${state.outcomeId}`);

    userStates.set(chatId, {
      ...state,
      state: 'CONFIRMING_MARKET_BUY',
      usdcAmount,
      amount: estimatedShares,
    });

    await replaceOrReply(ctx, confirmText, { reply_markup: keyboard });
  }

  async function showSellConfirmation(ctx, state, shares) {
    const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
    const price = state.bestBid || state.midPrice || 0;
    const estimatedUsdc = price > 0 ? shares * price : 0;

    const confirmText =
      `Confirm Market SELL\n\n` +
      `Side: ${state.sideLabel}\n` +
      `Shares: ${shares.toFixed(4)}\n` +
      `Est. price: ${price > 0 ? formatPrice(price) : 'N/A'}\n` +
      `Est. proceeds: ~$${estimatedUsdc.toFixed(2)} USDC\n` +
      `Order type: Market (IOC)\n\n` +
      `Proceed?`;

    const keyboard = new InlineKeyboard()
      .text('Confirm', 'confirm_market_sell')
      .text('Edit shares', `trade:${state.outcomeId}:${state.sideStr}:sell`)
      .row()
      .text('Cancel', `positions:refresh`);

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

    if (!state || state.state !== 'CONFIRMING_MARKET_BUY') {
      await replaceOrReply(ctx, 'Session expired. Please start again.', { reply_markup: mainMenuKeyboard() });
      userStates.delete(chatId);
      return;
    }

    busyLocks.set(chatId, true);
    try {
      await replaceOrReply(ctx, 'Checking funding...');

      const client = await getHLClient();

      // Auto-fund: ensure perp account has enough USDC for this buy
      const requiredUsdc = (state.usdcAmount || (state.amount * (state.bestAsk || state.midPrice || 1))) * 1.1;
      const funded = await client.ensureOutcomeFunding(requiredUsdc);
      if (!funded) {
        await replaceOrReply(ctx, 'Insufficient funds. Please deposit USDC first.', { reply_markup: mainMenuKeyboard() });
        userStates.delete(chatId);
        busyLocks.delete(chatId);
        return;
      }

      await replaceOrReply(ctx, 'Placing market buy order...');

      const result = await client.placeMarketOrder(state.coin, true, state.amount);

      const statuses = result?.response?.data?.statuses || [];
      const filled = statuses.find(s => s.filled);
      const resting = statuses.find(s => s.resting);
      const errStatus = statuses.find(s => s.error);

      let resultText;
      if (filled) {
        resultText =
          `Market BUY executed!\n\n` +
          `Side: ${state.sideLabel}\n` +
          `Spent: $${state.usdcAmount.toFixed(2)} USDC\n` +
          `Filled: ${filled.filled.totalSz} shares\n` +
          `Avg price: ${formatPrice(filled.filled.avgPx)}`;
      } else if (resting) {
        resultText = `Order is resting on the book.\nOID: ${resting.resting.oid}`;
      } else if (errStatus) {
        resultText = `Order rejected.\n${normalizeHlError(errStatus.error)}`;
      } else {
        resultText = 'Order submitted.';
      }

      await replaceOrReply(ctx, resultText, { reply_markup: mainMenuKeyboard() });
    } catch (error) {
      await replaceOrReply(ctx, `Order failed.\n${normalizeHlError(error)}`, { reply_markup: mainMenuKeyboard() });
    } finally {
      userStates.delete(chatId);
      busyLocks.delete(chatId);
    }
  }

  async function executeConfirmedMarketSell(ctx) {
    const chatId = ctx.chat.id;
    const state = userStates.get(chatId);

    if (!state || state.state !== 'CONFIRMING_MARKET_SELL') {
      await replaceOrReply(ctx, 'Session expired. Please start again.', { reply_markup: mainMenuKeyboard() });
      userStates.delete(chatId);
      return;
    }

    busyLocks.set(chatId, true);
    try {
      await replaceOrReply(ctx, 'Placing market sell order...');

      const client = await getHLClient();
      const result = await client.placeMarketOrder(state.coin, false, state.amount);

      const statuses = result?.response?.data?.statuses || [];
      const filled = statuses.find(s => s.filled);
      const resting = statuses.find(s => s.resting);
      const errStatus = statuses.find(s => s.error);

      let resultText;
      if (filled) {
        resultText =
          `Market SELL executed!\n\n` +
          `Side: ${state.sideLabel}\n` +
          `Sold: ${filled.filled.totalSz} shares\n` +
          `Avg price: ${formatPrice(filled.filled.avgPx)}\n` +
          `Proceeds: ~$${(Number(filled.filled.totalSz) * Number(filled.filled.avgPx)).toFixed(2)} USDC`;
      } else if (resting) {
        resultText = `Order is resting on the book.\nOID: ${resting.resting.oid}`;
      } else if (errStatus) {
        resultText = `Order rejected.\n${normalizeHlError(errStatus.error)}`;
      } else {
        resultText = 'Order submitted.';
      }

      await replaceOrReply(ctx, resultText, { reply_markup: mainMenuKeyboard() });
    } catch (error) {
      await replaceOrReply(ctx, `Order failed.\n${normalizeHlError(error)}`, { reply_markup: mainMenuKeyboard() });
    } finally {
      userStates.delete(chatId);
      busyLocks.delete(chatId);
    }
  }

  async function cancelTradeFlow(ctx, outcomeId, sideStr, action) {
    const chatId = ctx.chat.id;
    userStates.delete(chatId);

    if (action === 'sell') {
      await replaceOrReply(ctx, 'Sell cancelled.', {
        reply_markup: new InlineKeyboard()
          .text('Back to positions', 'positions:refresh')
          .text('Back to market', `outcome:${outcomeId}`),
      });
      return;
    }

    await replaceOrReply(ctx, 'Trade cancelled.', {
      reply_markup: new InlineKeyboard()
        .text('Back to market', `outcome:${outcomeId}`)
        .row()
        .text('Main menu', 'back_menu'),
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
