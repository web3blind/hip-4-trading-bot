import { randomBytes, randomUUID } from 'node:crypto';
import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { completeSetQuestions, quoteCompleteSet } from '../../complete-set.js';
import { getCompleteSetFeeEvidence } from '../../complete-set-fees.js';
import { orderStatuses } from '../../hyperliquid.js';
import { upsertOrder, createCompleteSetAttempt, updateCompleteSetAttempt } from '../../database.js';
import * as runtime from '../runtime.js';
import { mainMenuKeyboard } from '../ui/keyboards.js';

async function editOrReply(ctx, text, reply_markup) {
  try { await ctx.editMessageText(text, { reply_markup }); }
  catch { await ctx.reply(text, { reply_markup }); }
}
const fmt = n => Number(n).toFixed(2);
const percentages = [10,30,50,70,80,90,100];
const cents = n => Math.floor(n*100+1e-8)/100;
const idOf = value => /^[1-9][0-9]{0,14}$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
function questionName(q) {
  const a = q.description.match(/(?:^|\|)participantA:([^|]+)/)?.[1] || '';
  const b = q.description.match(/(?:^|\|)participantB:([^|]+)/)?.[1] || '';
  return a && b ? `${a} — ${b}` : `${String(q.name||'Outcome').replace(/^template:/,'')} #${q.question}`;
}
async function findQuestion(client, id, now) {
  const [meta,templates] = await Promise.all([client.getOutcomeMeta(),client.getOutcomeTemplates()]);
  if (!Array.isArray(meta?.questions) || !Array.isArray(meta?.outcomes) || !Array.isArray(templates))
    throw new Error('Invalid complete-set metadata');
  return completeSetQuestions(meta, templates, now).find(q => q.question === id) || null;
}
function legLabel(t,q,index) {
  const o=q.outcomes[index];
  if (!o) return String(index+1);
  if (o.outcome===q.fallbackOutcome) return t('set_fallback');
  if (o.description) return o.description;
  if (/draw/i.test(String(o.name))) return t('set_draw');
  return String(o.name||index+1).replace(/^template:/,'');
}
function summary(t, q, quote) {
  const legs=quote.orders.map((o,i)=>`${i+1}. ${legLabel(t,q,i)}: ${fmt(o.size)} @ ${Number(o.price).toFixed(5)} (≤$${fmt(o.price*o.size)})`).join('\n');
  return `${questionName(q)}\n${t('set_coverage')}: ${t(q.coverage==='named_exhaustive'?'set_named_coverage':'set_fallback_coverage')}\n` +
    `${legs}\n${t('set_shares')}: ${quote.shares}\n` +
    `${t('set_spend')}: $${fmt(quote.maxSpend)}\n` +
    `${t('set_max_cost')}: $${fmt(quote.worstCost)}\n` +
    `${t('set_gross')}: $${fmt(quote.worstGross)}\n` +
    `${t('set_fee_max')}: $${fmt(quote.feeMax)}\n` +
    `${t('set_net_floor')}: $${fmt(quote.netLowerBound)}\n` +
    `${t('set_legs')}: ${quote.orders.length}\n` +
    `${t('set_quote_expiry')}\n${t('set_fee_warning')}`;
}

/** A Telegram review is not an exchange write. Any write requires the one-time confirmation. */
export function createCompleteSetFeature(deps = {}) {
  const client = () => deps.client ?? runtime.hlClient;
  const persist = deps.persistOrder ?? upsertOrder;
  const attempts = deps.attempts ?? {create:createCompleteSetAttempt,update:updateCompleteSetAttempt};
  const now = deps.now ?? (() => Date.now());

  async function open(ctx, rawId) {
    const config = await loadConfig(), t = await getTranslator(config.language || 'en');
    const id = idOf(String(rawId));
    if (id === null || !client()) return editOrReply(ctx, t('set_unavailable'), mainMenuKeyboard());
    if (runtime.busyLocks.get(ctx.chat.id)) return expired(ctx);
    const opening={state:'OPENING_SET',questionId:id,account:runtime.runtimeBinding()};
    runtime.userStates.set(ctx.chat.id,opening);
    const current=()=>runtime.userStates.get(ctx.chat.id)===opening && opening.account===runtime.runtimeBinding() && !runtime.runtimeTransitioning;
    try {
      const c=client(), q=await findQuestion(c,id,now());
      if (!current()) return;
      if (!q) {runtime.userStates.delete(ctx.chat.id);return editOrReply(ctx,t('set_unavailable'),mainMenuKeyboard());}
      const feeEvidence=await getCompleteSetFeeEvidence(c,q,now());
      if (!feeEvidence) throw new Error('Invalid fee evidence');
      const minimum=await quoteCompleteSet(c,q,100_000,{now:now(),feeEvidence,minimum:true});
      if (!current()) return;
      if (!minimum) {runtime.userStates.delete(ctx.chat.id);return editOrReply(ctx,t('set_no_opportunity'),mainMenuKeyboard());}
      const balance=await c.getAvailableUsdc();
      if (!current()) return;
      if (!Number.isFinite(balance) || balance<0) throw new Error('Invalid balance');
      const token=randomBytes(6).toString('hex');
      const state={state:'AWAITING_SET_AMOUNT',questionId:id,token,account:runtime.runtimeBinding()};
      runtime.userStates.set(ctx.chat.id,state);
      const keyboard=new InlineKeyboard();
      const minimumBudget=Math.ceil((minimum.maxSpend-1e-8)*100)/100;
      if (cents(balance)>=minimumBudget)
        keyboard.text(`${t('set_minimum_button')} (${fmt(minimumBudget)} $)`, `set_amount:${id}:${token}:min`).row();
      for (const pct of percentages) {
        const amount=cents(balance*pct/100);
        if (amount>=minimumBudget && amount<=100_000)
          keyboard.text(pct===100?`100% (${t('set_max')}, ${fmt(amount)} $)`:`${pct}% (${fmt(amount)} $)`, `set_amount:${id}:${token}:${pct}`).row();
      }
      keyboard.text(t('cancel'),'back_menu');
      await editOrReply(ctx, `${t('set_title')}\n${questionName(q)}\n\n${t('set_available')}: $${fmt(balance)}\n${t('set_minimum')}: $${fmt(Math.ceil((minimum.maxSpend-1e-8)*100)/100)}\n${t('set_enter_budget',{count:q.outcomes.length})}${balance+1e-8<minimum.maxSpend?'\n'+t('set_budget_short'):''}`,keyboard);
    } catch {
      if (current()) {runtime.userStates.delete(ctx.chat.id);await editOrReply(ctx,t('set_data_error'),mainMenuKeyboard());}
    }
  }

  async function chooseAmount(ctx, rawId, token, choice) {
    const state = runtime.userStates.get(ctx.chat.id);
    if (state?.state !== 'AWAITING_SET_AMOUNT' || state.questionId !== idOf(String(rawId)) || state.token!==token) return expired(ctx);
    if (choice!=='min' && !percentages.includes(Number(choice))) return expired(ctx);
    await review(ctx,choice==='min'?'min':Number(choice));
  }
  async function inputAmount(ctx, state, text) {
    if (runtime.userStates.get(ctx.chat.id) !== state || state.state !== 'AWAITING_SET_AMOUNT') return expired(ctx);
    await review(ctx, text);
  }
  async function expired(ctx) {
    const config=await loadConfig(), t=await getTranslator(config.language || 'en');
    return editOrReply(ctx, t('session_expired'), mainMenuKeyboard());
  }
  async function review(ctx, rawBudget) {
    const config=await loadConfig(), t=await getTranslator(config.language || 'en');
    const state=runtime.userStates.get(ctx.chat.id);
    if (state?.state !== 'AWAITING_SET_AMOUNT' || state.account!==runtime.runtimeBinding() || !client() || runtime.busyLocks.get(ctx.chat.id)) return expired(ctx);
    state.state='REVIEWING_SET';
    const current=()=>runtime.userStates.get(ctx.chat.id)===state && state.state==='REVIEWING_SET' && state.account===runtime.runtimeBinding() && !runtime.runtimeTransitioning;
    try {
      const c=client(), q=await findQuestion(c,state.questionId,now());
      if (!current()) return;
      if (!q) { await editOrReply(ctx,t('set_unavailable'),mainMenuKeyboard());return; }
      const feeEvidence=await getCompleteSetFeeEvidence(c,q,now());
      if (!feeEvidence) throw new Error('Invalid fee evidence');
      const minimum=await quoteCompleteSet(c,q,100_000,{now:now(),feeEvidence,minimum:true});
      if (!current()) return;
      if (!minimum) {await editOrReply(ctx,t('set_no_opportunity'),new InlineKeyboard().text(t('back'),`set_open:${state.questionId}`));return;}
      const balance=await c.getAvailableUsdc();
      if (!current()) return;
      if (!Number.isFinite(balance) || balance<0) throw new Error('Invalid balance');
      const budget=rawBudget==='min'?Math.ceil((minimum.maxSpend-1e-8)*100)/100:
        percentages.includes(Number(rawBudget)) && typeof rawBudget==='number'?cents(balance*rawBudget/100):Number(String(rawBudget).trim().replace(',','.'));
      if (!Number.isFinite(budget) || budget<=0 || budget>100_000) {await ctx.reply(t('set_invalid_budget'));return;}
      if (budget+1e-8<minimum.maxSpend) {await ctx.reply(t('set_budget_too_small',{amount:fmt(Math.ceil((minimum.maxSpend-1e-8)*100)/100)}));return;}
      if (budget>balance+1e-8) {await ctx.reply(t('insufficient_balance',{balance:fmt(balance)}));return;}
      const quote=await quoteCompleteSet(c,q,budget,{now:now(),feeEvidence});
      if (!current()) return;
      if (!quote) {
        await editOrReply(ctx, t('set_changed'), new InlineKeyboard().text(t('back'), `set_open:${state.questionId}`));
        return;
      }
      if (balance < quote.maxSpend) {
        await editOrReply(ctx,t('insufficient_balance',{balance:fmt(balance||0)}),new InlineKeyboard().text(t('back'),'back_menu'));
        return;
      }
      const reviewed={...quote,orders:quote.orders.map(o=>({...o,cloid:`0x${randomBytes(16).toString('hex')}`}))};
      const callback=runtime.confirmationCallback(ctx.chat.id,'confirm_set_buy',{
        state:'CONFIRMING_SET_BUY', questionId:q.question, budget, quote:reviewed, account:runtime.runtimeBinding(),
      });
      await editOrReply(ctx, `${t('set_review')}\n${summary(t,q,quote)}\n\n${t('set_confirm_risk')}`,
        new InlineKeyboard().text(t('confirm'),callback).text(t('cancel'),'back_menu'));
    } catch {
      if (current()) await editOrReply(ctx,t('set_data_error'),new InlineKeyboard().text(t('back'),'back_menu'));
    } finally {if(current()) state.state='AWAITING_SET_AMOUNT';}
  }

  async function confirm(ctx) {
    const config=await loadConfig(), t=await getTranslator(config.language || 'en');
    const chatId=ctx.chat.id, state=runtime.userStates.get(chatId);
    if (state?.state !== 'CONFIRMING_SET_BUY' || !client() || state.account !== runtime.runtimeBinding()) return expired(ctx);
    if (runtime.busyLocks.get(chatId)) return;
    runtime.busyLocks.set(chatId,true);
    let submitted=false;
    try {
      const q=await findQuestion(client(),state.questionId,now());
      if (!q || q.ruleDigest!==state.quote.ruleDigest ||
          q.coveredIds.length!==state.quote.ids.length || q.coveredIds.some((id,i)=>id!==state.quote.ids[i])) {
        await editOrReply(ctx,t('set_changed'),mainMenuKeyboard());return;
      }
      const feeEvidence=await getCompleteSetFeeEvidence(client(),q,now());
      if (!feeEvidence) {await editOrReply(ctx,t('set_data_error'),mainMenuKeyboard());return;}
      const quote=await quoteCompleteSet(client(),q,state.budget,{shares:state.quote.shares,now:now(),feeEvidence});
      const freshBalance=await client().getAvailableUsdc();
      if (!Number.isFinite(freshBalance) || freshBalance<0) {await editOrReply(ctx,t('set_data_error'),mainMenuKeyboard());return;}
      if (!quote || quote.shares!==state.quote.shares || feeEvidence?.digest!==state.quote.feeEvidence.digest ||
          quote.orders.length!==state.quote.orders.length ||
          quote.orders.some((o,i)=>o.coin!==state.quote.orders[i].coin || o.size!==state.quote.orders[i].size ||
            o.price>state.quote.orders[i].price+1e-9) ||
          quote.netLowerBound+1e-8<state.quote.netLowerBound || quote.worstCost>state.quote.worstCost+1e-8 ||
          state.quote.maxSpend>state.budget || !Number.isFinite(freshBalance) || freshBalance<state.quote.maxSpend) {
        await editOrReply(ctx,t('set_changed'),new InlineKeyboard().text(t('set_refresh'),`set_open:${state.questionId}`));return;
      }
      const attemptId=randomUUID(), orders=state.quote.orders;
      const preparedLegs=orders.map(o=>({coin:o.coin,cloid:o.cloid,size:o.size,price:o.price,status:'prepared'}));
      try {
        attempts.create({id:attemptId,questionId:q.question,budget:state.budget,shares:quote.shares,
          coins:orders.map(o=>o.coin),account:client().address,network:client().network,
          ruleDigest:q.ruleDigest,feeDigest:feeEvidence.digest,legs:preparedLegs});
        attempts.update(attemptId,'submitting');
      }
      catch { await editOrReply(ctx,t('set_unavailable'),mainMenuKeyboard());return; }
      // IOC is not atomic. Never retry or auto-transfer after this single call.
      let result;
      submitted=true;
      try { result=await client().placeOrders(orders,{throwOnError:false}); }
      catch {
        try { attempts.update(attemptId,'submitted_unknown'); } catch { /* No retry after ambiguous exchange result. */ }
        await editOrReply(ctx,t('set_unknown'),new InlineKeyboard().text(t('view_orders'),'orders:refresh'));return;
      }
      const statuses=orderStatuses(result,orders.length);
      const legs=statuses.map((s,i)=>({...preparedLegs[i],
        oid:s?.filled?.oid != null ? String(s.filled.oid) : s?.resting?.oid != null ? String(s.resting.oid) : null,
        status:s?.error?'rejected':s?.resting?'resting':s?.filled?'filled':'unknown',
        filledSize:s?.filled?.totalSz != null ? Number(s.filled.totalSz) : null,
        avgPx:s?.filled?.avgPx != null ? Number(s.filled.avgPx) : null}));
      const full=statuses.length===orders.length && statuses.every(s=>s?.filled && Number(s.filled.totalSz)===quote.shares);
      const anyFill=statuses.some(s=>s?.filled && Number(s.filled.totalSz)>0);
      const attemptState=full?'filled':anyFill?'partial':statuses.every(s=>s?.error)?'rejected':'submitted_unknown';
      let persistenceFailed=false;
      try { attempts.update(attemptId,attemptState,legs); } catch { persistenceFailed=true; }
      const lines=statuses.map((s,i)=>{
        const label=q.outcomes[i].description || q.outcomes[i].name || `${i+1}`;
        const oid=s?.filled?.oid ?? s?.resting?.oid;
        if (oid != null) {
          try { persist({coin:quote.orders[i].coin,side:'BUY',orderType:'Market',price:s.filled?.avgPx ?? quote.orders[i].price,
            size:quote.orders[i].size,oid,status:s.resting?'open':s.filled && Number(s.filled.totalSz)===quote.shares?'filled':'unknown',
            fillNotificationStatus:'delivered'}); } catch { persistenceFailed=true; }
        }
        if (s?.error) return `${label}: ${t('order_rejected',{error:s.error})}`;
        if (s?.resting) return `${label}: ${t('set_resting')} OID ${oid}`;
        if (s?.filled && Number(s.filled.totalSz)===quote.shares) return `${label}: ${t('filled')} ${s.filled.totalSz} @ ${s.filled.avgPx}; OID ${oid}`;
        return `${label}: ${t('set_unknown_leg')}${oid ? ` OID ${oid}` : ''}`;
      });
      await editOrReply(ctx, `${t(attemptState==='filled'?'set_submitted':attemptState==='rejected'?'set_rejected':'set_partial')}\n${lines.join('\n')}\n\n${t('set_monitor_note')}${persistenceFailed?'\n'+t('set_persist_warning'):''}`,
        new InlineKeyboard().text(t('menu_positions'),'positions:refresh').text(t('view_orders'),'orders:refresh'));
    } catch {
      await editOrReply(ctx,submitted?t('set_unknown'):t('set_data_error'),new InlineKeyboard().text(t('view_orders'),'orders:refresh'));
    } finally { runtime.userStates.delete(chatId);runtime.busyLocks.delete(chatId); }
  }
  return {open,chooseAmount,inputAmount,confirm};
}
