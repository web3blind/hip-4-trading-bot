import { randomBytes } from 'node:crypto';
import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import * as runtime from '../runtime.js';
import { liquidityCatalogue } from '../../liquidity/catalog.js';
import { OUTCOMES_PAGE_SIZE } from '../constants.js';
import { liquidityDisplaySide } from '../../liquidity/labels.js';
import {safeLogError} from '../../logger.js';

// The coordinator is deliberately loaded only on entry: an unconfigured bot has
// no liquidity persistence, polling or exchange side effects.
const coordinator = () => import('../../liquidity/coordinator.js');
const fields = [
  ['durationMinutes', 'liq_duration'], ['budgetUsdc', 'liq_budget'],
  ['maxLossUsdc', 'liq_loss'],
];
const idOK = id => /^[a-zA-Z0-9_-]{8,48}$/.test(String(id));
const numberOK = (field, n) => Number.isFinite(n) && n > 0 &&
  (field !== 'durationMinutes' || Number.isSafeInteger(n));
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
    (!state.loading||state.loadingMode===state.policy.mode) &&
    !runtime.runtimeTransitioning && now() < state.expiresAt;
  const sideName = (o, side, t) => /^(yes|no)$/i.test(o[`side${side}Name`] || '')
    ? t(side === 0 ? 'yes' : 'no') : clean(o[`side${side}Name`] || t(side === 0 ? 'yes' : 'no'));
  const outcomeName = o => clean(o.displayName || o.name || o.question);
  const eventKey = e => `${e.type}:${e.type === 'question' ? e.questionId : e.outcomeId}`;
  async function catalogScreen(ctx, state, events, view = { level: 'events', page: 1 }) {
    const expectedToken=state.token,t = await tr();
    if (!current(ctx, state) || state.token!==expectedToken) return;
    if(now()>events.validUntil)throw Object.assign(Error('Catalogue evidence expired'),{code:'catalogue_unknown',stage:'publication'});
    state.state = 'LIQUIDITY_CATALOG'; state.view = view; state.token = randomBytes(8).toString('hex');
    state.loading=false;delete state.loadingNavigation;
    state.navigationToken = state.token; // visible Back/Cancel survive a consumed pick while loading
    state.choices = [];state.catalogLabels=Object.fromEntries(events.map(item=>[eventKey(item),clean(item.name)]));
    const kb = new InlineKeyboard();
    const add = (label, action) => { const index = state.choices.push(action) - 1; kb.text(label.slice(0, 60), `liq:pick:${state.token}:${index}`).row(); };
    const automatic=events.discovery?.automatic;
    if(events.discovery?.transportErrors)safeLogError('liquidity:catalogue',new Error('Catalogue loading failed'),{stage:'books',code:'catalogue_api'});
    const list=events,pages=events.pagination?.pages||Math.max(1,Math.ceil(list.length/OUTCOMES_PAGE_SIZE));
    if(!events.discovery?.indexed&&events.pagination)view.page=events.pagination.page;
    view.page=Math.min(pages,Math.max(1,view.page));
    let title=automatic?t('liq_select_event'):`${t('liq_select_event')}\n${events.pagination?t('liq_candidate_window')+' ':''}${view.page}/${pages}`;
    if(!list.length) title+=`\n${t(events.summary?.unknown||automatic&&events.summary?.unscanned?'liq_catalog_terminal_unknown':events.pagination&&events.summary?.unscanned?'liq_catalog_page_empty':'liq_no_sufficient_books')}`;
    if(!list.length&&events.summary?.livePriceUnsupported)title+=`\n${t('liq_assessment_live_price_unsupported')}`;

    if(events.summary?.partial)title+=`\n${t('liq_catalog_partial')}`;
    for(const item of list.slice(events.pagination?0:(view.page-1)*OUTCOMES_PAGE_SIZE,events.pagination?list.length:view.page*OUTCOMES_PAGE_SIZE))
      add(clean(item.name),{kind:'event',event:eventKey(item)});

    if(automatic){
      // Store only qualified page positions, never eligibility or book/fee proof.
      if(events.discovery?.indexed&&state.catalogIndex?.length&&view.page>1)add(t('liq_previous'),{kind:'view',view:{level:'events',page:view.page-1}});
      if(!events.discovery?.inProgress&&view.page*OUTCOMES_PAGE_SIZE<(state.catalogIndex?.length||0))add(t('liq_next'),{kind:'view',view:{level:'events',page:view.page+1}});
    }
    add(t('back'),{kind:'menu'});
    add(t('cancel'), { kind: 'cancel' });
    await screen(ctx, `${title}\n${t('liq_catalog_note')}`, kb, state);
  }
  async function finishCatalogNavigation(ctx,state) {
    const token=state.token,t=await tr();
    if(!current(ctx,state)||state.token!==token)return;
    // Update ONLY controls on the page already shown. Its labels are not new
    // eligibility proof; every event pick/page still obtains fresh complete data.
    const kb=new InlineKeyboard(),choices=state.choices.filter(a=>a.kind==='event');
    for(const [i,action] of choices.entries()) {
      const ref=state.catalogIndex.find(r=>`${r.type}:${r.id}`===action.event);
      // Preserve the already-rendered label from the initial qualified result.
      kb.text(clean(state.catalogLabels?.[action.event]||String(ref?.id)).slice(0,60),`liq:pick:${token}:${i}`).row();
    }
    const add=(label,action)=>{const i=choices.push(action)-1;kb.text(label,`liq:pick:${token}:${i}`).row();};
    if(state.catalogIndex.length>OUTCOMES_PAGE_SIZE)add(t('liq_next'),{kind:'view',view:{level:'events',page:2}});
    add(t('back'),{kind:'menu'});add(t('cancel'),{kind:'cancel'});
    state.choices=choices;
    await ctx.editMessageReplyMarkup({reply_markup:kb},AbortSignal.timeout(10000));
  }
  async function discoverScreen(ctx,state,view={level:'events',page:1},deadline=performance.now()+90000) {
    const run={};state.discoveryRun=run;const mode=state.policy.mode;let firstPublished=false,firstResult;
    const still=()=>current(ctx,state)&&state.discoveryRun===run&&state.policy.mode===mode;
    try {
    const args={automatic:true,mode,now,isCurrent:still,timeoutMs:Math.max(1,deadline-performance.now())};
    if(state.catalogIndex?.length){
      const events=await liquidityCatalogue(state.client,{...args,candidates:state.catalogIndex.slice((view.page-1)*OUTCOMES_PAGE_SIZE,view.page*OUTCOMES_PAGE_SIZE),cursor:state.catalogCursor});
      if(still()&&events.discovery.bindingReset){delete state.catalogIndex;delete state.catalogCursor;return discoverScreen(ctx,state,undefined,deadline);}
      if(still()){events.discovery.indexed=true;events.pagination={page:view.page,pages:Math.ceil(state.catalogIndex.length/OUTCOMES_PAGE_SIZE)};await catalogScreen(ctx,state,events,view);}return;
    }
    const result=await liquidityCatalogue(state.client,{...args,onQualified:async events=>{
      if(!still())return;
      firstPublished=true;firstResult=events;events.discovery.indexed=true;events.pagination={page:1,pages:1};
      await catalogScreen(ctx,state,events,{level:'events',page:1});
    }});
    if(!still())return;
    const index=result.discovery.index;
    if(index?.length){
      // A complete discovery index contains IDs only. Every visible page gets
      // fresh metadata, both mandatory books, fees and unchanged admission again.
      state.catalogIndex=index;state.catalogCursor=result.cursor;
      const remaining=deadline-performance.now();
      if(remaining<=0)return firstPublished?await finishCatalogNavigation(ctx,state):undefined;
      if(now()<=firstResult?.validUntil&&index.slice(0,OUTCOMES_PAGE_SIZE).every(ref=>firstResult.some(e=>eventKey(e)===`${ref.type}:${ref.id}`))){
        firstResult.discovery.inProgress=false;firstResult.pagination={page:1,pages:Math.ceil(index.length/OUTCOMES_PAGE_SIZE)};
        return await catalogScreen(ctx,state,firstResult,{level:'events',page:1});
      }
      const remainingBooks=1200-result.discovery.bookReads;
      if(remainingBooks<=0)return firstPublished?await finishCatalogNavigation(ctx,state):undefined;
      try {
        const events=await liquidityCatalogue(state.client,{...args,candidates:index.slice(0,OUTCOMES_PAGE_SIZE),cursor:result.cursor,timeoutMs:remaining,maxDiscoveryBooks:remainingBooks});
        if(still()){events.discovery.indexed=true;events.summary.partial ||= result.summary.partial;events.pagination={page:1,pages:Math.ceil(index.length/OUTCOMES_PAGE_SIZE)};await catalogScreen(ctx,state,events,{level:'events',page:1});}
      }catch(error){if(!firstPublished)throw error;} // Keep the already-published page; selection still rechecks.
    }else await catalogScreen(ctx,state,result,view);
    } finally {if(state.discoveryRun===run)delete state.discoveryRun;}
  }
  function runCatalogue(ctx,state,work,t,action) {
    // Grammy's native long polling handles updates sequentially. Only this
    // read-only, state-owned task may yield the handler so Cancel can arrive.
    // Financial confirmation/execution handlers remain awaited as before.
    const task=Promise.resolve().then(work).catch(async error=>{
      try {
        if(error?.code!=='catalogue_superseded'&&current(ctx,state)&&state.catalogueTask===task)await catalogueFailure(ctx,state,t,error,action);
      } catch {
        safeLogError('liquidity:catalogue',new Error('Catalogue terminal render failed'),{stage:'publication',code:'catalogue_api'});
      }
    }).finally(async()=>{
      if(state.catalogueTask!==task)return;
      delete state.catalogueTask;
      // A selected empty/unknown result ends the wizard only AFTER its actual
      // publication settles. Never invalidate from inside our owned task (that
      // would self-await), or discard ownership while Telegram is still editing.
      if(state.catalogueTerminal&&runtime.userStates.get(ctx.chat.id)===state)
        await runtime.invalidateUserState(ctx.chat.id);
    });
    state.catalogueTask=task;
    // Observe the complete chain, including terminal rendering and cleanup.
    // Direct/financial handlers retain their normal awaited error behavior.
    if(ctx.liquidityCatalogueAsync)void task.catch(()=>{});
    return ctx.liquidityCatalogueAsync?undefined:task;
  }
  async function choose(ctx, data) {
    if (!await guard(ctx)) return;
    const state = runtime.userStates.get(ctx.chat.id), t = await tr();
    const m = /^liq:pick:([0-9a-f]{16}):(0|[1-9]\d*)$/.exec(data);
    const priorNavigation=m&&state?.loadingNavigation?.token===m[1]&&state.loadingNavigation.choices[Number(m[2])];
    const action = priorNavigation || m && state?.choices?.[Number(m[2])];
    const visibleNavigation = action && ['cancel','menu'].includes(action.kind) && (m[1] === state.navigationToken||priorNavigation);
    if (!m || state?.state !== 'LIQUIDITY_CATALOG' || !current(ctx, state) || !action || m[1] !== state.token && !visibleNavigation)
      return state?.loading&&current(ctx,state)?undefined:screen(ctx, t('session_expired'), back(t));
    state.token = randomBytes(8).toString('hex'); // consume before asynchronous refresh
    delete state.discoveryRun; // any genuine owner choice cancels the request-lifetime discovery
    if(state.catalogueTask)await state.catalogueTask;
    const token = state.token;
    if (action.kind === 'cancel') return cancel(ctx);
    if (action.kind === 'menu') { await runtime.invalidateUserState(ctx.chat.id); return menu(ctx); }
    try {
      await loading(ctx,state,t);
      if(action.kind==='view')return runCatalogue(ctx,state,()=>discoverScreen(ctx,state,action.view),t,action);
      return runCatalogue(ctx,state,async()=>{
      const selected={type:action.event.split(':')[0],id:Number(action.event.split(':')[1])};
      const events = await liquidityCatalogue(state.client,{selected,automatic:true,mode:state.policy.mode,now,isCurrent:()=>current(ctx,state)&&state.token===token});
      if (!current(ctx, state) || state.token !== token) return;
      const event=events.find(e=>eventKey(e)===action.event);
      if(!event) {
        state.catalogueTerminal=true;
        return await screen(ctx,t(events.summary?.unknown?'liq_catalog_terminal_unknown':'liq_no_sufficient_books'),back(t),state);
      }
      state.eventPage=state.view.page;
      state.selection={event:clean(event.name)};
      state.policy.event={type:event.type,id:event.type==='question'?event.questionId:event.outcomeId};
      state.index=0;
      return await prompt(ctx, state, {events,token});
      },t,action);
    } catch(error) { if (current(ctx, state) && state.token===token) await catalogueFailure(ctx,state,t,error,action); }
  }
  async function tr() { return getTranslator((await loadConfig()).language || 'en'); }
  async function screen(ctx, text, keyboard, state) {
    if(state&&!current(ctx,state))return;
    const extra = { reply_markup: keyboard };
    // One total 10s native transport budget, including edit -> reply fallback.
    // Do not race-and-forget the request: drain its real promise before Cancel.
    const signal=state?AbortSignal.timeout(10000):undefined;
    try { await ctx.editMessageText(text, extra, signal); } catch(error) {
      if(signal?.aborted)throw error;
      if(state&&!current(ctx,state))return;
      await ctx.reply(text, extra, signal);
    }
  }
  async function loading(ctx,state,t,key='liq_catalog_loading') {
    state.loading=true;state.loadingMode=state.policy.mode;
    state.loadingNavigation={token:state.navigationToken,choices:state.choices.map(a=>['menu','cancel'].includes(a.kind)?a:undefined)};
    state.navigationToken=state.token;state.choices=[{kind:'menu'},{kind:'cancel'}];
    await screen(ctx,t(key),new InlineKeyboard().text(t('back'),`liq:pick:${state.token}:0`).text(t('cancel'),`liq:pick:${state.token}:1`));
  }
  const back = (t, target = 'liq:menu') => new InlineKeyboard().text(t('back'), target);
  async function guard(ctx) {
    if (!runtime.isAuthorizedPrivateContext(ctx) || runtime.runtimeTransitioning) return false;
    return true;
  }
  async function failure(ctx, t) { await screen(ctx, t('liq_unavailable'), back(t)); }
  async function catalogueFailure(ctx,state,t,error,action={kind:'view',view:{level:'events',page:state.eventPage||1}}) {
    if(!current(ctx,state))return;
    const code=['catalogue_api','catalogue_unknown','catalogue_deadline'].includes(error?.code)?error.code:'catalogue_api';
    const stage=['metadata','fees','books','candidate_refresh','publication'].includes(error?.stage)?error.stage:'publication';
    // Never log upstream messages, payloads, account, callback or policy fields.
    safeLogError('liquidity:catalogue',new Error('Catalogue loading failed'),{stage,code});
    state.state='LIQUIDITY_CATALOG';state.view=action.view||state.view||{level:'events',page:1};
    state.token=randomBytes(8).toString('hex');state.navigationToken=state.token;
    state.loading=false;delete state.loadingNavigation;
    state.choices=[{kind:'menu'},{kind:'cancel'}];
    const kb=new InlineKeyboard().text(t('back'),`liq:pick:${state.token}:0`).text(t('cancel'),`liq:pick:${state.token}:1`);
    await screen(ctx,t('liq_catalog_terminal_unknown'),kb,state);
  }
  async function serviceFailure(ctx, t, error, keyboard=back(t)) {
    if(error?.assessment) {
      const a=error.assessment;
      const rows=a.reasons.map(r=>{const l=a.legs.find(l=>l.coin===r.coin);return `${l?`${clean(l.name)} · ${clean(liquidityDisplaySide(l.sideName,t))} (${clean(l.coin)}) · `:''}${t('liq_assessment_'+(r.subreason==='live_price_unsupported'?r.subreason:r.code))}`;});
      const state=runtime.userStates.get(ctx.chat.id),binding=runtime.runtimeBinding(),client=runtime.hlClient;
      const chunks=[];let part='';
      for(const row of [t('liq_suitability_'+a.suitability),...rows]){if(part.length+row.length+1>3500){chunks.push(part);part='';}part+=(part?'\n':'')+row;}if(part)chunks.push(part);
      const stillHere=()=>runtime.userStates.get(ctx.chat.id)===state && runtime.runtimeBinding()===binding && runtime.hlClient===client && !runtime.runtimeTransitioning;
      for(const chunk of chunks.slice(0,-1)){if(!stillHere())return;await ctx.reply(chunk);}
      if(stillHere())return screen(ctx,chunks.at(-1),keyboard);
      return;
    }
    const message = error?.message;
    if(error?.subreason==='live_price_unsupported' || message==='Price-market template not supported live')
      return screen(ctx,t('liq_assessment_live_price_unsupported'),keyboard);
    const category = ['Short-expiry price market not supported live', 'Unavailable USDC outcome',
      'Settled outcome', 'Market expiry unavailable or inside safety buffer',
      'Decision cutoff unavailable or near', 'Market expiry near'].includes(message) ? 'liq_market_blocked'
      : ['Existing inventory', 'Foreign orders or unavailable open orders',
        'Account has unresolved liquidity session', 'Outcome belongs to another bundle'].includes(message) ? 'liq_account_blocked'
      : /^Invalid (?:durationMinutes|budgetUsdc|maxInventoryShares|orderSizeShares|minPrice|maxPrice|minSpread|maxLossUsdc|maxActions|liquidity policy fields)$/.test(message || '') || message === 'Inconsistent liquidity bounds' ? 'liq_limits_blocked'
      : null;
    await screen(ctx, category ? t(category) : t('liq_unavailable'), keyboard);
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
  async function prompt(ctx, state, catalogue) {
    state.loading=false;delete state.loadingNavigation;
    const t = await tr(), field = fields[state.index];
    if (!current(ctx, state) || catalogue && state.token!==catalogue.token) return;
    // Last awaited formatting precedes both the evidence guard and transition.
    if(catalogue) {
      if(now()>catalogue.events.validUntil)throw Object.assign(Error('Catalogue evidence expired'),{code:'catalogue_unknown',stage:'publication'});
      state.state='LIQUIDITY_INPUT';
    }
    state.token = randomBytes(8).toString('hex');
    const kb = new InlineKeyboard().text(t('back'), `liq:back:${state.token}`).text(t('cancel'), 'liq:cancel');
    await screen(ctx, `${t('liq_step')} ${state.index + 1}/${fields.length}\n${t(field[1])}`, kb, state);
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
    const token=state.token;
    state.view={level:'events',page:1};state.navigationToken=token;
    state.loading=true;state.loadingMode=state.policy.mode;
    state.choices=[{kind:'menu'},{kind:'cancel'}];
    await screen(ctx,t('liq_catalog_loading'),new InlineKeyboard()
      .text(t('back'),`liq:pick:${token}:0`).text(t('cancel'),`liq:pick:${token}:1`));
    if(!current(ctx,state)||state.token!==token)return;
    return runCatalogue(ctx,state,()=>discoverScreen(ctx,state),t);
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
    if (p.maxLossUsdc > p.budgetUsdc) {
      state.index = 0; state.policy = { mode: p.mode, account: p.account, network: p.network, event: p.event };
      await ctx.reply(t('liq_inconsistent'));
      return prompt(ctx, state);
    }
    return propose(ctx,state,t);
  }
  function retryKeyboard(state,t) {
    state.state='LIQUIDITY_RETRY';state.token=randomBytes(8).toString('hex');
    return new InlineKeyboard().text(t('liq_retry'),`liq:retry:${state.token}`).row()
      .text(t('back'),`liq:back:${state.token}`).text(t('cancel'),'liq:cancel');
  }
  async function retry(ctx,token) {
    if(!await guard(ctx))return;
    const state=runtime.userStates.get(ctx.chat.id),t=await tr();
    if(state?.state!=='LIQUIDITY_RETRY'||token!==state.token||!current(ctx,state))return screen(ctx,t('session_expired'),back(t));
    state.state='LIQUIDITY_PROPOSING';state.token=randomBytes(8).toString('hex');
    return propose(ctx,state,t);
  }
  async function propose(ctx,state,t) {
    const p=state.policy;
    state.state = 'LIQUIDITY_PROPOSING';
    try {
      if(state.draftId){await (await service()).stopLiquiditySession(state.draftId,{ownerId:ctx.from.id,reason:'owner_stop'});delete state.draftId;}
      if(!current(ctx,state))return;
      const {automaticLiquidityPolicy}=await import('../../liquidity/automatic-policy.js');
      const derived=await automaticLiquidityPolicy(state.client,p,now);
      if(!current(ctx,state))return;
      const s = await (await service()).proposeLiquiditySession(derived, { requestId: randomBytes(16).toString('hex') });
      if (!current(ctx, state)) {await (await service()).stopLiquiditySession(s.id,{ownerId:ctx.from.id,reason:'owner_stop'});return;}
      return showReview(ctx, s.id, state);
    } catch (error) { if (current(ctx, state)) return serviceFailure(ctx, t, error, retryKeyboard(state,t)); }
  }
  async function stepBack(ctx, token) {
    if (!await guard(ctx)) return;
    const state = runtime.userStates.get(ctx.chat.id), t = await tr();
    if (!['LIQUIDITY_INPUT','LIQUIDITY_RETRY'].includes(state?.state) || token !== state.token || !current(ctx, state)) return screen(ctx, t('session_expired'), back(t));
    if(state.state==='LIQUIDITY_RETRY'){state.state='LIQUIDITY_INPUT';state.index=fields.length;}
    if (state.index === 0) {
      delete state.policy.event;
      state.state = 'LIQUIDITY_CATALOG'; state.token = randomBytes(8).toString('hex');
      const refreshToken=state.token;
      try {
        await loading(ctx,state,t);
        return runCatalogue(ctx,state,()=>discoverScreen(ctx,state,{level:'events',page:state.eventPage||1}),t);
      } catch(error) { if (current(ctx,state)&&state.token===refreshToken) await catalogueFailure(ctx,state,t,error); }
      return;
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
        t('liq_all_sides'),...a.legs.map(l=>`${clean(l.name)} · ${clean(liquidityDisplaySide(l.sideName,t))} (${clean(l.coin)})${l.fallback?' · '+t('liq_fallback'):''}`),
        `${t('liq_suitability')}: ${t('liq_suitability_'+a.suitability)}`,
        `${t('liq_minimum_budget')}: ${a.minimumBudgetUsdc==null?t('liq_unknown'):a.minimumBudgetUsdc.toFixed(2)} USDC`,
        `${t('liq_required_budget')}: ${a.requiredBudgetUsdc==null?t('liq_unknown'):a.requiredBudgetUsdc.toFixed(2)} USDC`,
        `${t('liq_spendable_spot')}: ${a.availableUsdc==null?t('liq_unknown'):a.availableUsdc.toFixed(2)} USDC`,
        `${t('liq_quote_deadline')}: ${a.legs.every(l=>Number.isSafeInteger(l.expiry))?new Date(Math.min(...a.legs.map(l=>l.expiry))-3600000).toISOString():t('liq_unknown')}`,
        ...a.reasons.map(r=>{const leg=a.legs.find(l=>l.coin===r.coin);return `${r.coin?(leg?`${clean(leg.name)} · ${clean(liquidityDisplaySide(leg.sideName,t))} (${clean(r.coin)})`:clean(r.coin))+' · ':''}${t('liq_assessment_'+(r.subreason==='live_price_unsupported'?r.subreason:r.code))}${r.detail?' · '+clean(r.detail):''}`;}),
        ...a.legs.filter(l=>!l.unavailable).map(l=>`${clean(l.name)} · ${clean(liquidityDisplaySide(l.sideName,t))} (${clean(l.coin)}) · ${t('liq_minimum_shares')}: ${l.minimumShares}; ${t('liq_order_label')}: ${l.size}; ${t('liq_quote_prices')}: ${l.bid} / ${l.ask}; ${t('liq_available_spread')}: ${(l.ask-l.bid).toFixed(5)}; ${t('liq_fee_bound')}: ${(Math.ceil(l.feeRate*1e7)/1e5).toFixed(5)}%`),
        ...(a.pairs||[]).filter(p=>!p.unavailable).map(p=>`${clean(a.legs.find(l=>l.outcomeId===p.outcomeId)?.name)} · ${t('liq_pair_net_edge')}: ${p.netMatchedEdgePerShare.toFixed(5)}`),
        ...values.filter(key=>key!=='orderSizeShares').map(key=>`${t({network:'liq_network',durationMinutes:'liq_duration_label',budgetUsdc:'liq_budget_label',maxInventoryShares:'liq_inventory_label',minPrice:'liq_min_label',maxPrice:'liq_max_label',minSpread:'liq_spread_label',maxLossUsdc:'liq_loss_label',maxActions:'liq_actions_label'}[key])}: ${clean(p[key])}${key==='minSpread'?` (${(p[key]*100).toFixed(3)} ${t('liq_percentage_points')})`:''}`),
        ...(expectedState?.state==='LIQUIDITY_PROPOSING'?[t('liq_inventory_auto_note'),t('liq_automatic_note')]:[]),
        t('liq_fee_bound_note'),t('liq_budget_rule'),t('liq_risk'),t('liq_merged_book'),p.mode==='observe'?t('liq_observe_rule'):t('liq_live_rule')];
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
        if(expectedState?.policy)reviewState.retryInputs=expectedState;
        kb.text(t('liq_approve'),callback).row();
      }
      if(a.suitability!=='conditional' && expectedState?.policy && now()<expectedState.expiresAt && bindingMatches(expectedState.policy) && expectedState.client===runtime.hlClient && stillHere()) {
        runtime.userStates.set(ctx.chat.id,expectedState);expectedState.draftId=id;
        await screen(ctx,chunks.at(-1),retryKeyboard(expectedState,t));return true;
      }
      kb.text(t('cancel'),'liq:cancel');
      await screen(ctx,chunks.at(-1),kb);
      return stillHere();
    } catch (error) {
      if(stillHere()) {
        if(reviewState.state==='LIQUIDITY_REVIEW_LOADING' && expectedState?.policy && now()<expectedState.expiresAt && bindingMatches(expectedState.policy) && expectedState.client===runtime.hlClient) {
          runtime.userStates.set(ctx.chat.id,expectedState);expectedState.draftId=id;
          return serviceFailure(ctx,t,error,retryKeyboard(expectedState,t));
        }
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
    } catch (error) {
      const inputs=state.retryInputs;
      if(inputs && runtime.userStates.get(ctx.chat.id)===state && bindingMatches(inputs.policy) && inputs.client===runtime.hlClient && now()<inputs.expiresAt) {
        let draft;try{draft=await (await service()).getLiquiditySession(state.sessionId);}catch{/* Unknown session state must not permit replacement. */}
        if(draft?.status==='draft' && runtime.userStates.get(ctx.chat.id)===state && bindingMatches(inputs.policy) && inputs.client===runtime.hlClient && now()<inputs.expiresAt){
          inputs.draftId=state.sessionId;runtime.userStates.set(ctx.chat.id,inputs);
          return serviceFailure(ctx,t,error,retryKeyboard(inputs,t));
        }
      }
      await serviceFailure(ctx, t, error);
    }
    finally { if(runtime.userStates.get(ctx.chat.id)===state)await runtime.invalidateUserState(ctx.chat.id); }
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
  return { menu, campaigns, start, choose, input, retry, stepBack, cancel, session, showReview, confirm, stop };
}

export async function showLiquiditySessionReview(ctx, id, expectedState) {
  return createLiquidityFeature().showReview(ctx, id, expectedState);
}
