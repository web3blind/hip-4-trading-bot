/**
 * Search Markets feature for HIP-4 Telegram bot.
 *
 * Allows user to search cached outcomes by name, description,
 * and parsed priceBinary fields (underlying, targetPrice).
 */

import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { userStates } from '../runtime.js';
import { fetchAndCacheOutcomes } from './outcomes.js';
import { formatPricePercent, boundTelegramText } from '../ui/formatters.js';

// ─── Search helpers ──────────────────────────────────────────

/**
 * Extract searchable text from a priceBinary description.
 * e.g. "class:priceBinary|underlying:BTC|targetPrice:66220|period:1d"
 * => "BTC 66220"
 */
function extractPriceBinaryTerms(description) {
  if (!description || !description.startsWith('class:priceBinary')) return '';
  const parts = {};
  for (const seg of description.split('|')) {
    const idx = seg.indexOf(':');
    if (idx > 0) parts[seg.slice(0, idx)] = seg.slice(idx + 1);
  }
  const terms = [];
  if (parts.underlying) terms.push(parts.underlying);
  if (parts.targetPrice) terms.push(parts.targetPrice);
  return terms.join(' ');
}

/**
 * Check whether an event matches a search query (case-insensitive).
 */
function eventMatchesQuery(event, query) {
  const q = query.toLowerCase();

  // Match on event-level name & description
  if ((event.name || '').toLowerCase().includes(q)) return true;
  if ((event.description || '').toLowerCase().includes(q)) return true;

  // For standalone events, also check the inner outcome
  if (event.type === 'standalone' && event.outcome) {
    if ((event.outcome.name || '').toLowerCase().includes(q)) return true;
    if ((event.outcome.description || '').toLowerCase().includes(q)) return true;
    const priceBinaryTerms = extractPriceBinaryTerms(event.outcome.description);
    if (priceBinaryTerms.toLowerCase().includes(q)) return true;
  }

  // For question events, check individual outcomes
  if (event.type === 'question' && event.outcomes) {
    for (const o of event.outcomes) {
      if ((o.name || '').toLowerCase().includes(q)) return true;
      if ((o.description || '').toLowerCase().includes(q)) return true;
    }
  }

  // Also check priceBinary on event description itself
  const eventPBTerms = extractPriceBinaryTerms(event.description);
  if (eventPBTerms.toLowerCase().includes(q)) return true;

  return false;
}

// ─── Feature factory ─────────────────────────────────────────

export function createSearchFeature(deps) {
  const { hlClient } = deps;

  async function handleSearchStart(ctx) {
    const chatId = ctx.chat.id;
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'en');

    userStates.set(chatId, { state: 'AWAITING_SEARCH_QUERY' });

    const cancelKb = new InlineKeyboard().text(t('cancel'), 'back_menu');

    try {
      await ctx.editMessageText(t('enter_search_query'), { reply_markup: cancelKb });
    } catch {
      await ctx.reply(t('enter_search_query'), { reply_markup: cancelKb });
    }
  }

  async function handleSearchQuery(ctx, state, text) {
    const chatId = ctx.chat.id;
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'en');

    userStates.delete(chatId);

    const query = text.trim().slice(0, 160);
    if (!query) {
      await ctx.reply(t('please_enter_search'), {
        reply_markup: new InlineKeyboard().text(t('back_to_markets'), 'outcomes:page:1'),
      });
      return;
    }

    let events = [];
    if (hlClient) {
      try { events = await fetchAndCacheOutcomes(hlClient); } catch {}
    }

    // Search
    const matches = [];
    for (const event of events) {
      if (eventMatchesQuery(event, query)) {
        matches.push(event);
      }
      if (matches.length >= 10) break;
    }

    if (matches.length === 0) {
      const noResultText = t('no_markets_for_query', { query });
      await ctx.reply(noResultText, {
        reply_markup: new InlineKeyboard()
          .text(t('search_again'), 'search_markets')
          .row()
          .text(t('back_to_markets'), 'outcomes:page:1'),
      });
      return;
    }

    // Format results
    const plural = matches.length !== 1 ? 's' : '';
    let resultText = t('search_results', { query, count: matches.length, plural }) + '\n\n';
    const keyboard = new InlineKeyboard();

    matches.forEach((event, index) => {
      const num = index + 1;

      if (event.type === 'question') {
        resultText += `${num}. ${event.name}\n`;
        resultText += `   ${event.outcomeCount} outcomes\n\n`;
        keyboard.text((event.name || 'Event').slice(0, 50), `event:${event.questionId}`).row();
      } else {
        // Standalone
        const title = event.name || 'Outcome';
        const yesPrice = event.yesPrice != null ? formatPricePercent(event.yesPrice) : t('na');
        const noPrice = event.noPrice != null ? formatPricePercent(event.noPrice) : t('na');
        const s0 = event.side0Name || 'YES';
        const s1 = event.side1Name || 'NO';
        resultText += `${num}. ${title}\n`;
        resultText += `   ${s0}: ${yesPrice} | ${s1}: ${noPrice}\n\n`;
        keyboard.text(title.slice(0, 50), `outcome:${event.outcomeId}`).row();
      }
    });

    keyboard.text(t('search_again'), 'search_markets').row();
    keyboard.text(t('back_to_markets'), 'outcomes:page:1');

    await ctx.reply(boundTelegramText(resultText.trimEnd()), { reply_markup: keyboard });
  }

  return { handleSearchStart, handleSearchQuery };
}
