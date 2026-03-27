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
import { formatPrice, formatUSDC } from '../ui/formatters.js';

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

/** Get USDC balance from spot clearinghouse */
async function getUsdcBalance(client, address) {
  try {
    const data = await client.getUserBalances(address);
    const balances = data?.balances || [];
    const usdc = balances.find(b =>
      b.coin === 'USDC' || b.coin === 'USD' || b.coin === 'USDH'
    );
    return usdc ? parseFloat(usdc.total || usdc.available || '0') : 0;
  } catch {
    return 0;
  }
}

/** Get shares balance for a specific outcome coin */
async function getSharesBalance(client, address, coin) {
  try {
    const data = await client.getUserBalances(address);
    const balances = data?.balances || [];
    // Outcome tokens use the coin format (e.g. @90) or token format (+90)
    const tokenName = coin.replace('#', '@');
    const tokenName2 = coin.replace('#', '+');
    const entry = balances.find(b =>
      b.coin === coin || b.coin === tokenName || b.coin === tokenName2
    );
    return entry ? parseFloat(entry.total || entry.available || '0') : 0;
  } catch {
    return 0;
  }
}

/** Build quick-amount keyboard for BUY (USDC amounts) */
function buyAmountKeyboard(outcomeId, usdcBalance) {
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
      kb.text(`Max ($${maxAmt})`, `mkt_buy_pct:100`);
    }
    kb.row();
  }
  kb.text('Cancel', `outcome:${outcomeId}`);
  return kb;
}

/** Build quick-amount keyboard for SELL (shares amounts) */
function sellAmountKeyboard(outcomeId, sharesBalance) {
  const kb = new InlineKeyboard();
  if (sharesBalance > 0) {
    const pcts = [25, 50, 75];
    for (const p of pcts) {
      const amt = Math.floor(sharesBalance * p / 100 * 1000) / 1000;
      if (amt > 0) {
        kb.text(`${p}%`, `mkt_sell_pct:${p}`);
      }
    }
    kb.text('Max', `mkt_sell_pct:100`);
    kb.row();
  }
  kb.text('Cancel', `outcome:${outcomeId}`);
  return kb;
}

// ─── Feature factory ────────────────────────────────────────────

export function createTradeMarketFeature(_deps) {

  /**
   * Initial trade callback from outcome-details.
   * trade:{outcomeId}:{side}:{action}
   */
  async function handleTradeCallback(ctx, outcomeId, sideStr, action) {
    const config = await loadConfig();
    const chatId = ctx.chat.id;
    const side = parseSide(sideStr);

    if (side === null || !['buy', 'sell'].includes(action)) {
      await ctx.answerCallbackQuery('Invalid trade parameters');
      return;
    }

    const coin = toCoin(outcomeId, side);
    const sideLabel = side === SIDES.YES ? 'YES' : 'NO';
    const isBuy = action === 'buy';

    // Fetch price + balance
    let bestAsk = null, bestBid = null, midPrice = null;
    let usdcBalance = 0, sharesBalance = 0;

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
      // continue with what we have
    }

    const priceDisplay = midPrice != null ? formatPrice(midPrice) : 'N/A';

    // Check if orderbook has liquidity for the requested action
    if (isBuy && bestAsk == null) {
      const text = `Market BUY ${sideLabel}\n\nNo asks in orderbook — cannot place market buy.\nTry a limit order instead.`;
      const kb = new InlineKeyboard()
        .text('Limit order', `limit:${outcomeId}:${sideStr}:buy`)
        .row()
        .text('Back', `outcome:${outcomeId}`);
      try { await ctx.editMessageText(text, { reply_markup: kb }); } catch { await ctx.reply(text, { reply_markup: kb }); }
      return;
    }
    if (!isBuy && bestBid == null) {
      const text = `Market SELL ${sideLabel}\n\nNo bids in orderbook — cannot place market sell.\nTry a limit order instead.`;
      const kb = new InlineKeyboard()
        .text('Limit order', `limit:${outcomeId}:${sideStr}:sell`)
        .row()
        .text('Back', `outcome:${outcomeId}`);
      try { await ctx.editMessageText(text, { reply_markup: kb }); } catch { await ctx.reply(text, { reply_markup: kb }); }
      return;
    }

    // Save state
    const stateData = {
      state: isBuy ? 'AWAITING_MARKET_BUY_AMOUNT' : 'AWAITING_MARKET_SELL_AMOUNT',
      outcomeId, side, sideLabel, coin, action,
      bestAsk, bestBid, midPrice,
      usdcBalance, sharesBalance,
    };
    userStates.set(chatId, stateData);

    let promptText, keyboard;

    if (isBuy) {
      const balText = usdcBalance > 0 ? `$${usdcBalance.toFixed(2)}` : '$0.00';
      promptText =
        `Market BUY ${sideLabel}\n` +
        `Price: ${priceDisplay}\n` +
        `Available: ${balText} USDC\n\n` +
        `Enter amount in USDC:`;
      keyboard = buyAmountKeyboard(outcomeId, usdcBalance);
    } else {
      const sharesText = sharesBalance > 0 ? sharesBalance.toFixed(4) : '0';
      promptText =
        `Market SELL ${sideLabel}\n` +
        `Price: ${priceDisplay}\n` +
        `Your shares: ${sharesText}\n\n` +
        `Enter number of shares to sell:`;
      keyboard = sellAmountKeyboard(outcomeId, sharesBalance);
    }

    try {
      await ctx.editMessageText(promptText, { reply_markup: keyboard });
    } catch {
      await ctx.reply(promptText, { reply_markup: keyboard });
    }
  }

  /**
   * Handle % button click for buy (mkt_buy_pct:XX)
   */
  async function handleBuyPctCallback(ctx, pct) {
    const chatId = ctx.chat.id;
    const state = userStates.get(chatId);
    if (!state || state.state !== 'AWAITING_MARKET_BUY_AMOUNT') return;

    const usdcAmount = Math.floor(state.usdcBalance * pct / 100 * 100) / 100;
    if (usdcAmount < 0.01) {
      await ctx.answerCallbackQuery('Insufficient balance');
      return;
    }
    await ctx.answerCallbackQuery();
    await showBuyConfirmation(ctx, state, usdcAmount);
  }

  /**
   * Handle % button click for sell (mkt_sell_pct:XX)
   */
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

  /**
   * Handle text input for market buy (USDC amount).
   */
  async function handleMarketBuyAmount(ctx, state, text) {
    const usdcAmount = parseNumber(text);
    if (!usdcAmount) {
      await ctx.reply('Invalid amount. Enter a positive number in USDC.', {
        reply_markup: new InlineKeyboard().text('Cancel', `outcome:${state.outcomeId}`),
      });
      return;
    }
    if (state.usdcBalance > 0 && usdcAmount > state.usdcBalance) {
      await ctx.reply(`Insufficient balance. You have $${state.usdcBalance.toFixed(2)} USDC.`, {
        reply_markup: buyAmountKeyboard(state.outcomeId, state.usdcBalance),
      });
      return;
    }
    await showBuyConfirmation(ctx, state, usdcAmount);
  }

  /**
   * Handle text input for market sell (shares).
   */
  async function handleMarketSellAmount(ctx, state, text) {
    const shares = parseNumber(text);
    if (!shares) {
      await ctx.reply('Invalid amount. Enter a positive number of shares.', {
        reply_markup: new InlineKeyboard().text('Cancel', `outcome:${state.outcomeId}`),
      });
      return;
    }
    if (state.sharesBalance > 0 && shares > state.sharesBalance * 1.001) {
      await ctx.reply(`Insufficient shares. You have ${state.sharesBalance.toFixed(4)}.`, {
        reply_markup: sellAmountKeyboard(state.outcomeId, state.sharesBalance),
      });
      return;
    }
    await showSellConfirmation(ctx, state, shares);
  }

  // ─── Confirmations ──────────────────────────────────────────────

  async function showBuyConfirmation(ctx, state, usdcAmount) {
    const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
    const price = state.bestAsk || state.midPrice || 0;
    const estimatedShares = price > 0 ? (usdcAmount / price) : 0;

    const confirmText =
      `Confirm Market BUY\n\n` +
      `Side: ${state.sideLabel}\n` +
      `Amount: $${usdcAmount.toFixed(2)} USDC\n` +
      `Est. price: ${price > 0 ? formatPrice(price) : 'N/A'}\n` +
      `Est. shares: ${estimatedShares.toFixed(4)}\n` +
      `Order type: Market (IOC)\n\n` +
      `Proceed?`;

    const keyboard = new InlineKeyboard()
      .text('Confirm', 'confirm_market_buy')
      .text('Cancel', `outcome:${state.outcomeId}`);

    userStates.set(chatId, {
      ...state,
      state: 'CONFIRMING_MARKET_BUY',
      usdcAmount,
      amount: estimatedShares, // shares to order
    });

    try {
      await ctx.editMessageText(confirmText, { reply_markup: keyboard });
    } catch {
      await ctx.reply(confirmText, { reply_markup: keyboard });
    }
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
      `Est. proceeds: $${estimatedUsdc.toFixed(2)} USDC\n` +
      `Order type: Market (IOC)\n\n` +
      `Proceed?`;

    const keyboard = new InlineKeyboard()
      .text('Confirm', 'confirm_market_sell')
      .text('Cancel', `outcome:${state.outcomeId}`);

    userStates.set(chatId, {
      ...state,
      state: 'CONFIRMING_MARKET_SELL',
      amount: shares,
    });

    try {
      await ctx.editMessageText(confirmText, { reply_markup: keyboard });
    } catch {
      await ctx.reply(confirmText, { reply_markup: keyboard });
    }
  }

  // ─── Execute ──────────────────────────────────────────────────

  async function executeConfirmedMarketBuy(ctx) {
    const chatId = ctx.chat.id;
    const state = userStates.get(chatId);

    if (!state || state.state !== 'CONFIRMING_MARKET_BUY') {
      try { await ctx.editMessageText('Session expired.', { reply_markup: mainMenuKeyboard() }); } catch {}
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
          `Spent: $${state.usdcAmount.toFixed(2)} USDC\n` +
          `Filled: ${filled.filled.totalSz} shares\n` +
          `Avg price: ${formatPrice(filled.filled.avgPx)}`;
      } else if (resting) {
        resultText = `Order resting on book.\nOID: ${resting.resting.oid}`;
      } else {
        resultText = `Order submitted.\n${JSON.stringify(statuses).slice(0, 200)}`;
      }

      await ctx.editMessageText(resultText, { reply_markup: mainMenuKeyboard() });
    } catch (error) {
      await ctx.editMessageText(`Order failed: ${error?.message || 'unknown'}`, { reply_markup: mainMenuKeyboard() });
    } finally {
      userStates.delete(chatId);
      busyLocks.delete(chatId);
    }
  }

  async function executeConfirmedMarketSell(ctx) {
    const chatId = ctx.chat.id;
    const state = userStates.get(chatId);

    if (!state || state.state !== 'CONFIRMING_MARKET_SELL') {
      try { await ctx.editMessageText('Session expired.', { reply_markup: mainMenuKeyboard() }); } catch {}
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
          `Sold: ${filled.filled.totalSz} shares\n` +
          `Avg price: ${formatPrice(filled.filled.avgPx)}\n` +
          `Proceeds: ~$${(Number(filled.filled.totalSz) * Number(filled.filled.avgPx)).toFixed(2)} USDC`;
      } else if (resting) {
        resultText = `Order resting on book.\nOID: ${resting.resting.oid}`;
      } else {
        resultText = `Order submitted.\n${JSON.stringify(statuses).slice(0, 200)}`;
      }

      await ctx.editMessageText(resultText, { reply_markup: mainMenuKeyboard() });
    } catch (error) {
      await ctx.editMessageText(`Order failed: ${error?.message || 'unknown'}`, { reply_markup: mainMenuKeyboard() });
    } finally {
      userStates.delete(chatId);
      busyLocks.delete(chatId);
    }
  }

  return {
    handleTradeCallback,
    handleBuyPctCallback,
    handleSellPctCallback,
    handleMarketBuyAmount,
    handleMarketSellAmount,
    executeConfirmedMarketBuy,
    executeConfirmedMarketSell,
  };
}
