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
import { outcomesListKeyboard, eventOutcomesKeyboard, backKeyboard } from '../ui/keyboards.js';
import { formatEventsList, formatEventOutcomes } from '../ui/formatters.js';

const PAGE_SIZE = OUTCOMES_PAGE_SIZE;

let cachedEvents = [];
let cachedOutcomeMap = new Map();

function parseExpiry(description) {
  if (!description) return null;
  const match = description.match(/expiry:(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/);
  if (!match) return null;
  return new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00Z`);
}

function isExpired(outcome) {
  const expiry = parseExpiry(outcome.description);
  if (!expiry) return false;
  return expiry < new Date();
}

export async function fetchAndCacheOutcomes(hlClient) {
  const meta = await hlClient.getOutcomeMeta();
  const rawOutcomes = meta?.outcomes || [];
  const questions = meta?.questions || [];

  let mids = {};
  try {
    mids = await hlClient.getAllMids();
  } catch {
    mids = {};
  }

  const outcomeMap = new Map();
  for (const entry of rawOutcomes) {
    const oid = entry.outcome;
    if (oid == null) continue;

    const sideSpecs = entry.sideSpecs || [{ name: 'Yes' }, { name: 'No' }];
    const coin0 = '#' + (10 * oid + 0);
    const coin1 = '#' + (10 * oid + 1);

    const outcome = {
      outcomeId: oid,
      question: entry.name || `Outcome #${oid}`,
      name: entry.name || `Outcome #${oid}`,
      description: entry.description || '',
      side0Name: sideSpecs[0]?.name || 'Yes',
      side1Name: sideSpecs[1]?.name || 'No',
      coin0,
      coin1,
      status: isExpired({ description: entry.description || '' }) ? 'expired' : 'active',
      yesPrice: mids[coin0] != null ? parseFloat(mids[coin0]) : null,
      noPrice: mids[coin1] != null ? parseFloat(mids[coin1]) : null,
      sides: [
        { side: 0, name: sideSpecs[0]?.name || 'Yes', coin: coin0, token: `@${10 * oid + 0}` },
        { side: 1, name: sideSpecs[1]?.name || 'No', coin: coin1, token: `@${10 * oid + 1}` },
      ],
    };

    outcomeMap.set(oid, outcome);
    try { upsertOutcome(outcome); } catch {}
  }

  const events = [];
  const claimedOutcomeIds = new Set();

  for (const q of questions) {
    const memberIds = [...(q.namedOutcomes || [])];
    if (q.fallbackOutcome != null) memberIds.push(q.fallbackOutcome);

    const members = memberIds
      .map(id => outcomeMap.get(id))
      .filter(Boolean)
      .filter(o => !isExpired(o));

    for (const id of memberIds) claimedOutcomeIds.add(id);

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

  cachedEvents = events;
  cachedOutcomeMap = outcomeMap;
  return events;
}

export async function showOutcomesList(ctx, hlClient, page = 1) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');

  try {
    try { await ctx.editMessageText(t('loading_markets')); } catch {}

    const events = await fetchAndCacheOutcomes(hlClient);

    if (events.length === 0) {
      const text = t('no_active_markets');
      try {
        await ctx.editMessageText(text, { reply_markup: backKeyboard('back_menu', t) });
      } catch {
        await ctx.reply(text, { reply_markup: backKeyboard('back_menu', t) });
      }
      return;
    }

    const totalPages = Math.max(1, Math.ceil(events.length / PAGE_SIZE));
    const safePage = Math.max(1, Math.min(page, totalPages));
    const startIndex = (safePage - 1) * PAGE_SIZE;
    const pageEvents = events.slice(startIndex, startIndex + PAGE_SIZE);

    const text = formatEventsList(pageEvents, safePage, totalPages, t);
    const keyboard = outcomesListKeyboard(pageEvents, safePage, totalPages, t);

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

export async function showEventOutcomes(ctx, hlClient, questionId) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');

  try {
    if (cachedEvents.length === 0) {
      await fetchAndCacheOutcomes(hlClient);
    }

    const event = cachedEvents.find(e => e.type === 'question' && e.questionId === questionId);
    if (!event) {
      try {
        await ctx.editMessageText(t('event_no_markets'), { reply_markup: backKeyboard('outcomes:page:1', t) });
      } catch {}
      return;
    }

    const text = formatEventOutcomes(event, t);
    const keyboard = eventOutcomesKeyboard(event, t);

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
  return cachedOutcomeMap.get(outcomeId) || null;
}

export function getCachedEvents() {
  return cachedEvents;
}
