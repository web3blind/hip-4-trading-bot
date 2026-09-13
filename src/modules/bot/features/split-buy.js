/**
 * Split Buy (Arbitrage) feature for HIP-4 Telegram bot.
 *
 * In HIP-4 prediction markets, YES + NO always = 1.00 at settlement.
 * If you can buy both YES and NO for less than 1.00 total, you lock in
 * guaranteed profit at settlement.
 *
 * Flow:
 *  1. User taps "Split Buy" button on outcome detail screen
 *  2. Bot shows arb details, asks for USDC amount
 *  3. User enters amount or taps percentage
 *  4. Confirmation screen
 *  5. Execute: place two limit orders (YES buy + NO buy) sequentially
 */

import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { toCoin, SIDES } from '../../hl-encoding.js';
import { orderStatuses } from '../../hyperliquid.js';
import { userStates, busyLocks, confirmationCallback, hlClient as runtimeHLClient } from '../runtime.js';
import { mainMenuKeyboard } from '../ui/keyboards.js';
import { getOutcomeById } from '../../database.js';

// ─── Helpers ─────────────────────────────────────────────────────

async function getHLClient() {
  if (!runtimeHLClient) throw new Error('Wallet not configured');
  return runtimeHLClient;
}

async function getT() {
  const config = await loadConfig();
  return await getTranslator(config.language || 'en');
}

async function replaceOrReply(ctx, text, extra = {}) {
  try {
    await ctx.editMessageText(text, extra);
  } catch {
    await ctx.reply(text, extra);
  }
}

/** Get total available USDC (spot + perp) */
async function getUsdcBalance(client) {
  try {
    return await client.getAvailableUsdc();
  } catch {
    return 0;
  }
}

/**
 * Fetch arb data from both orderbooks for a given outcomeId.
 * Returns null if no arb exists.
 */
async function fetchArbData(hlClient, outcomeId) {
  const coin0 = toCoin(outcomeId, SIDES.YES);
  const coin1 = toCoin(outcomeId, SIDES.NO);

  const book0 = await hlClient.getOrderbook(coin0);
  const book1 = await hlClient.getOrderbook(coin1);

  const asks0 = book0?.levels?.[1] || [];
  const asks1 = book1?.levels?.[1] || [];

  if (asks0.length === 0 || asks1.length === 0) return null;

  const askYes = Number(asks0[0].px);
  const askNo = Number(asks1[0].px);
  const szYes = Number(asks0[0].sz);
  const szNo = Number(asks1[0].sz);
  const totalCost = askYes + askNo;

  if (![askYes, askNo, szYes, szNo].every(n => Number.isFinite(n) && n > 0) || totalCost >= 0.999 || szYes < 10 || szNo < 10) return null;

  return {
    askYes,
    askNo,
    szYes,
    szNo,
    totalCost,
    profitPct: ((1.0 - totalCost) / totalCost * 100),
    maxPairs: Math.min(szYes, szNo),
  };
}

// ─── Feature factory ──────────────────────────────────────────────

export function createSplitBuyFeature(_deps) {

  /**
   * Step 1: Show arb details and ask for amount.
   */
  async function handleSplitStart(ctx, outcomeId) {
    const chatId = ctx.chat.id;
    const t = await getT();

    const client = await getHLClient();
    if (!client) {
      await replaceOrReply(ctx, t('error_no_wallet'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu'),
      });
      return;
    }

    try {
      await replaceOrReply(ctx, t('loading'));

      // Re-fetch arb data (may have changed since outcome detail was shown)
      const arb = await fetchArbData(client, outcomeId);

      if (!arb) {
        await replaceOrReply(ctx, t('split_no_arb'), {
          reply_markup: new InlineKeyboard().text(t('back'), `outcome:${outcomeId}`),
        });
        return;
      }

      // Get outcome name
      const outcome = getOutcomeById(outcomeId);
      const outcomeName = outcome?.question || outcome?.name || `Outcome #${outcomeId}`;

      // Get USDC balance
      const usdcBalance = await getUsdcBalance(client);

      // Determine which side limits
      const limitedBy = arb.szYes <= arb.szNo ? 'YES' : 'NO';

      const text =
        `${t('split_buy_title')}\n\n` +
        `${outcomeName}\n` +
        `${t('split_yes_ask')}: $${arb.askYes.toFixed(4)} (${(arb.askYes * 100).toFixed(1)}%) — ${Math.floor(arb.szYes)} ${t('available').toLowerCase()}\n` +
        `${t('split_no_ask')}: $${arb.askNo.toFixed(4)} (${(arb.askNo * 100).toFixed(1)}%) — ${Math.floor(arb.szNo)} ${t('available').toLowerCase()}\n` +
        `${t('split_total_cost')}: $${arb.totalCost.toFixed(4)}\n` +
        `${t('split_guaranteed_profit')}: ${arb.profitPct.toFixed(2)}%\n\n` +
        `${t('split_max_pairs')}: ${Math.floor(arb.maxPairs)} (${t('split_limited_by', { side: limitedBy })})\n` +
        `${t('available')}: $${usdcBalance.toFixed(2)} USDC\n\n` +
        `${t('split_enter_amount')}:`;

      // Build amount keyboard
      const kb = new InlineKeyboard();
      if (usdcBalance > 0) {
        const pcts = [25, 50, 75];
        for (const p of pcts) {
          const amt = Math.floor(usdcBalance * p / 100 * 100) / 100;
          if (amt >= 0.01) {
            kb.text(`${p}%`, `split_pct:${p}`);
          }
        }
        kb.text(t('max') || 'Max', 'split_pct:100');
        kb.row();
      }
      kb.text(t('cancel') || 'Cancel', `outcome:${outcomeId}`);

      // Save state
      userStates.set(chatId, {
        state: 'AWAITING_SPLIT_AMOUNT',
        outcomeId,
        outcomeName,
        arb,
        usdcBalance,
      });

      await replaceOrReply(ctx, text, { reply_markup: kb });
    } catch (err) {
      process.stderr.write(`[split-buy] handleSplitStart error: ${err.message}\n`);
      await replaceOrReply(ctx, t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('back'), `outcome:${outcomeId}`),
      });
    }
  }

  /**
   * Handle percentage button click.
   */
  async function handleSplitPct(ctx, pct) {
    const chatId = ctx.chat.id;
    const t = await getT();
    const state = userStates.get(chatId);

    if (!state || state.state !== 'AWAITING_SPLIT_AMOUNT') {
      await replaceOrReply(ctx, t('session_expired'), {
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }

    // Refresh balance
    let usdcBalance;
    try {
      const client = await getHLClient();
      usdcBalance = await getUsdcBalance(client);
    } catch {
      usdcBalance = state.usdcBalance || 0;
    }

    const usdcAmount = Math.floor(usdcBalance * pct / 100 * 100) / 100;
    if (usdcAmount < 0.01) {
      await ctx.answerCallbackQuery('Insufficient USDC balance');
      return;
    }

    await showSplitConfirmation(ctx, state, usdcAmount);
  }

  /**
   * Handle manual amount entry.
   */
  async function handleSplitAmount(ctx, state, text) {
    const t = await getT();
    const normalized = String(text || '').trim().replace(',', '.');
    const usdcAmount = Number(normalized);

    if (!Number.isFinite(usdcAmount) || usdcAmount <= 0) {
      await ctx.reply(t('error_invalid_amount'), {
        reply_markup: new InlineKeyboard().text(t('cancel'), `outcome:${state.outcomeId}`),
      });
      return;
    }

    if (usdcAmount > state.usdcBalance) {
      await ctx.reply(t('insufficient_balance', { balance: state.usdcBalance.toFixed(2) }), {
        reply_markup: new InlineKeyboard().text(t('cancel'), `outcome:${state.outcomeId}`),
      });
      return;
    }

    await showSplitConfirmation(ctx, state, usdcAmount);
  }

  /**
   * Show confirmation screen with calculated pair details.
   */
  async function showSplitConfirmation(ctx, state, usdcAmount) {
    const t = await getT();
    const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
    const { arb, outcomeId, outcomeName } = state;

    const pairs = Math.floor(usdcAmount / (arb.totalCost * 1.01));
    if (pairs < 1) {
      await replaceOrReply(ctx, t('error_invalid_amount') + `\n\n${t('split_total_cost')}: $${arb.totalCost.toFixed(4)} — need at least $${arb.totalCost.toFixed(2)}`, {
        reply_markup: new InlineKeyboard().text(t('back'), `outcome:${outcomeId}`),
      });
      return;
    }

    // Cap by available liquidity
    const effectivePairs = Math.min(pairs, Math.floor(arb.maxPairs));
    const client = await getHLClient();
    const reviewed = await Promise.all([
      client.prepareOrder({ coin: toCoin(outcomeId, 0), isBuy: true, price: arb.askYes, size: effectivePairs }),
      client.prepareOrder({ coin: toCoin(outcomeId, 1), isBuy: true, price: arb.askNo, size: effectivePairs }),
    ]);
    const totalCost = reviewed.reduce((sum, r) => sum + r.maxSpend, 0);
    if (totalCost > usdcAmount) throw new Error('Reviewed budget exceeded');
    const settlementValue = effectivePairs * 1.0;
    const orderNotional = reviewed.reduce((sum, order) => sum + order.price * order.size, 0);
    const profit = settlementValue - orderNotional;
    const profitPct = profit / orderNotional * 100;

    const text =
      `${t('split_confirm_title')}\n\n` +
      `${outcomeName}\n\n` +
      `${t('split_buy_yes')}: ${reviewed[0].size} shares @ $${reviewed[0].price}\n` +
      `${t('split_buy_no')}: ${reviewed[1].size} shares @ $${reviewed[1].price}\n` +
      `${t('split_review_total')}: $${totalCost.toFixed(2)}\n` +
      `${t('split_settlement_value')}: $${settlementValue.toFixed(2)}\n` +
      `${t('split_guaranteed_profit')}: $${profit.toFixed(2)} (${profitPct.toFixed(2)}%)\n\n` +
      t('split_nonatomic_risk') + '\n\n' + t('proceed');

    const callback = confirmationCallback(chatId, 'confirm_split_buy', {
      ...state, state: 'CONFIRMING_SPLIT_BUY', pairs: effectivePairs,
      totalCost, settlementValue, profit, reviewed,
    });
    const kb = new InlineKeyboard().text(t('confirm'), callback)
      .text(t('cancel'), `outcome:${outcomeId}`);

    await replaceOrReply(ctx, text, { reply_markup: kb });
  }

  /**
   * Execute the split buy: place two limit orders sequentially.
   */
  async function executeSplitBuy(ctx) {
    const chatId = ctx.chat.id;
    const t = await getT();
    const state = userStates.get(chatId);

    if (!state || state.state !== 'CONFIRMING_SPLIT_BUY') {
      await replaceOrReply(ctx, t('session_expired'), {
        reply_markup: mainMenuKeyboard(),
      });
      userStates.delete(chatId);
      return;
    }

    if (busyLocks.get(chatId)) return;
    busyLocks.set(chatId, true);

    try {
      const client = await getHLClient();
      const { outcomeId, reviewed } = state;
      if (!Array.isArray(reviewed) || reviewed.length !== 2) throw new Error('Missing reviewed orders');
      if (!await client.ensureOutcomeFunding(state.totalCost, reviewed[0].coin)) throw new Error(t('insufficient_funds_deposit'));
      const result = await client.placeOrders(reviewed, { throwOnError: false });
      const statuses = orderStatuses(result, 2);
      const complete = statuses.every((s, i) => s.filled && Number(s.filled.totalSz) === reviewed[i].size);
      const lines = statuses.map((s, i) => {
        const label = i === 0 ? 'YES' : 'NO';
        if (s.error) return `${label}: ${t('order_rejected', { error: s.error })}`;
        if (s.resting) return `${label}: ${t('limit_gtc')} OID: ${s.resting.oid}`;
        return `${label}: ${t('filled')} ${s.filled.totalSz} @ ${s.filled.avgPx}; OID: ${s.filled.oid}`;
      });
      await replaceOrReply(ctx, `${t(complete ? 'split_executed' : 'split_partial')}\n\n${lines.join('\n')}`, {
        reply_markup: new InlineKeyboard().text(t('back'), `outcome:${outcomeId}`).text(t('view_orders'), 'orders:refresh'),
      });
    } catch (err) {
      process.stderr.write(`[split-buy] executeSplitBuy error: ${err.message}\n`);
      await replaceOrReply(ctx, `${t('error_generic')}\n\n${err.message}`, {
        reply_markup: mainMenuKeyboard(),
      });
    } finally {
      userStates.delete(chatId);
      busyLocks.delete(chatId);
    }
  }

  /**
   * Cancel the split buy flow.
   */
  async function cancelSplitBuy(ctx, outcomeId) {
    const chatId = ctx.chat.id;
    userStates.delete(chatId);
    busyLocks.delete(chatId);
  }

  return {
    handleSplitStart,
    handleSplitPct,
    handleSplitAmount,
    executeSplitBuy,
    cancelSplitBuy,
  };
}
