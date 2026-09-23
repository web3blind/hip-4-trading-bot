/**
 * HIP-4 Outcomes Browser — two-level navigation
 *
 * Level 1: Events (questions) + standalone outcomes
 * Level 2: Outcomes within an event
 */

import { OUTCOMES_PAGE_SIZE } from '../constants.js';
import { upsertOutcome } from '../../database.js';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { outcomesListKeyboard, eventOutcomesKeyboard, filtersKeyboard, backKeyboard } from '../ui/keyboards.js';
import { formatEventsList, formatEventOutcomes, getPriceBucketOutcomeLabel, formatTemplateTitle } from '../ui/formatters.js';

const PAGE_SIZE = OUTCOMES_PAGE_SIZE;
const CATEGORIES = ['all', 'sports', 'prices', 'economy', 'business', 'other'];
const venueToken = venue => typeof venue === 'string' && /^[a-z0-9_]{1,16}$/.test(venue);
export const normalizeMarketFilters = (category = 'all', venue = 'all') => ({
  category: CATEGORIES.includes(category) ? category : 'all',
  venue: venue === 'all' || venue === 'unknown' || venueToken(venue) ? venue : 'all',
});
export function categoryOf(name, description = '') {
  if (/^template:sports/i.test(name || '')) return 'sports';
  if (/^template:(binaryPrice|priceTouch)/i.test(name || '') || /^class:priceBinary/.test(description || '')) return 'prices';
  if (/^template:policyRate/i.test(name || '')) return 'economy';
  if (/^template:companyIpo/i.test(name || '')) return 'business';
  return 'other';
}
let knownVenues = new Map();
let pendingFetch = null;
function filteredEvents(events, category, venue) {
  return events.flatMap(event => {
    if (category !== 'all' && event.category !== category) return [];
    if (event.type === 'standalone') return venue === 'all' || event.venue === venue ? [event] : [];
    const outcomes = event.outcomes.filter(o => venue === 'all' || o.venue === venue);
    return outcomes.length ? [{ ...event, outcomes, outcomeCount: outcomes.length }] : [];
  });
}
const selectedVenue = venue => venue === 'all' || venue === 'unknown' || knownVenues.has(venue) ? venue : 'all';

let cachedEvents = [];
let cachedOutcomeMap = new Map();
export const OUTCOME_CACHE_TTL_MS = 300_000;
let cachedAt = 0;
let cachedClient = null;
let cachedNetwork = null;
let generation = 0;
export function resetOutcomeCache() {
  cachedEvents = []; cachedOutcomeMap = new Map(); cachedAt = 0;
  cachedClient = null; cachedNetwork = null; knownVenues = new Map(); pendingFetch = null; generation += 1;
}
function cacheValid(client) {
  return cachedClient === client && cachedNetwork === client?.network && Date.now() - cachedAt < OUTCOME_CACHE_TTL_MS
    && ![...cachedOutcomeMap.values()].some(o => o.status === 'active' && (isExpired(o) || isExpired({ description: o.parentDescription })));
}


function parseExpiry(description) {
  if (!description) return null;
  const match = String(description).match(/(?:^|\|)(?:expiry|time|decisionDeadline|resolutionDeadline):(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(?:\||$)/);
  if (!match) return null;
  return new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00Z`);
}

function isExpired(outcome) {
  const expiry = parseExpiry(outcome.description);
  if (!expiry) return false;
  return expiry.getTime() <= Date.now();
}

export async function fetchAndCacheOutcomes(hlClient) {
  if (cacheValid(hlClient)) return cachedEvents;
  if (pendingFetch?.client === hlClient && pendingFetch.network === hlClient.network) return pendingFetch.promise;
  resetOutcomeCache();
  const fetchGeneration = generation;
  const fetchNetwork = hlClient.network;
  const promise = rebuildCatalog(hlClient, fetchGeneration, fetchNetwork).finally(() => {
    if (pendingFetch?.promise === promise) pendingFetch = null;
  });
  pendingFetch = { client: hlClient, network: fetchNetwork, promise };
  return promise;
}
async function rebuildCatalog(hlClient, fetchGeneration, fetchNetwork) {
  const meta = await hlClient.getOutcomeMeta();
  if (!Array.isArray(meta?.outcomes) || !Array.isArray(meta?.questions)) throw new Error('Invalid outcome metadata');
  const rawOutcomes = meta.outcomes;
  const questions = meta?.questions || [];

  let mids = {};
  try {
    mids = await hlClient.getAllMids();
  } catch {
    mids = {};
  }

  const venues = new Map();
  for (const entry of meta.deployers || []) {
    if (venueToken(entry?.venue) && /^0x[0-9a-fA-F]{40}$/.test(entry?.deployer || '')) venues.set(entry.venue, entry.deployer);
  }
  const outcomeMap = new Map();
  for (const entry of rawOutcomes) {
    const oid = entry.outcome;
    if (!Number.isSafeInteger(oid) || oid < 0) continue;

    const sideSpecs = entry.sideSpecs || [{ name: 'Yes' }, { name: 'No' }];
    const coin0 = '#' + (10 * oid + 0);
    const coin1 = '#' + (10 * oid + 1);

    const outcome = {
      ...entry,
      outcomeId: oid,
      category: categoryOf(entry.name, entry.description),
      venue: venues.has(entry.venue) ? entry.venue : 'unknown',
      rawName: entry.name,
      question: formatTemplateTitle(entry.name, entry.description) || entry.name || `Outcome #${oid}`,
      name: formatTemplateTitle(entry.name, entry.description) || entry.name || `Outcome #${oid}`,
      description: entry.description || '',
      side0Name: (sideSpecs[0]?.name || 'Yes').replace(/^template:/, ''),
      side1Name: (sideSpecs[1]?.name || 'No').replace(/^template:/, ''),
      coin0,
      coin1,
      status: isExpired({ description: entry.description || '' }) ? 'expired' : 'active',
      yesPrice: mids[coin0] != null ? parseFloat(mids[coin0]) : null,
      noPrice: mids[coin1] != null ? parseFloat(mids[coin1]) : null,
      sides: [
        { side: 0, name: (sideSpecs[0]?.name || 'Yes').replace(/^template:/, ''), coin: coin0, token: `+${10 * oid + 0}` },
        { side: 1, name: (sideSpecs[1]?.name || 'No').replace(/^template:/, ''), coin: coin1, token: `+${10 * oid + 1}` },
      ],
    };

    outcomeMap.set(oid, outcome);

  }

  const events = [];
  const claimedOutcomeIds = new Set();

  for (const q of questions) {
    const settledIds = new Set((q.settledNamedOutcomes || []).map(o => typeof o === 'object' ? o.outcome : o));
    const memberIds = [...new Set([...(q.namedOutcomes || []), ...settledIds])];
    if (q.fallbackOutcome != null) memberIds.push(q.fallbackOutcome);

    const members = memberIds
      .map(id => {
        const outcome = outcomeMap.get(id);
        if (!outcome) return null;
        if (settledIds.has(id) || isExpired(q)) {
          outcome.status = settledIds.has(id) ? 'settled' : 'expired';
        }
        outcome.parentDescription = q.description || '';
        const bucketLabel = getPriceBucketOutcomeLabel(q.description || '', outcome.description || '');
        if (!bucketLabel) return outcome;
        const enriched = { ...outcome, displayName: bucketLabel };
        outcomeMap.set(id, enriched);
        return enriched;
      })
      .filter(Boolean)
      .filter(o => o.status === 'active' && !isExpired(o));

    for (const id of memberIds) claimedOutcomeIds.add(id);

    if (members.length > 0) {
      events.push({
        type: 'question',
        questionId: q.question,
        category: categoryOf(q.name, q.description),
        name: formatTemplateTitle(q.name, q.description) || q.name,
        rawName: q.name,
        description: q.description || '',
        outcomeCount: members.length,
        outcomes: members,
      });
    }
  }

  for (const [oid, outcome] of outcomeMap) {
    if (claimedOutcomeIds.has(oid)) continue;
    if (isExpired(outcome)) continue;

    let displayName = outcome.name;
    if (outcome.description && outcome.description.startsWith('class:priceBinary')) {
      const parts = {};
      for (const seg of outcome.description.split('|')) {
        const [k, v] = seg.split(':');
        if (k && v !== undefined) parts[k] = v;
      }
      if (parts.underlying && parts.targetPrice) {
        // Button label: short, no expiry (e.g. "BTC > $66220 (1d)")
        displayName = `${parts.underlying} > $${Number(parts.targetPrice).toLocaleString('en-US')}`;
        if (parts.period) displayName += ` (${parts.period})`;
      }
    }

    events.push({
      type: 'standalone',
      outcomeId: oid,
      category: outcome.category,
      venue: outcome.venue,
      name: displayName,
      description: outcome.description,
      yesPrice: outcome.yesPrice,
      noPrice: outcome.noPrice,
      side0Name: outcome.side0Name,
      side1Name: outcome.side1Name,
      outcome,
    });
  }

  events.sort((a, b) => {
    if (a.type === 'question' && b.type !== 'question') return -1;
    if (a.type !== 'question' && b.type === 'question') return 1;
    if (a.type === 'standalone' && b.type === 'standalone') {
      const aHas = (a.yesPrice != null && a.noPrice != null) ? 1 : 0;
      const bHas = (b.yesPrice != null && b.noPrice != null) ? 1 : 0;
      return bHas - aHas;
    }
    return 0;
  });

  if (fetchGeneration !== generation || hlClient.network !== fetchNetwork) throw new Error('Catalog refresh superseded');
  for (const outcome of outcomeMap.values()) {
    try { upsertOutcome(outcome); } catch {}
  }
  cachedEvents = events;
  cachedOutcomeMap = outcomeMap;
  knownVenues = venues;
  cachedAt = Date.now(); cachedClient = hlClient; cachedNetwork = hlClient.network;
  return events;
}

export async function showMarketFilters(ctx, hlClient, category = 'all', venue = 'all') {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');
  try {
    const events = await fetchAndCacheOutcomes(hlClient);
    const normalized = normalizeMarketFilters(category, venue);
    const selected = { category: normalized.category, venue: selectedVenue(normalized.venue) };
    const categories = CATEGORIES.filter(key => key === 'all' || filteredEvents(events, key, 'all').length);
    const venues = [...knownVenues.keys()].filter(key => filteredEvents(events, selected.category, key).length);
    if (filteredEvents(events, selected.category, 'unknown').length) venues.push('unknown');
    const text = `${t('market_filters_title')}\n${t('market_category')}: ${t(`market_category_${selected.category}`)}\n${t('market_deployer')}: ${selected.venue === 'all' ? t('market_all') : selected.venue === 'unknown' ? t('market_unknown_deployer') : selected.venue}\n${t('market_category_note')}`;
    const reply_markup = filtersKeyboard(categories, venues, selected, t);
    try { await ctx.editMessageText(text, { reply_markup }); }
    catch { await ctx.reply(text, { reply_markup }); }
  } catch {
    const text = t('could_not_load', { scope: t('menu_markets') });
    try { await ctx.editMessageText(text, { reply_markup: backKeyboard('back_menu', t) }); }
    catch { await ctx.reply(text, { reply_markup: backKeyboard('back_menu', t) }); }
  }
}

export async function showOutcomesList(ctx, hlClient, page = 1, category = 'all', venue = 'all') {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');

  try {
    if (!cacheValid(hlClient)) { try { await ctx.editMessageText(t('loading_markets')); } catch {} }

    const events = await fetchAndCacheOutcomes(hlClient);
    const filters = normalizeMarketFilters(category, venue);
    const selected = { category: filters.category, venue: selectedVenue(filters.venue) };
    const visible = filteredEvents(events, selected.category, selected.venue);

    if (visible.length === 0) {
      const text = t('no_active_markets');
      const reply_markup = filtersKeyboard([], [], selected, t);
      try {
        await ctx.editMessageText(text, { reply_markup });
      } catch {
        await ctx.reply(text, { reply_markup });
      }
      return;
    }

    const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
    const safePage = Math.max(1, Math.min(page, totalPages));
    const startIndex = (safePage - 1) * PAGE_SIZE;
    const pageEvents = visible.slice(startIndex, startIndex + PAGE_SIZE);

    const heading = `${t(`market_category_${selected.category}`)} · ${selected.venue === 'all' ? t('market_all') : selected.venue}`;
    const text = `${heading}\n${formatEventsList(pageEvents, safePage, totalPages, t)}\n${t('market_cached_prices_note')}`;
    const keyboard = outcomesListKeyboard(pageEvents, safePage, totalPages, t, selected);

    try {
      await ctx.editMessageText(text, { reply_markup: keyboard });
    } catch {
      await ctx.reply(text, { reply_markup: keyboard });
    }
  } catch {
    const errorText = t('could_not_load', { scope: t('menu_markets') });
    try {
      await ctx.editMessageText(errorText, { reply_markup: backKeyboard('back_menu', t) });
    } catch {
      try { await ctx.reply(errorText, { reply_markup: backKeyboard('back_menu', t) }); } catch {}
    }
  }
}

export async function showEventOutcomes(ctx, hlClient, questionId, category = 'all', venue = 'all') {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');

  try {
    const events = await fetchAndCacheOutcomes(hlClient);
    const filters = normalizeMarketFilters(category, venue);
    const selected = { category: filters.category, venue: selectedVenue(filters.venue) };
    const event = filteredEvents(events, selected.category, selected.venue).find(e => e.type === 'question' && e.questionId === questionId);
    if (!event) {
      try {
        await ctx.editMessageText(t('event_no_markets'), { reply_markup: backKeyboard(`outcomes:page:1:${selected.category}:${selected.venue}`, t) });
      } catch {}
      return;
    }

    const requestedPage = Number(ctx.callbackQuery?.data?.split(':')[2]) || 1;
    const totalPages = Math.max(1, Math.ceil(event.outcomes.length / PAGE_SIZE));
    const page = Math.min(totalPages, Math.max(1, Math.floor(requestedPage)));
    const view = { ...event, page, totalPages, outcomes: event.outcomes.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) };
    const text = `${formatEventOutcomes(view, t)}\n${t('market_cached_prices_note')}`;
    const keyboard = eventOutcomesKeyboard(view, t, selected);

    try {
      await ctx.editMessageText(text, { reply_markup: keyboard });
    } catch {
      await ctx.reply(text, { reply_markup: keyboard });
    }
  } catch {
    const errorText = t('could_not_load', { scope: t('menu_markets') });
    try {
      await ctx.editMessageText(errorText, { reply_markup: backKeyboard('outcomes:page:1', t) });
    } catch {}
  }
}

export function getCachedOutcome(outcomeId) {
  if (Date.now() - cachedAt >= OUTCOME_CACHE_TTL_MS) return null;
  const outcome = cachedOutcomeMap.get(outcomeId);
  if (!outcome || cachedNetwork !== cachedClient?.network || isExpired(outcome) || isExpired({ description: outcome.parentDescription })) return null;
  return outcome;
}

export function getCachedEvents() {
  return Date.now() - cachedAt < OUTCOME_CACHE_TTL_MS ? cachedEvents : [];
}
