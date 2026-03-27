/**
 * HIP-4 Outcomes Browser — two-level navigation
 *
 * Level 1: Events (questions) + standalone outcomes
 * Level 2: Outcomes within an event
 *
 * outcomeMeta returns:
 * {
 *   outcomes: [{ outcome: 9, name: "...", description: "...", sideSpecs: [...] }, ...],
 *   questions: [{ question: 1, name: "...", namedOutcomes: [10,11,12], fallbackOutcome: 13 }, ...]
 * }
 */

import { OUTCOMES_PAGE_SIZE } from '../constants.js';
import { upsertOutcome } from '../../database.js';
import { outcomesListKeyboard, eventOutcomesKeyboard, backKeyboard } from '../ui/keyboards.js';
import { formatEventsList, formatEventOutcomes } from '../ui/formatters.js';

const PAGE_SIZE = OUTCOMES_PAGE_SIZE;

// In-memory cache (refreshed each fetch)
let cachedEvents = [];
let cachedOutcomeMap = new Map(); // outcomeId -> outcome data

/**
 * Parse expiry from priceBinary description.
 * Returns Date or null.
 * Format: "class:priceBinary|...|expiry:20260328-0300|..."
 */
function parseExpiry(description) {
  if (!description) return null;
  const match = description.match(/expiry:(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/);
  if (!match) return null;
  return new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00Z`);
}

/** Check if an outcome is expired */
function isExpired(outcome) {
  const expiry = parseExpiry(outcome.description);
  if (!expiry) return false; // no expiry = not expired
  return expiry < new Date();
}

/** Check if outcome has any liquidity (mid price exists and > 0) */
function hasLiquidity(outcome) {
  return outcome.yesPrice != null || outcome.noPrice != null;
}

/**
 * Fetch and structure outcomes into events + standalones.
 */
export async function fetchAndCacheOutcomes(hlClient) {
  const meta = await hlClient.getOutcomeMeta();
  const rawOutcomes = meta?.outcomes || [];
  const questions = meta?.questions || [];

  // Fetch mid prices
  let mids = {};
  try {
    mids = await hlClient.getAllMids();
  } catch {}

  // Build outcome objects
  const outcomeMap = new Map();
  for (const entry of rawOutcomes) {
    const oid = entry.outcome;
    if (oid == null) continue;

    const sideSpecs = entry.sideSpecs || [{ name: 'Yes' }, { name: 'No' }];
    const coin0 = '#' + (10 * oid + 0);
    const coin1 = '#' + (10 * oid + 1);

    const outcome = {
      outcomeId: oid,
      name: entry.name || `Outcome #${oid}`,
      description: entry.description || '',
      side0Name: sideSpecs[0]?.name || 'Yes',
      side1Name: sideSpecs[1]?.name || 'No',
      coin0,
      coin1,
      yesPrice: mids[coin0] != null ? parseFloat(mids[coin0]) : null,
      noPrice: mids[coin1] != null ? parseFloat(mids[coin1]) : null,
      sides: [
        { side: 0, name: sideSpecs[0]?.name || 'Yes', coin: coin0 },
        { side: 1, name: sideSpecs[1]?.name || 'No', coin: coin1 },
      ],
    };

    outcomeMap.set(oid, outcome);

    try { upsertOutcome(outcome); } catch {}
  }

  // Build events list: questions + standalones
  const events = [];

  // Track which outcomes belong to a question
  const claimedOutcomeIds = new Set();

  for (const q of questions) {
    const memberIds = [...(q.namedOutcomes || [])];
    if (q.fallbackOutcome != null) memberIds.push(q.fallbackOutcome);

    const members = memberIds
      .map(id => outcomeMap.get(id))
      .filter(Boolean)
      .filter(o => !isExpired(o)); // hide expired outcomes within a question

    for (const id of memberIds) claimedOutcomeIds.add(id);

    // Only show question if it has active outcomes
    if (members.length > 0) {
      events.push({
        type: 'question',
        questionId: q.question,
        name: q.name,
        description: q.description || '',
        outcomeCount: members.length,
        outcomes: members,
      });
    }
  }

  // Standalone outcomes (not part of any question)
  for (const [oid, outcome] of outcomeMap) {
    if (claimedOutcomeIds.has(oid)) continue;

    // Skip expired outcomes in markets list
    if (isExpired(outcome)) continue;

    // Parse priceBinary description for nicer display
    let displayName = outcome.name;
    if (outcome.description && outcome.description.startsWith('class:priceBinary')) {
      const parts = {};
      for (const seg of outcome.description.split('|')) {
        const [k, v] = seg.split(':');
        if (k && v !== undefined) parts[k] = v;
      }
      if (parts.underlying && parts.targetPrice) {
        displayName = `${parts.underlying} > $${parts.targetPrice}`;
        if (parts.expiry) displayName += ` by ${parts.expiry}`;
        if (parts.period) displayName += ` (${parts.period})`;
      }
    }

    events.push({
      type: 'standalone',
      outcomeId: oid,
      name: displayName,
      description: outcome.description,
      yesPrice: outcome.yesPrice,
      noPrice: outcome.noPrice,
      side0Name: outcome.side0Name,
      side1Name: outcome.side1Name,
      outcome,
    });
  }

  cachedEvents = events;
  cachedOutcomeMap = outcomeMap;

  return events;
}

/**
 * Level 1: Show events list (questions + standalones).
 */
export async function showOutcomesList(ctx, hlClient, page = 1) {
  try {
    try { await ctx.editMessageText('Loading markets...'); } catch {}

    const events = await fetchAndCacheOutcomes(hlClient);

    if (events.length === 0) {
      const text = 'No markets available on testnet right now.';
      try {
        await ctx.editMessageText(text, { reply_markup: backKeyboard('back_menu') });
      } catch {
        await ctx.reply(text, { reply_markup: backKeyboard('back_menu') });
      }
      return;
    }

    const totalPages = Math.max(1, Math.ceil(events.length / PAGE_SIZE));
    const safePage = Math.max(1, Math.min(page, totalPages));
    const startIndex = (safePage - 1) * PAGE_SIZE;
    const pageEvents = events.slice(startIndex, startIndex + PAGE_SIZE);

    const text = formatEventsList(pageEvents, safePage, totalPages);
    const keyboard = outcomesListKeyboard(pageEvents, safePage, totalPages);

    try {
      await ctx.editMessageText(text, { reply_markup: keyboard });
    } catch {
      await ctx.reply(text, { reply_markup: keyboard });
    }
  } catch (error) {
    const errorText = 'Error loading markets: ' + (error?.message || 'unknown');
    try {
      await ctx.editMessageText(errorText, { reply_markup: backKeyboard('back_menu') });
    } catch {
      try { await ctx.reply(errorText, { reply_markup: backKeyboard('back_menu') }); } catch {}
    }
  }
}

/**
 * Level 2: Show outcomes within an event (question).
 */
export async function showEventOutcomes(ctx, hlClient, questionId) {
  try {
    // Refresh if cache is empty
    if (cachedEvents.length === 0) {
      await fetchAndCacheOutcomes(hlClient);
    }

    const event = cachedEvents.find(e => e.type === 'question' && e.questionId === questionId);
    if (!event) {
      try {
        await ctx.editMessageText('Event not found.', { reply_markup: backKeyboard('outcomes:page:1') });
      } catch {}
      return;
    }

    const text = formatEventOutcomes(event);
    const keyboard = eventOutcomesKeyboard(event);

    try {
      await ctx.editMessageText(text, { reply_markup: keyboard });
    } catch {
      await ctx.reply(text, { reply_markup: keyboard });
    }
  } catch (error) {
    const errorText = 'Error: ' + (error?.message || 'unknown');
    try {
      await ctx.editMessageText(errorText, { reply_markup: backKeyboard('outcomes:page:1') });
    } catch {}
  }
}

export function getCachedOutcome(outcomeId) {
  return cachedOutcomeMap.get(outcomeId) || null;
}
