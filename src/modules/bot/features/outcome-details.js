/**
 * HIP-4 Outcome Details View
 *
 * Replaces the old Polymarket market-details.js.
 * Shows detailed info for a single outcome: prices, spread, mini orderbook.
 * Provides trade action buttons: Buy/Sell YES/NO.
 */

import { getOutcomeById } from '../../database.js';
import { outcomeDetailKeyboard, backKeyboard } from '../ui/keyboards.js';
import { formatOutcomeDetail } from '../ui/formatters.js';
import { toCoin } from '../../hl-encoding.js';
import { ORDERBOOK_DEPTH } from '../constants.js';

/**
 * Fetch detailed data for a single outcome including orderbook.
 *
 * @param {HLClient} hlClient - HyperLiquid client
 * @param {number} outcomeId - Outcome ID
 * @returns {object} { outcome, orderbook, prices }
 */
export async function fetchOutcomeDetails(hlClient, outcomeId) {
  // Try to get from database first
  let outcome = getOutcomeById(outcomeId);

  // If not in DB, fetch fresh metadata
  if (!outcome) {
    const meta = await hlClient.getOutcomeMeta();
    const universe = meta?.universe || [];

    // Find entries for this outcomeId
    const yesCoin = toCoin(outcomeId, 0);
    const noCoin = toCoin(outcomeId, 1);

    const yesEntry = universe.find(e => (e.name || e.coin) === yesCoin);
    const noEntry = universe.find(e => (e.name || e.coin) === noCoin);

    if (!yesEntry && !noEntry) {
      return null;
    }

    outcome = {
      outcome_id: outcomeId,
      outcomeId,
      question: yesEntry?.fullName || noEntry?.fullName || `Outcome #${outcomeId}`,
      description: yesEntry?.description || noEntry?.description || '',
      sides: [
        { side: 0, coin: yesCoin },
        { side: 1, coin: noCoin },
      ],
    };
  }

  // Fetch mid prices
  let prices = { yes: null, no: null };
  try {
    const mids = await hlClient.getAllMids();
    const yesCoin = toCoin(outcomeId, 0);
    const noCoin = toCoin(outcomeId, 1);
    if (mids[yesCoin] != null) prices.yes = mids[yesCoin];
    if (mids[noCoin] != null) prices.no = mids[noCoin];
  } catch {
    // Prices unavailable
  }

  // Fetch orderbook for BOTH sides to know what's tradeable
  let orderbook = { bids: [], asks: [] };
  const tradeable = { yesBuy: false, yesSell: false, noBuy: false, noSell: false };

  const yesCoin = toCoin(outcomeId, 0);
  const noCoin = toCoin(outcomeId, 1);

  try {
    const yesBook = await hlClient.getOrderbook(yesCoin);
    if (yesBook?.levels) {
      const [rawBids, rawAsks] = yesBook.levels;
      orderbook.bids = (rawBids || []).slice(0, ORDERBOOK_DEPTH).map(e => [e.px, e.sz]);
      orderbook.asks = (rawAsks || []).slice(0, ORDERBOOK_DEPTH).map(e => [e.px, e.sz]);
      if (rawAsks?.length > 0) tradeable.yesBuy = true;
      if (rawBids?.length > 0) tradeable.yesSell = true;
    }
  } catch {}

  try {
    const noBook = await hlClient.getOrderbook(noCoin);
    if (noBook?.levels) {
      const [rawBids, rawAsks] = noBook.levels;
      if (rawAsks?.length > 0) tradeable.noBuy = true;
      if (rawBids?.length > 0) tradeable.noSell = true;
    }
  } catch {}

  return { outcome, orderbook, prices, tradeable };
}

/**
 * Show the outcome detail view in a Telegram message.
 *
 * @param {object} ctx - Grammy context
 * @param {HLClient} hlClient - HyperLiquid client
 * @param {number} outcomeId - Outcome ID
 */
export async function showOutcomeDetail(ctx, hlClient, outcomeId) {
  try {
    try {
      await ctx.editMessageText('Loading outcome details...');
    } catch {
      // First message — edit may fail
    }

    const details = await fetchOutcomeDetails(hlClient, outcomeId);

    if (!details) {
      const text = `Outcome #${outcomeId} not found.`;
      await ctx.editMessageText(text, { reply_markup: backKeyboard('outcomes:page:1') });
      return;
    }

    const { outcome, orderbook, prices, tradeable } = details;
    const text = formatOutcomeDetail(outcome, orderbook, prices);
    const keyboard = outcomeDetailKeyboard(outcomeId, null, tradeable);

    await ctx.editMessageText(text, { reply_markup: keyboard });
  } catch (error) {
    const errorText = 'Error loading outcome details. Please try again.';
    try {
      await ctx.editMessageText(errorText, { reply_markup: backKeyboard('outcomes:page:1') });
    } catch {
      // Best effort
    }
  }
}
