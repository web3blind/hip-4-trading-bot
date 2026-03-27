/**
 * HIP-4 Outcomes Browser
 *
 * Lists available HIP-4 outcome markets with pagination,
 * shows YES/NO prices, and allows selecting an outcome for details.
 *
 * outcomeMeta returns:
 * {
 *   outcomes: [{ outcome: 9, name: "...", description: "...", sideSpecs: [{name:"Yes"},{name:"No"}] }, ...],
 *   questions: [{ question: 1, name: "...", description: "...", ... }, ...]
 * }
 *
 * allMids returns:  { "#90": "0.55", "#91": "0.45", ... }
 * Encoding:  coin = "#" + (10 * outcomeId + side)  where side 0=first, 1=second
 */

import { OUTCOMES_PAGE_SIZE } from '../constants.js';
import { upsertOutcome, getOutcomes, getOutcomeCount } from '../../database.js';
import { outcomesListKeyboard } from '../ui/keyboards.js';
import { formatOutcomeList } from '../ui/formatters.js';

const PAGE_SIZE = OUTCOMES_PAGE_SIZE;

/**
 * Fetch outcomes from HyperLiquid, cache them, return paginated slice.
 */
export async function fetchAndCacheOutcomes(hlClient, page = 1) {
  const meta = await hlClient.getOutcomeMeta();

  const rawOutcomes = meta?.outcomes || [];
  const questions = meta?.questions || [];

  // Build question lookup
  const questionMap = new Map();
  for (const q of questions) {
    if (q.namedOutcomes) {
      for (const oid of q.namedOutcomes) {
        questionMap.set(oid, q);
      }
    }
    if (q.fallbackOutcome != null) {
      questionMap.set(q.fallbackOutcome, q);
    }
  }

  // Fetch all mid prices
  let mids = {};
  try {
    mids = await hlClient.getAllMids();
  } catch {
    // continue without prices
  }

  // Build outcome list
  const allOutcomes = [];

  for (const entry of rawOutcomes) {
    const outcomeId = entry.outcome;
    if (outcomeId == null) continue;

    const sideSpecs = entry.sideSpecs || [{ name: 'Yes' }, { name: 'No' }];
    const side0Name = sideSpecs[0]?.name || 'Yes';
    const side1Name = sideSpecs[1]?.name || 'No';

    // Coins: #(10*outcomeId + 0) and #(10*outcomeId + 1)
    const coin0 = '#' + (10 * outcomeId + 0);
    const coin1 = '#' + (10 * outcomeId + 1);

    const yesPrice = mids[coin0] != null ? parseFloat(mids[coin0]) : null;
    const noPrice = mids[coin1] != null ? parseFloat(mids[coin1]) : null;

    // Get question context if available
    const parentQuestion = questionMap.get(outcomeId);
    const questionText = parentQuestion?.name || null;

    const outcome = {
      outcomeId,
      name: entry.name || `Outcome #${outcomeId}`,
      question: questionText || entry.name || `Outcome #${outcomeId}`,
      description: entry.description || '',
      side0Name,
      side1Name,
      coin0,
      coin1,
      yesPrice,
      noPrice,
      sides: [
        { side: 0, name: side0Name, coin: coin0, token: '+' + (10 * outcomeId + 0), assetId: 100_000_000 + 10 * outcomeId + 0 },
        { side: 1, name: side1Name, coin: coin1, token: '+' + (10 * outcomeId + 1), assetId: 100_000_000 + 10 * outcomeId + 1 },
      ],
    };

    allOutcomes.push(outcome);

    // Cache in database
    try {
      upsertOutcome(outcome);
    } catch {
      // non-critical
    }
  }

  // Sort by outcomeId
  allOutcomes.sort((a, b) => a.outcomeId - b.outcomeId);

  // Paginate
  const totalPages = Math.max(1, Math.ceil(allOutcomes.length / PAGE_SIZE));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const startIndex = (safePage - 1) * PAGE_SIZE;
  const pageOutcomes = allOutcomes.slice(startIndex, startIndex + PAGE_SIZE);

  return {
    outcomes: pageOutcomes,
    page: safePage,
    totalPages,
  };
}

/**
 * Show the paginated outcomes list in a Telegram message.
 */
export async function showOutcomesList(ctx, hlClient, page = 1) {
  try {
    try {
      await ctx.editMessageText('Loading outcomes...');
    } catch {
      // first message — ignore edit failure
    }

    const { outcomes, page: currentPage, totalPages } = await fetchAndCacheOutcomes(hlClient, page);

    if (outcomes.length === 0) {
      const text = 'No outcomes available on testnet right now.';
      const keyboard = (await import('../ui/keyboards.js')).backKeyboard('back_menu');
      try {
        await ctx.editMessageText(text, { reply_markup: keyboard });
      } catch {
        await ctx.reply(text, { reply_markup: keyboard });
      }
      return;
    }

    const text = formatOutcomeList(outcomes, currentPage, totalPages);
    const keyboard = outcomesListKeyboard(outcomes, currentPage, totalPages);

    try {
      await ctx.editMessageText(text, { reply_markup: keyboard });
    } catch {
      await ctx.reply(text, { reply_markup: keyboard });
    }
  } catch (error) {
    const errorText = 'Error loading outcomes: ' + (error?.message || 'unknown error');
    const keyboard = (await import('../ui/keyboards.js')).backKeyboard('back_menu');
    try {
      await ctx.editMessageText(errorText, { reply_markup: keyboard });
    } catch {
      try { await ctx.reply(errorText, { reply_markup: keyboard }); } catch {}
    }
  }
}
