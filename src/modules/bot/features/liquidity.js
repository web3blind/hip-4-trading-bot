import { randomBytes } from 'node:crypto';
import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import * as runtime from '../runtime.js';

// The coordinator is deliberately loaded only on entry: an unconfigured bot has
// no liquidity persistence, polling or exchange side effects.
const coordinator = () => import('../../liquidity/coordinator.js');
const fields = [
  ['coin', 'liq_coin'], ['durationMinutes', 'liq_duration'], ['budgetUsdc', 'liq_budget'],
  ['maxInventoryShares', 'liq_inventory'], ['orderSizeShares', 'liq_order_size'],
  ['minPrice', 'liq_min_price'], ['maxPrice', 'liq_max_price'], ['minSpread', 'liq_spread'],
  ['maxLossUsdc', 'liq_loss'], ['maxActions', 'liq_actions'],
];
const idOK = id => /^[a-zA-Z0-9_-]{8,48}$/.test(String(id));
const coinOK = value => /^#(?:[1-9]\d*|0)[01]$/.test(value) && Number.isSafeInteger(Number(value.slice(1)));
const numberOK = (field, n) => Number.isFinite(n) && n > 0 &&
  (field === 'maxActions' || field === 'durationMinutes' ? Number.isSafeInteger(n) : true) &&
  (field === 'minPrice' || field === 'maxPrice' ? n < 1 : true);
const clean = value => String(value ?? '').replace(/[<>\x00-\x1f]/g, '').slice(0, 80);
const reasons = new Set(['owner_stop', 'duration_or_market_expiry', 'action_limit', 'loss_stop',
  'budget_or_inventory', 'authorization_or_expiry', 'credential_revoked', 'restart_review_required']);
const statuses = new Set(['draft', 'active', 'observing', 'stopping', 'paused', 'recovery_required', 'error', 'stopped', 'expired']);
const statusLabel = (t, value) => statuses.has(value) ? t(`liq_state_${value}`) : t('liq_unknown');
const bindingMatches = policy => !!runtime.hlClient && policy?.network === runtime.hlClient.network &&
  String(policy.account).toLowerCase() === String(runtime.hlClient.address).toLowerCase();

export function createLiquidityFeature({ service = coordinator, now = Date.now } = {}) {
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
      .text(t('liq_live'), 'liq:new:live').row()
      .text(t('liq_campaigns'), 'liq:campaigns').row();
    try {
      const sessions = await (await service()).listLiquiditySessions();
      for (const s of (Array.isArray(sessions) ? sessions : []).slice(0, 12)) {
        if (idOK(s.id)) kb.text(`${clean(s.policy?.coin)} · ${statusLabel(t, s.status)}`.slice(0, 55), `liq:session:${s.id}`).row();
      }
    } catch { /* menu remains usable when storage is unavailable */ }
    kb.text(t('back'), 'back_menu');
    await screen(ctx, `${t('liq_title')}\n${t('liq_intro')}\n${t('liq_reward_notice')}`, kb);
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
    const kb = new InlineKeyboard().text(t('back'), `liq:back:${state.token}`).text(t('cancel'), 'liq:cancel');
    await screen(ctx, `${t('liq_step')} ${state.index + 1}/${fields.length}\n${t(field[1])}`, kb);
  }
  async function start(ctx, mode) {
    if (!await guard(ctx)) return;
    const t = await tr();
    if (!['observe', 'live'].includes(mode) || !runtime.hlClient?.address || !runtime.hlClient?.network) return failure(ctx, t);
    const state = { state: 'LIQUIDITY_INPUT', index: 0, token: randomBytes(8).toString('hex'),
      policy: { mode, account: runtime.hlClient.address.toLowerCase(), network: runtime.hlClient.network } };
    runtime.userStates.set(ctx.chat.id, state);
    await prompt(ctx, state);
  }
  async function input(ctx, state, text) {
    if (!await guard(ctx) || runtime.userStates.get(ctx.chat.id) !== state || state.state !== 'LIQUIDITY_INPUT') return;
    const t = await tr(), [field] = fields[state.index] || [];
    if (!field || !bindingMatches(state.policy)) {
      await runtime.invalidateUserState(ctx.chat.id);
      return screen(ctx, t('session_expired'), back(t));
    }
    const value = String(text ?? '').trim();
    if (field === 'coin' ? !coinOK(value) : !/^(?:0|[1-9]\d*)(?:\.\d{1,5})?$/.test(value) || !numberOK(field, Number(value))) {
      return ctx.reply(t('liq_invalid'));
    }
    state.policy[field] = field === 'coin' ? value : Number(value);
    state.index++;
    if (state.index < fields.length) return prompt(ctx, state);
    // Core validates again. This check prevents an obviously inconsistent review.
    const p = state.policy;
    if (p.minPrice >= p.maxPrice || p.orderSizeShares > p.maxInventoryShares || p.maxLossUsdc > p.budgetUsdc) {
      state.index = 0; state.policy = { mode: p.mode, account: p.account, network: p.network };
      await ctx.reply(t('liq_inconsistent'));
      return prompt(ctx, state);
    }
    runtime.userStates.delete(ctx.chat.id);
    try {
      const s = await (await service()).proposeLiquiditySession(p, { requestId: randomBytes(16).toString('hex') });
      return showReview(ctx, s.id);
    } catch (error) { return serviceFailure(ctx, t, error); }
  }
  async function stepBack(ctx, token) {
    if (!await guard(ctx)) return;
    const state = runtime.userStates.get(ctx.chat.id), t = await tr();
    if (state?.state !== 'LIQUIDITY_INPUT' || token !== state.token || !bindingMatches(state.policy)) return screen(ctx, t('session_expired'), back(t));
    state.index = Math.max(0, state.index - 1);
    delete state.policy[fields[state.index][0]];
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
      if (s.status === 'draft') kb.text(t('liq_review_button'), `liq:review:${id}`).row();
      if (['active', 'observing', 'stopping', 'paused', 'recovery_required', 'error'].includes(s.status)) kb.text(t('liq_stop'), `liq:stop:${id}`).row();
      kb.text(t('back'), 'liq:menu');
      const p = s.policy || {};
      const expiry = s.expiresAt ? new Date(s.expiresAt) : null;
      const e=s.exposure, stamp=e?.observedAt;
      const evidence=Number.isSafeInteger(stamp) ? `${t('liq_inventory_label')}: ${clean(e.shares)}\n${t('liq_spend_evidence')}: ${clean(e.spend)} USDC\n${t('liq_evidence_time')}: ${new Date(stamp).toISOString()}` : t('liq_inventory_unknown');
      const exposureText=`\n${evidence}`;
      await screen(ctx, `${t('liq_title')} · ${clean(p.coin)}\n${t('liq_status')}: ${statusLabel(t, s.status)}\n${t('liq_reason')}: ${reasons.has(s.reason) ? t(`liq_reason_${s.reason}`) : t('liq_unknown')}\n${t('liq_expiry')}: ${expiry && !Number.isNaN(expiry.getTime()) ? expiry.toISOString() : t('liq_unknown')}${exposureText}\n${t('liq_cleanup_note')}`, kb);
    } catch { await failure(ctx, t); }
  }
  async function showReview(ctx, id) {
    if (!await guard(ctx)) return;
    const t = await tr();
    if (!idOK(id)) return screen(ctx, t('session_expired'), back(t));
    try {
      const s = await (await service()).getLiquiditySession(id), p = s?.policy;
      if (!p || s.status !== 'draft' || !bindingMatches(p) || !['observe', 'live'].includes(p.mode)) return screen(ctx, t('session_expired'), back(t));
      const values = ['coin', 'network', 'durationMinutes', 'budgetUsdc', 'maxInventoryShares', 'orderSizeShares', 'minPrice', 'maxPrice', 'minSpread', 'maxLossUsdc', 'maxActions'];
      if (values.some(k => p[k] === undefined || p[k] === null)) return screen(ctx, t('liq_unavailable'), back(t));
      const callback = runtime.confirmationCallback(ctx.chat.id, 'confirm_liquidity_session', {
        state: 'CONFIRMING_LIQUIDITY_SESSION', sessionId: id, binding: runtime.runtimeBinding(),
      });
      const lines = [t('liq_review'), `${t('liq_mode')}: ${t(`liq_${p.mode}`)}`, ...values.map((key, i) => `${t(['liq_coin_label', 'liq_network', 'liq_duration_label', 'liq_budget_label', 'liq_inventory_label', 'liq_order_label', 'liq_min_label', 'liq_max_label', 'liq_spread_label', 'liq_loss_label', 'liq_actions_label'][i])}: ${clean(p[key])}`), t('liq_budget_rule'), t('liq_risk'), p.mode === 'observe' ? t('liq_observe_rule') : `${t('liq_live_rule')}\n${t('liq_reward_notice')}`];
      await screen(ctx, lines.join('\n'), new InlineKeyboard().text(t('liq_approve'), callback).row().text(t('cancel'), 'liq:cancel'));
    } catch { await failure(ctx, t); }
  }
  async function confirm(ctx) {
    if (!await guard(ctx)) return;
    const t = await tr(), state = runtime.userStates.get(ctx.chat.id);
    if (state?.state !== 'CONFIRMING_LIQUIDITY_SESSION' || state.binding !== runtime.runtimeBinding() || !idOK(state.sessionId)) return screen(ctx, t('session_expired'), back(t));
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
  return { menu, campaigns, start, input, stepBack, cancel, session, showReview, confirm, stop };
}

export async function showLiquiditySessionReview(ctx, id) {
  return createLiquidityFeature().showReview(ctx, id);
}
