import {randomUUID,randomBytes} from 'node:crypto';
import {InlineKeyboard} from 'grammy';
import {loadConfig} from '../../config.js';
import {getTranslator} from '../../i18n.js';
import {getBundleCloseRequest,createBundleCloseRequest,updateBundleCloseRequest} from '../../database.js';
import {loadBundlePortfolio,quoteBundleClose,verifyBundleOrigin} from '../../bundle-portfolio.js';
import {orderStatuses} from '../../hyperliquid.js';
import * as runtime from '../runtime.js';

const money = n => n===null || n===undefined ? 'N/A' : `$${Number(n).toFixed(2)}`;
const pnl = (n,cost) => `${money(n)} (${typeof n==='number' && typeof cost==='number' && cost>0 ? `${(n/cost*100).toFixed(2)}%` : 'N/A'})`;
const validId = s => /^[0-9a-f-]{36}$/.test(String(s)) ? s : null;
async function screen(ctx,text,kb) {
  try {await ctx.editMessageText(text,{reply_markup:kb});}
  catch {await ctx.reply(text,{reply_markup:kb});}
}
export function createBundlesFeature({client=()=>runtime.hlClient,load=loadBundlePortfolio,quote=quoteBundleClose,now=Date.now}={}) {
  async function language() {const cfg=await loadConfig();return getTranslator(cfg.language||'en');}
  async function list(ctx,page=0) {
    const t=await language(),c=client();
    if(!c) return screen(ctx,t('bundle_unavailable'),new InlineKeyboard().text(t('back'),'back_menu'));
    const rows=await load(c);
    const kb=new InlineKeyboard();
    const active=rows.filter(r=>r.status!=='closed'),closed=rows.filter(r=>r.status==='closed');
    const ordered=[...active,...closed],offset=Math.max(0,Math.min(Math.floor(Number(page)||0),Math.ceil(ordered.length/20)-1))*20;
    for(const r of ordered.slice(offset,offset+20)) kb.text(`${String(r.label||'#'+r.questionId).slice(0,24)} · ${t(`bundle_${r.status}`)} · ${pnl(r.status==='closed'?r.net:r.indicativePnl,r.cost)}`.slice(0,64),`bundle_detail:${r.id}`).row();
    if(offset) kb.text(t('bundle_previous'),`bundle_page:${offset/20-1}`);
    if(offset+20<ordered.length) kb.text(t('bundle_next'),`bundle_page:${offset/20+1}`);
    if(offset || offset+20<ordered.length) kb.row();
    kb.text(t('back'),'back_menu');
    const total=(items,field)=>items.every(r=>typeof r[field]==='number' && Number.isFinite(r[field]))
      ?pnl(items.reduce((n,r)=>n+r[field],0),items.every(r=>typeof r.cost==='number')?items.reduce((n,r)=>n+r.cost,0):null):'N/A';
    await screen(ctx,`${t('bundle_title')}\n${t('bundle_active')}: ${active.length}; ${t('bundle_indicative')}: ${total(active,'indicativePnl')}\n`+
      `${t('bundle_closed')}: ${closed.length}; ${t('bundle_net')}: ${total(closed,'net')}${rows.length?'':'\n'+t('bundle_empty')}\n${t('bundle_caveat')}`,kb);
  }
  async function detail(ctx,id) {
    const t=await language(),c=client();
    if(!c || !validId(id)) return screen(ctx,t('session_expired'),new InlineKeyboard().text(t('back'),'bundles'));
    const s=(await load(c)).find(r=>r.id===id);
    if(!s) return screen(ctx,t('session_expired'),new InlineKeyboard().text(t('back'),'bundles'));
    const text=`${t('bundle_title')} ${String(s.label||'#'+s.questionId).slice(0,100)}\n${t(`bundle_${s.status}`)}\n${t('bundle_bought')}: ${new Date(s.createdAt).toISOString()}\n`+
      `${t('bundle_cost')}: ${money(s.cost)}\n${t('bundle_proceeds')}: ${money(s.proceeds)}\n`+
      (s.status==='closed'?`${t('bundle_net')}: ${pnl(s.net,s.cost)}`:
        `${t('bundle_value')}: ${money(s.value)}\n${t('bundle_indicative')}: ${pnl(s.indicativePnl,s.cost)}`)+
      `\n${s.remaining.map(l=>`${t('bundle_outcome')} ${String(l.label||l.coin).slice(0,80)} (${l.coin}): ${l.size} ${t('bundle_shares')}`).join('\n')}`+
      (s.reason?`\n${t('bundle_unknown')}: ${t(`bundle_reason_${s.reason.replace(/ /g,'_')}`)}`:'')+`\n${t('bundle_caveat')}`;
    const kb=new InlineKeyboard();
    if(s.status==='active' && s.ownershipCertain && s.remaining.some(l=>l.size>0) && (!getBundleCloseRequest(s.id) || getBundleCloseRequest(s.id).state==='reconciled')) kb.text(t('bundle_close_button'),`bundle_review:${id}`).row();
    kb.text(t('back'),'bundles');
    return screen(ctx,text,kb);
  }
  async function review(ctx,id) {
    const t=await language(),c=client();
    if(!c || !validId(id) || (getBundleCloseRequest(id) && getBundleCloseRequest(id).state!=='reconciled')) return screen(ctx,t('bundle_blocked'),new InlineKeyboard().text(t('back'),'bundles'));
    try {
      const s=(await load(c)).find(r=>r.id===id);
      if(!s) throw new Error('Missing bundle');
      await verifyBundleOrigin(c,s);
      const q=await quote(c,s);
      const binding=runtime.runtimeBinding();
      const callback=runtime.confirmationCallback(ctx.chat.id,'confirm_bundle_close',{
        state:'CONFIRMING_BUNDLE_CLOSE',id,binding,orders:q.orders,expected:q.expected,net:q.net,expiresAt:now()+120000
      });
      return screen(ctx,`${t('bundle_close_review')} ${s.label}\n${q.orders.map(o=>`${t('bundle_outcome')} ${String(s.remaining.find(l=>l.coin===o.coin)?.label||o.coin).slice(0,80)} (${o.coin}): ${o.size} ${t('bundle_shares')}, ${t('bundle_limit_price')} ${o.price}`).join('\n')}\n`+
        `${t('bundle_expected')}: ${money(q.expected)}\n${t('bundle_net_estimate')}: ${pnl(q.net,s.cost)}\n${t('bundle_close_risk')}`,
        new InlineKeyboard().text(t('confirm'),callback).text(t('cancel'),'bundles'));
    } catch {return screen(ctx,t('bundle_blocked'),new InlineKeyboard().text(t('back'),'bundles'));}
  }
  async function confirm(ctx) {
    const t=await language(),c=client(),state=runtime.userStates.get(ctx.chat.id);
    if(!c || state?.state!=='CONFIRMING_BUNDLE_CLOSE' || state.binding!==runtime.runtimeBinding() || now()>=state.expiresAt)
      return screen(ctx,t('session_expired'),new InlineKeyboard().text(t('back'),'bundles'));
    if(runtime.busyLocks.get(ctx.chat.id)) return;
    runtime.busyLocks.set(ctx.chat.id,true);
    try {
      if(getBundleCloseRequest(state.id) && getBundleCloseRequest(state.id).state!=='reconciled') throw new Error('Already submitted');
      const fresh=(await load(c)).find(r=>r.id===state.id);
      await verifyBundleOrigin(c,fresh);
      const q=await quote(c,fresh);
      if(q.orders.length!==state.orders.length || q.orders.some((o,i)=>o.coin!==state.orders[i].coin || o.size!==state.orders[i].size || o.price<state.orders[i].price-1e-9) || q.expected<state.expected-1e-8)
        throw new Error('Quote changed');
      if(runtime.userStates.get(ctx.chat.id)!==state || runtime.runtimeTransitioning || state.binding!==runtime.runtimeBinding() || now()>=state.expiresAt) throw new Error('Review expired');
      const orders=state.orders.map(o=>({...o,cloid:`0x${randomBytes(16).toString('hex')}`}));
      const requestId=randomUUID();
      createBundleCloseRequest({id:requestId,attemptId:state.id,account:c.address,network:c.network,legs:orders});
      let result;
      try {result=await c.placeOrders(orders,{throwOnError:false});}
      catch {updateBundleCloseRequest(requestId,'unknown',orders);return screen(ctx,t('bundle_unknown_execution'),new InlineKeyboard().text(t('back'),'bundles'));}
      const statuses=orderStatuses(result,orders.length);
      const legs=orders.map((o,i)=>({...o,oid:statuses[i]?.filled?.oid ?? statuses[i]?.resting?.oid ?? null,
        status:statuses[i]?.error?'rejected':statuses[i]?.filled?'filled':statuses[i]?.resting?'resting':'unknown',
        filledSize:statuses[i]?.filled?.totalSz ?? null}));
      updateBundleCloseRequest(requestId,legs.every(l=>l.status==='filled' && Number(l.filledSize)===l.size)?'filled':'partial',legs);
      return screen(ctx,`${t('bundle_close_result')}\n${legs.map(l=>`${t('bundle_outcome')} ${l.coin}: ${t(`bundle_execution_${l.status}`)} ${l.filledSize??'?'} / ${l.size} ${t('bundle_shares')}; OID ${l.oid??'?'}`).join('\n')}\n${t('bundle_close_risk')}`,
        new InlineKeyboard().text(t('bundle_title'),'bundles'));
    } catch {return screen(ctx,t('bundle_blocked'),new InlineKeyboard().text(t('back'),'bundles'));}
    finally {runtime.userStates.delete(ctx.chat.id);runtime.busyLocks.delete(ctx.chat.id);}
  }
  return {list,detail,review,confirm};
}
