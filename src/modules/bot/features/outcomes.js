/**
 * HIP-4 Outcomes Browser
 *
 * Replaces the old Polymarket markets.js.
 * Lists available HIP-4 outcome markets with pagination,
 * shows YES/NO prices, and allows selecting an outcome for details.
 */

import { OUTCOMES_PAGE_SIZE } from '../constants.js';
import { upsertOutcome, getOutcomes, getOutcomeCount } from '../../database.js';
import { outcomesListKeyboard } from '../ui/keyboards.js';
import { formatOutcomeList, formatPricePercent } from '../ui/formatters.js';
import { toCoin, toToken, toAssetId } from '../../hl-encoding.js';

const PAGE_SIZE = OUTCOMES_PAGE_SIZE;

/**
 * Fetch outcomes from HyperLiquid, cache them in the database,
 * and return a paginated slice with mid prices.
 *
 * @param {HLClient} hlClient - HyperLiquid client instance
 * @param {number} page - 1-based page number
 * @returns {{ outcomes: Array, page: number, totalPages: number }}
 */
export async function fetchAndCacheOutcomes(hlClient, page = 1) {
  // Fetch all outcome metadata
  const meta = await hlClient.getOutcomeMeta();

  // spotMeta returns { universe: [...], tokens: [...] }
  // universe entries with an "isOutcome" or coin starting with '#' are outcomes
  const universe = meta?.universe || [];
  const tokens = meta?.tokens || [];

  // Build a lookup: coin -> token info
  const tokenMap = new Map();
  for (const tok of tokens) {
    if (tok.name) {
      tokenMap.set(tok.name, tok);
    }
  }

  // Filter to outcome-type entries
  // HIP-4 outcomes appear in universe with coins like "#21460"
  const outcomeEntries = universe.filter(entry => {
    const name = entry.name || entry.coin || '';
    return name.startsWith('#') || entry.isOutcome === true;
  });

  // Fetch all mid prices in one call for efficiency
  let mids = {};
  try {
    mids = await hlClient.getAllMids();
  } catch {
    // Mid prices unavailable — continue without them
  }

  // Group by outcomeId: each outcome has two entries (YES side=0, NO side=1)
  const outcomeMap = new Map();

  for (const entry of outcomeEntries) {
    const coin = entry.name || entry.coin || '';
    if (!coin.startsWith('#')) continue;

    const encoding = parseInt(coin.slice(1), 10);
    if (isNaN(encoding)) continue;

    const side = encoding % 10;
    const outcomeId = (encoding - side) / 10;

    if (!outcomeMap.has(outcomeId)) {
      outcomeMap.set(outcomeId, {
        outcomeId,
        question: null,
        description: null,
        sides: [],
        yesPrice: null,
        noPrice: null,
      });
    }

    const outcome = outcomeMap.get(outcomeId);

    // Use the token info for description if available
    const tokenInfo = tokenMap.get(coin);
    if (tokenInfo) {
      // Try to extract a human-readable description
      if (tokenInfo.fullName) {
        outcome.question = outcome.question || tokenInfo.fullName;
      }
    }

    // Fallback question: use the entry's description or name
    if (!outcome.question) {
      outcome.question = entry.fullName || entry.description || `Outcome #${outcomeId}`;
    }
    if (entry.description) {
      outcome.description = entry.description;
    }

    // Record side data
    const sideData = {
      side,
      coin,
      token: coin.replace('#', '+'),
      assetId: 100_000_000 + encoding,
    };
    outcome.sides.push(sideData);

    // Get mid price for this side
    const midPrice = mids[coin];
    if (midPrice != null) {
      if (side === 0) {
        outcome.yesPrice = midPrice;
      } else if (side === 1) {
        outcome.noPrice = midPrice;
      }
    }
  }

  // Convert to array and sort by outcomeId
  const allOutcomes = Array.from(outcomeMap.values()).sort((a, b) => a.outcomeId - b.outcomeId);

  // Cache each outcome in the database
  for (const outcome of allOutcomes) {
    try {
      upsertOutcome(outcome);
    } catch {
      // Non-critical — continue
    }
  }

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
 *
 * @param {object} ctx - Grammy context (with editMessageText or reply)
 * @param {HLClient} hlClient - HyperLiquid client
 * @param {number} page - 1-based page number
 */
export async function showOutcomesList(ctx, hlClient, page = 1) {
  try {
    // Show loading state
    try {
      await ctx.editMessageText('Loading outcomes...');
    } catch {
      // If editMessageText fails (first message), use reply instead
    }

    const { outcomes, page: currentPage, totalPages } = await fetchAndCacheOutcomes(hlClient, page);

    if (outcomes.length === 0) {
      const text = 'No outcomes found.';
      const keyboard = (await import('../ui/keyboards.js')).backKeyboard('back_menu');
      await ctx.editMessageText(text, { reply_markup: keyboard });
      return;
    }

    const text = formatOutcomeList(outcomes, currentPage, totalPages);
    const keyboard = outcomesListKeyboard(outcomes, currentPage, totalPages);

    await ctx.editMessageText(text, { reply_markup: keyboard });
  } catch (error) {
    const errorText = 'Error loading outcomes. Please try again.';
    const keyboard = (await import('../ui/keyboards.js')).backKeyboard('back_menu');
    try {
      await ctx.editMessageText(errorText, { reply_markup: keyboard });
    } catch {
      // Best effort
    }
  }
}
