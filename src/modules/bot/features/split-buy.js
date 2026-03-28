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
import { HLClient } from '../../hyperliquid.js';
import { getDecryptedPrivateKey } from '../../auth.js';
import { userStates, busyLocks, hlClient as runtimeHLClient } from '../runtime.js';
import { mainMenuKeyboard } from '../ui/keyboards.js';
import { getOutcomeById } from '../../database.js';

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
    const spotBal = await client.getSpotUsdcBalance();
    const perpBal = await client.getPerpBalance();
    return spotBal + perpBal;
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

  if (totalCost >= 0.999 || szYes < 10 || szNo < 10) return null;

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

    if (state.usdcBalance > 0 && usdcAmount > state.usdcBalance) {
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

    const pairs = Math.floor(usdcAmount / arb.totalCost);
    if (pairs < 1) {
      await replaceOrReply(ctx, t('error_invalid_amount') + `\n\n${t('split_total_cost')}: $${arb.totalCost.toFixed(4)} — need at least $${arb.totalCost.toFixed(2)}`, {
        reply_markup: new InlineKeyboard().text(t('back'), `outcome:${outcomeId}`),
      });
      return;
    }

    // Cap by available liquidity
    const effectivePairs = Math.min(pairs, Math.floor(arb.maxPairs));
    const totalCost = effectivePairs * arb.totalCost;
    const settlementValue = effectivePairs * 1.0;
    const profit = settlementValue - totalCost;

    const text =
      `${t('split_confirm_title')}\n\n` +
      `${outcomeName}\n\n` +
      `${t('split_buy_yes')}: ${effectivePairs} shares @ $${arb.askYes.toFixed(4)}\n` +
      `${t('split_buy_no')}: ${effectivePairs} shares @ $${arb.askNo.toFixed(4)}\n` +
      `${t('split_total_cost')}: $${totalCost.toFixed(2)}\n` +
      `${t('split_settlement_value')}: $${settlementValue.toFixed(2)}\n` +
      `${t('split_guaranteed_profit')}: $${profit.toFixed(2)} (${arb.profitPct.toFixed(2)}%)\n\n` +
      t('proceed');

    const kb = new InlineKeyboard()
      .text(t('confirm'), 'confirm_split_buy')
      .text(t('cancel'), `outcome:${outcomeId}`);

    userStates.set(chatId, {
      ...state,
      state: 'CONFIRMING_SPLIT_BUY',
      pairs: effectivePairs,
      totalCost,
      settlementValue,
      profit,
    });

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

    busyLocks.set(chatId, true);

    try {
      const client = await getHLClient();
      const { outcomeId, arb, pairs } = state;

      // Auto-fund: ensure perp account has enough USDC
      await replaceOrReply(ctx, t('checking_funding'));
      const requiredUsdc = state.totalCost * 1.1;
      const funded = await client.ensureOutcomeFunding(requiredUsdc);
      if (!funded) {
        await replaceOrReply(ctx, t('insufficient_funds_deposit'), {
          reply_markup: mainMenuKeyboard(),
        });
        userStates.delete(chatId);
        busyLocks.delete(chatId);
        return;
      }

      // Re-verify arb still exists
      const freshArb = await fetchArbData(client, outcomeId);
      if (!freshArb || freshArb.totalCost >= 0.999) {
        await replaceOrReply(ctx, t('split_no_arb'), {
          reply_markup: new InlineKeyboard().text(t('back'), `outcome:${outcomeId}`),
        });
        userStates.delete(chatId);
        busyLocks.delete(chatId);
        return;
      }

      // Use the latest prices for execution
      const execAskYes = freshArb.askYes;
      const execAskNo = freshArb.askNo;
      const execPairs = Math.min(pairs, Math.floor(freshArb.maxPairs));

      if (execPairs < 1) {
        await replaceOrReply(ctx, t('split_no_arb'), {
          reply_markup: new InlineKeyboard().text(t('back'), `outcome:${outcomeId}`),
        });
        userStates.delete(chatId);
        busyLocks.delete(chatId);
        return;
      }

      const yesCoin = toCoin(outcomeId, SIDES.YES);
      const noCoin = toCoin(outcomeId, SIDES.NO);

      // Place YES buy order (limit at ask price)
      await replaceOrReply(ctx, `${t('split_buy_title')}\n\n${t('split_buy_yes')}: ${execPairs} @ $${execAskYes.toFixed(4)}...`);

      let yesResult = null;
      let yesFilled = null;
      let yesError = null;

      try {
        yesResult = await client.placeOrder(yesCoin, true, execAskYes, execPairs, 'Limit');
        const yesStatuses = yesResult?.response?.data?.statuses || [];
        yesFilled = yesStatuses.find(s => s.filled);
        const yesResting = yesStatuses.find(s => s.resting);
        const yesErr = yesStatuses.find(s => s.error);

        if (yesErr) {
          yesError = yesErr.error;
        } else if (!yesFilled && yesResting) {
          // Order is resting, not immediately filled — it may fill later but we continue
          yesFilled = { filled: { totalSz: '0', avgPx: String(execAskYes) } };
        }
      } catch (err) {
        yesError = err.message;
      }

      if (yesError) {
        await replaceOrReply(ctx,
          `${t('split_partial')}\n\n` +
          `${t('split_buy_yes')}: FAILED — ${yesError}\n` +
          `${t('split_buy_no')}: NOT ATTEMPTED`,
          { reply_markup: new InlineKeyboard().text(t('back'), `outcome:${outcomeId}`).row().text(t('main_menu_btn'), 'back_menu') },
        );
        userStates.delete(chatId);
        busyLocks.delete(chatId);
        return;
      }

      // Place NO buy order (limit at ask price)
      await replaceOrReply(ctx, `${t('split_buy_title')}\n\n${t('split_buy_yes')}: OK\n${t('split_buy_no')}: ${execPairs} @ $${execAskNo.toFixed(4)}...`);

      let noResult = null;
      let noFilled = null;
      let noError = null;

      try {
        noResult = await client.placeOrder(noCoin, true, execAskNo, execPairs, 'Limit');
        const noStatuses = noResult?.response?.data?.statuses || [];
        noFilled = noStatuses.find(s => s.filled);
        const noResting = noStatuses.find(s => s.resting);
        const noErr = noStatuses.find(s => s.error);

        if (noErr) {
          noError = noErr.error;
        } else if (!noFilled && noResting) {
          noFilled = { filled: { totalSz: '0', avgPx: String(execAskNo) } };
        }
      } catch (err) {
        noError = err.message;
      }

      if (noError) {
        // YES succeeded but NO failed — warn user about one-sided position
        const yesSz = yesFilled?.filled?.totalSz || execPairs;
        await replaceOrReply(ctx,
          `${t('split_partial')}\n\n` +
          `${t('split_buy_yes')}: ${yesSz} shares @ $${execAskYes.toFixed(4)} — OK\n` +
          `${t('split_buy_no')}: FAILED — ${noError}\n\n` +
          `WARNING: You have a one-sided YES position. Consider selling or placing NO order manually.`,
          { reply_markup: new InlineKeyboard().text(t('back'), `outcome:${outcomeId}`).row().text(t('main_menu_btn'), 'back_menu') },
        );
        userStates.delete(chatId);
        busyLocks.delete(chatId);
        return;
      }

      // Both succeeded
      const yesSz = yesFilled?.filled?.totalSz || execPairs;
      const noSz = noFilled?.filled?.totalSz || execPairs;
      const yesAvgPx = yesFilled?.filled?.avgPx || execAskYes;
      const noAvgPx = noFilled?.filled?.avgPx || execAskNo;
      const actualCost = Number(yesSz) * Number(yesAvgPx) + Number(noSz) * Number(noAvgPx);
      const actualSettlement = Math.min(Number(yesSz), Number(noSz));
      const actualProfit = actualSettlement - actualCost;

      const resultText =
        `${t('split_executed')}\n\n` +
        `${t('split_buy_yes')}: ${yesSz} shares @ $${Number(yesAvgPx).toFixed(4)}\n` +
        `${t('split_buy_no')}: ${noSz} shares @ $${Number(noAvgPx).toFixed(4)}\n` +
        `${t('split_total_cost')}: $${actualCost.toFixed(2)}\n` +
        `${t('split_settlement_value')}: $${actualSettlement.toFixed(2)}\n` +
        `${t('split_guaranteed_profit')}: $${actualProfit.toFixed(2)} (${(actualProfit / actualCost * 100).toFixed(2)}%)`;

      await replaceOrReply(ctx, resultText, {
        reply_markup: new InlineKeyboard()
          .text(t('back'), `outcome:${outcomeId}`)
          .row()
          .text(t('main_menu_btn'), 'back_menu'),
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
