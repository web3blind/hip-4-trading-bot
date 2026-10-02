import { randomBytes } from 'node:crypto';
import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import * as runtime from '../runtime.js';
import { fetchAndCacheOutcomes } from './outcomes.js';
import { OUTCOMES_PAGE_SIZE } from '../constants.js';

// The coordinator is deliberately loaded only on entry: an unconfigured bot has
// no liquidity persistence, polling or exchange side effects.
const coordinator = () => import('../../liquidity/coordinator.js');
const fields = [
  ['durationMinutes', 'liq_duration'], ['budgetUsdc', 'liq_budget'],
  ['orderSizeShares', 'liq_order_size'],
  ['minPrice', 'liq_min_price'], ['maxPrice', 'liq_max_price'], ['minSpread', 'liq_spread'],
  ['maxLossUsdc', 'liq_loss'], ['maxActions', 'liq_actions'],
];
const idOK = id => /^[a-zA-Z0-9_-]{8,48}$/.test(String(id));
const numberOK = (field, n) => Number.isFinite(n) && n > 0 &&
  (field === 'maxActions' || field === 'durationMinutes' ? Number.isSafeInteger(n) : true) &&
  (field === 'minPrice' || field === 'maxPrice' ? n < 1 : true);
const clean = value => String(value ?? '').replace(/[<>\x00-\x1f]/g, '').slice(0, 80);
const clientTokens=new WeakMap();
function clientToken(client) {if(!client || typeof client!=='object')return null;if(!clientTokens.has(client))clientTokens.set(client,randomBytes(16).toString('hex'));return clientTokens.get(client);}
const reasons = new Set(['owner_stop', 'duration_or_market_expiry', 'action_limit', 'loss_stop',
  'budget_or_inventory', 'authorization_or_expiry', 'credential_revoked', 'restart_review_required',
  'outside_order_cancellation','partial_leg','unresolved_leg']);
const statuses = new Set(['draft', 'active', 'observing', 'stopping', 'paused', 'recovery_required', 'error', 'stopped', 'expired']);
const statusLabel = (t, value) => statuses.has(value) ? t(`liq_state_${value}`) : t('liq_unknown');
const bindingMatches = policy => !!runtime.hlClient && policy?.network === runtime.hlClient.network &&
  String(policy.account).toLowerCase() === String(runtime.hlClient.address).toLowerCase();

export function createLiquidityFeature({ service = coordinator, now = Date.now } = {}) {
  const current = (ctx, state) => runtime.userStates.get(ctx.chat.id) === state &&
    bindingMatches(state.policy) && state.client === runtime.hlClient &&
    !runtime.runtimeTransitioning && now() < state.expiresAt;
  const sideName = (o, side, t) => /^(yes|no)$/i.test(o[`side${side}Name`] || '')
    ? t(side === 0 ? 'yes' : 'no') : clean(o[`side${side}Name`] || t(side === 0 ? 'yes' : 'no'));
  const outcomeName = o => clean(o.displayName || o.name || o.question);
  const eventKey = e => `${e.type}:${e.type === 'question' ? e.questionId : e.outcomeId}`;
  async function catalogScreen(ctx, state, events, view = { level: 'events', page: 1 }) {
    const t = await tr();
    if (!current(ctx, state)) return;
    state.state = 'LIQUIDITY_CATALOG'; state.view = view; state.token = randomBytes(8).toString('hex');
    state.choices = [];
    const kb = new InlineKeyboard();
    const add = (label, action) => { const index = state.choices.push(action) - 1; kb.text(label.slice(0, 60), `liq:pick:${state.token}:${index}`).row(); };
    const list=events,pages=Math.max(1,Math.ceil(list.length/OUTCOMES_PAGE_SIZE));
    view.page=Math.min(pages,Math.max(1,view.page));
    let title=`${t('liq_select_event')}\n${view.page}/${pages}`;
    if(!list.length) title+=`\n${t('no_active_markets')}`;
    for(const item of list.slice((view.page-1)*OUTCOMES_PAGE_SIZE,view.page*OUTCOMES_PAGE_SIZE))
      add(clean(item.name),{kind:'event',event:eventKey(item)});
    if(view.page>1) add(t('liq_previous'),{kind:'view',view:{level:'events',page:view.page-1}});
    if(view.page<pages) add(t('liq_next'),{kind:'view',view:{level:'events',page:view.page+1}});
    add(t('back'),{kind:'menu'});
    add(t('cancel'), { kind: 'cancel' });
    await screen(ctx, `${title}\n${t('liq_catalog_note')}`, kb);
  }
  async function choose(ctx, data) {
    if (!await guard(ctx)) return;
    const state = runtime.userStates.get(ctx.chat.id), t = await tr();
    const m = /^liq:pick:([0-9a-f]{16}):(0|[1-9]\d*)$/.exec(data);
    if (!m || state?.state !== 'LIQUIDITY_CATALOG' || !current(ctx, state) || m[1] !== state.token || !state.choices[Number(m[2])])
      return screen(ctx, t('session_expired'), back(t));
    const action = state.choices[Number(m[2])];
    state.token = randomBytes(8).toString('hex'); // consume before asynchronous refresh
    const token = state.token;
    if (action.kind === 'cancel') return cancel(ctx);
    if (action.kind === 'menu') { await runtime.invalidateUserState(ctx.chat.id); return menu(ctx); }
    try {
      const events = await fetchAndCacheOutcomes(state.client);
      if (!current(ctx, state) || state.token !== token) return;
      if (action.kind === 'view') {
        if (state.view.level === 'events') state.eventPage = state.view.page;
        if (state.view.level === 'outcomes') state.outcomePage = state.view.page;
        return catalogScreen(ctx, state, events, action.view);
      }
      const event=events.find(e=>eventKey(e)===action.event);
      if(!event) return failure(ctx,t);
      state.selection={event:clean(event.name)};
      state.policy.event={type:event.type,id:event.type==='question'?event.questionId:event.outcomeId};
      state.state='LIQUIDITY_INPUT';state.index=0;
      return prompt(ctx, state);
    } catch { if (current(ctx, state)) { await runtime.invalidateUserState(ctx.chat.id); await failure(ctx, t); } }
  }
  async function tr() { return getTranslator((await loadConfig()).language || 'en'); }
  async function screen(ctx, text, keyboard) {
    const extra = { reply_markup: keyboard };
    try { await ctx.editMessageText(text, extra); } catch { await ctx.reply(text, extra); }
  }
  const back = (t, target = 'liq:menu') => new InlineKeyboard().text(t('back'), target);
  async function guard(ctx) {
    if (!runtime.isAuthorizedPrivateContext(ctx) || runtime.runtimeTransitioning) return false;
    return true;
  }
  async function failure(ctx, t) { await screen(ctx, t('liq_unavailable'), back(t)); }
  async function serviceFailure(ctx, t, error) {
    const message = error?.message;
    const category = ['Short-expiry price market not supported live', 'Unavailable USDC outcome',
      'Settled outcome', 'Market expiry unavailable or inside safety buffer',
      'Decision cutoff unavailable or near', 'Market expiry near'].includes(message) ? 'liq_market_blocked'
      : ['Existing inventory', 'Foreign orders or unavailable open orders',
        'Account has unresolved liquidity session', 'Outcome belongs to another bundle'].includes(message) ? 'liq_account_blocked'
      : /^Invalid (?:durationMinutes|budgetUsdc|maxInventoryShares|orderSizeShares|minPrice|maxPrice|minSpread|maxLossUsdc|maxActions|liquidity policy fields)$/.test(message || '') || message === 'Inconsistent liquidity bounds' ? 'liq_limits_blocked'
      : null;
    await screen(ctx, category ? t(category) : t('liq_unavailable'), back(t));
  }
  async function menu(ctx) {
    if (!await guard(ctx)) return;
    const t = await tr(), kb = new InlineKeyboard()
      .text(t('liq_observe'), 'liq:new:observe').row()
      .text(t('liq_live'), 'liq:new:live').row();
    try {
      const sessions = await (await service()).listLiquiditySessions();
      for (const s of (Array.isArray(sessions) ? sessions : []).slice(0, 12)) {
        if (idOK(s.id)) kb.text(`${clean(s.eventLabel || s.policy?.coin)} · ${statusLabel(t, s.status)}`.slice(0, 55), `liq:session:${s.id}`).row();
      }
    } catch { /* menu remains usable when storage is unavailable */ }
    kb.text(t('back'), 'back_menu');
    await screen(ctx, `${t('liq_title')}\n${t('liq_intro')}`, kb);
  }
  async function campaigns(ctx) {
    if (!await guard(ctx)) return;
    const t = await tr();
    try {
      const result = await (await service()).getLiquidityCampaigns();
      const h=result?.history;
      if(!h?.available) return screen(ctx, t('liq_campaign_unavailable'), back(t));
      const lines=[t('liq_history_title'),t('liq_history_warning'),`${t('liq_history_fetched')}: ${clean(h.fetchedAt)}`];
      for(const p of h.periods.slice(0,8)) lines.push(`${clean(p.marketId)} · ${clean(p.epochEndDate||p.finalizedAt)}\n${t('liq_history_awarded')}: ${clean(p.awardedUsdc)} USDC; ${t('liq_history_paid')}: ${clean(p.paidUsdc)} USDC`);
      lines.push(t('liq_history_subset'),h.source);
      await screen(ctx, lines.join('\n\n'), back(t));
    } catch { await screen(ctx, t('liq_campaign_unavailable'), back(t)); }
  }
  async function prompt(ctx, state) {
    const t = await tr(), field = fields[state.index];
    if (!current(ctx, state)) return;
    state.token = randomBytes(8).toString('hex');
    const kb = new InlineKeyboard().text(t('back'), `liq:back:${state.token}`).text(t('cancel'), 'liq:cancel');
    await screen(ctx, `${t('liq_step')} ${state.index + 1}/${fields.length}\n${t(field[1])}`, kb);
  }
  async function start(ctx, mode) {
    if (!await guard(ctx)) return;
    if (!['observe', 'live'].includes(mode) || !runtime.hlClient?.address || !runtime.hlClient?.network) return failure(ctx, await tr());
    const state = { state: 'LIQUIDITY_CATALOG', index: 0, token: randomBytes(8).toString('hex'),
      client: runtime.hlClient, expiresAt: now() + 15 * 60_000,
      policy: { mode, account: runtime.hlClient.address.toLowerCase(), network: runtime.hlClient.network } };
    runtime.userStates.set(ctx.chat.id, state);
    const t = await tr();
    if (!current(ctx, state)) return;
    try {
      const events = await fetchAndCacheOutcomes(state.client);
      if (current(ctx, state)) await catalogScreen(ctx, state, events);
    } catch { if (current(ctx, state)) { await runtime.invalidateUserState(ctx.chat.id); await failure(ctx, t); } }
  }
  async function input(ctx, state, text) {
    if (!await guard(ctx) || runtime.userStates.get(ctx.chat.id) !== state || state.state !== 'LIQUIDITY_INPUT') return;
    const index = state.index;
    const t = await tr();
    if (runtime.userStates.get(ctx.chat.id) !== state || state.state !== 'LIQUIDITY_INPUT' || state.index !== index) return;
    const [field] = fields[index] || [];
    if (!field || !current(ctx, state)) {
      await runtime.invalidateUserState(ctx.chat.id);
      return screen(ctx, t('session_expired'), back(t));
    }
    const value = String(text ?? '').trim();
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,5})?$/.test(value) || !numberOK(field, Number(value))) {
      return ctx.reply(t('liq_invalid'));
    }
    state.policy[field] = Number(value);
    delete state.policy.maxInventoryShares;
    state.index++;
    if (state.index < fields.length) return prompt(ctx, state);
    // Core validates again. This check prevents an obviously inconsistent review.
    const p = state.policy;
    // Budget / minimum price bounds all budget-feasible buys. Round up so a
    // fractional holding is not cut short; retain the policy's 1..1e6 safety cap.
    // Core still rejects unsupported monetary inputs and enforces spend + fees.
    p.maxInventoryShares = Math.min(1_000_000, Math.max(1, Math.ceil(p.budgetUsdc / p.minPrice)));
    if (p.minPrice >= p.maxPrice || p.orderSizeShares > p.maxInventoryShares || p.maxLossUsdc > p.budgetUsdc) {
      state.index = 0; state.policy = { mode: p.mode, account: p.account, network: p.network, event: p.event };
      await ctx.reply(t('liq_inconsistent'));
      return prompt(ctx, state);
    }
    state.state = 'LIQUIDITY_PROPOSING';
    try {
      const s = await (await service()).proposeLiquiditySession(p, { requestId: randomBytes(16).toString('hex') });
      if (!current(ctx, state)) {await (await service()).stopLiquiditySession(s.id,{ownerId:ctx.from.id,reason:'owner_stop'});return;}
      return showReview(ctx, s.id, state);
    } catch (error) { if (current(ctx, state)) { await runtime.invalidateUserState(ctx.chat.id); return serviceFailure(ctx, t, error); } }
  }
  async function stepBack(ctx, token) {
    if (!await guard(ctx)) return;
    const state = runtime.userStates.get(ctx.chat.id), t = await tr();
    if (state?.state !== 'LIQUIDITY_INPUT' || token !== state.token || !current(ctx, state)) return screen(ctx, t('session_expired'), back(t));
    if (state.index === 0) {
      delete state.policy.event;
      state.state = 'LIQUIDITY_CATALOG'; state.token = randomBytes(8).toString('hex');
      try { return await catalogScreen(ctx, state, await fetchAndCacheOutcomes(state.client), { level: 'events', page: state.eventPage || 1 }); }
      catch { if (current(ctx, state)) await failure(ctx, t); return; }
    }
    state.index = Math.max(0, state.index - 1);
    delete state.policy[fields[state.index][0]];
    delete state.policy.maxInventoryShares;
    await prompt(ctx, state);
  }
  async function cancel(ctx) {
    if (!await guard(ctx)) return;
    await runtime.invalidateUserState(ctx.chat.id);
    const t = await tr();
    await screen(ctx, t('liq_cancelled'), back(t));
  }
  async function session(ctx, id) {
    if (!await guard(ctx)) return;
    const t = await tr();
    if (!idOK(id)) return screen(ctx, t('session_expired'), back(t));
    try {
      const s = await (await service()).getLiquiditySession(id);
      if (!s) return screen(ctx, t('session_expired'), back(t));
      const kb = new InlineKeyboard();
      if (s.status === 'draft' && s.policy?.event) kb.text(t('liq_review_button'), `liq:review:${id}`).row();
      if (['active', 'observing', 'stopping', 'paused', 'recovery_required', 'error'].includes(s.status) || s.orders?.some(o=>!['closed','rejected','aborted'].includes(o.state))) kb.text(t('liq_stop'), `liq:stop:${id}`).row();
      kb.text(t('back'), 'liq:menu');
      const p = s.policy || {};
      const expiry = s.expiresAt ? new Date(s.expiresAt) : null;
      const e=s.exposure, stamp=e?.observedAt;
      const evidence=Number.isSafeInteger(stamp) ? `${t('liq_inventory_label')}: ${clean(e.shares)}\n${t('liq_spend_evidence')}: ${clean(e.spend)} USDC\n${t('liq_evidence_time')}: ${new Date(stamp).toISOString()}` : t('liq_inventory_unknown');
      const exposureText=`\n${evidence}`;
      await screen(ctx, `${t('liq_title')} · ${clean(s.eventLabel || p.coin)}\n${t('liq_status')}: ${statusLabel(t, s.status)}\n${t('liq_reason')}: ${reasons.has(s.reason) ? t(`liq_reason_${s.reason}`) : t('liq_unknown')}\n${t('liq_expiry')}: ${expiry && !Number.isNaN(expiry.getTime()) ? expiry.toISOString() : t('liq_unknown')}${exposureText}\n${t('liq_cleanup_note')}`, kb);
    } catch { await failure(ctx, t); }
  }
  async function showReview(ctx, id, expectedState) {
    const binding = runtime.runtimeBinding(), client = runtime.hlClient;
    if (!await guard(ctx)) return false;
    if (expectedState && runtime.userStates.get(ctx.chat.id) !== expectedState) return false;
    let reviewState = { state: 'LIQUIDITY_REVIEW_LOADING', selection: expectedState?.selection };
    runtime.userStates.set(ctx.chat.id, reviewState);
    const t = await tr();
    const stillHere = () => runtime.userStates.get(ctx.chat.id) === reviewState &&
      runtime.runtimeBinding() === binding && runtime.hlClient === client && !runtime.runtimeTransitioning;
    if (!stillHere()) return false;
    if (!idOK(id)) { await screen(ctx, t('session_expired'), back(t)); return false; }
    try {
      const api=await service();
      let s=await api.getLiquiditySession(id);
      if(s?.policy?.event && api.assessLiquiditySession) s=await api.assessLiquiditySession(id);
      const p=s?.policy;
      if(!stillHere()) return false;
      if(!p || s.status!=='draft' || !bindingMatches(p) || !p.event) { await screen(ctx,t('session_expired'),back(t)); return false; }
      const a=s.assessment;
      const values=['network','durationMinutes','budgetUsdc','maxInventoryShares','orderSizeShares','minPrice','maxPrice','minSpread','maxLossUsdc','maxActions'];
      if(!a || values.some(k=>p[k]==null)) { await screen(ctx,t('liq_unavailable'),back(t)); return false; }
      const lines=[t('liq_review'),clean(s.eventLabel),`${t('liq_mode')}: ${t(`liq_${p.mode}`)}`,
        t('liq_all_sides'),...a.legs.map(l=>`${clean(l.name)} · ${clean(l.sideName)} (${clean(l.coin)})${l.fallback?' · '+t('liq_fallback'):''}`),
        `${t('liq_suitability')}: ${t('liq_suitability_'+a.suitability)}`,
        `${t('liq_minimum_budget')}: ${a.minimumBudgetUsdc==null?t('liq_unknown'):a.minimumBudgetUsdc.toFixed(2)} USDC`,
        `${t('liq_required_budget')}: ${a.requiredBudgetUsdc==null?t('liq_unknown'):a.requiredBudgetUsdc.toFixed(2)} USDC`,
        `${t('liq_spendable_spot')}: ${a.availableUsdc==null?t('liq_unknown'):a.availableUsdc.toFixed(2)} USDC`,
        `${t('liq_quote_deadline')}: ${a.legs.every(l=>Number.isSafeInteger(l.expiry))?new Date(Math.min(...a.legs.map(l=>l.expiry))-3600000).toISOString():t('liq_unknown')}`,
        ...a.reasons.map(r=>{const leg=a.legs.find(l=>l.coin===r.coin);return `${r.coin?(leg?`${clean(leg.name)} · ${clean(leg.sideName)} (${clean(r.coin)})`:clean(r.coin))+' · ':''}${t('liq_assessment_'+r.code)}${r.detail?' · '+clean(r.detail):''}`;}),
        ...a.legs.filter(l=>!l.unavailable).map(l=>`${clean(l.name)} · ${clean(l.sideName)} (${clean(l.coin)}) · ${t('liq_minimum_shares')}: ${l.minimumShares}; ${t('liq_order_label')}: ${l.size}`),
        ...(a.pairs||[]).filter(p=>!p.unavailable).map(p=>`${clean(a.legs.find(l=>l.outcomeId===p.outcomeId)?.name)} · ${t('liq_pair_net_edge')}: ${p.netMatchedEdgePerShare.toFixed(5)}`),
        ...values.map((key,i)=>`${t(['liq_network','liq_duration_label','liq_budget_label','liq_inventory_label','liq_order_label','liq_min_label','liq_max_label','liq_spread_label','liq_loss_label','liq_actions_label'][i])}: ${clean(p[key])}`),
        ...(expectedState?.state==='LIQUIDITY_PROPOSING'?[t('liq_inventory_auto_note')]:[]),
        t('liq_budget_rule'),t('liq_risk'),t('liq_merged_book'),p.mode==='observe'?t('liq_observe_rule'):t('liq_live_rule')];
      if(!stillHere()) return false;
      const chunks=[];let part='';for(const line of lines){if(part.length+line.length+1>3500){chunks.push(part);part='';}part+=(part?'\n':'')+line;}if(part)chunks.push(part);
      for(const chunk of chunks.slice(0,-1)){if(!stillHere())return false;await ctx.reply(chunk);}
      if(!stillHere())return false;
      const kb=new InlineKeyboard();
      if(a.suitability==='conditional') {
        const callback=runtime.confirmationCallback(ctx.chat.id,'confirm_liquidity_session',{state:'CONFIRMING_LIQUIDITY_SESSION',sessionId:id,binding:runtime.runtimeBinding(),clientToken:clientToken(runtime.hlClient)});
        // Confirmation installs its own unique snapshot; retain ownership so a
        // failed send can clear only this review, never a newer wizard.
        reviewState=runtime.userStates.get(ctx.chat.id);
        kb.text(t('liq_approve'),callback).row();
      }
      kb.text(t('cancel'),'liq:cancel');
      await screen(ctx,chunks.at(-1),kb);
      return stillHere();
    } catch {
      if(stillHere()) {
        try { await failure(ctx, t); }
        finally {
          if(runtime.userStates.get(ctx.chat.id)===reviewState) await runtime.invalidateUserState(ctx.chat.id);
        }
      }
      return false;
    }
  }
  async function confirm(ctx) {
    if (!await guard(ctx)) return;
    const t = await tr(), state = runtime.userStates.get(ctx.chat.id);
    if (state?.state !== 'CONFIRMING_LIQUIDITY_SESSION' || state.binding !== runtime.runtimeBinding() || state.clientToken !== clientToken(runtime.hlClient) || !idOK(state.sessionId)) return screen(ctx, t('session_expired'), back(t));
    try {
      const api = await service(), s = await api.getLiquiditySession(state.sessionId);
      if (runtime.userStates.get(ctx.chat.id) !== state || !s || s.status !== 'draft' || !bindingMatches(s.policy) || runtime.runtimeTransitioning) return screen(ctx, t('session_expired'), back(t));
      await api.approveLiquiditySession(state.sessionId, { ownerId: ctx.from.id });
      await session(ctx, state.sessionId);
    } catch (error) { await serviceFailure(ctx, t, error); }
    finally { await runtime.invalidateUserState(ctx.chat.id); }
  }
  async function stop(ctx, id) {
    if (!await guard(ctx)) return;
    const t = await tr();
    if (!idOK(id)) return screen(ctx, t('session_expired'), back(t));
    try {
      await (await service()).stopLiquiditySession(id, { ownerId: ctx.from.id });
      await session(ctx, id);
    } catch { await failure(ctx, t); }
  }
  return { menu, campaigns, start, choose, input, stepBack, cancel, session, showReview, confirm, stop };
}

export async function showLiquiditySessionReview(ctx, id, expectedState) {
  return createLiquidityFeature().showReview(ctx, id, expectedState);
}
