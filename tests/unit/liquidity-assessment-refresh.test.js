import test from 'node:test';
import assert from 'node:assert/strict';
import {eventHarness} from './liquidity-event-harness.js';
import {assessLiquidityEvent} from '../../src/modules/liquidity/event.js';
import * as runtime from '../../src/modules/bot/runtime.js';
import {resetOutcomeCache} from '../../src/modules/bot/features/outcomes.js';
import {handleCallbackQuery} from '../../src/modules/bot/routing/callback-router.js';
import {handleTextMessage} from '../../src/modules/bot/routing/text-router.js';
import {getTranslator} from '../../src/modules/i18n.js';
const buttons=f=>f.messages.findLast(m=>m.extra?.reply_markup).extra.reply_markup.inline_keyboard.flat();
async function route(f,data){f.ctx.callbackQuery={data};await handleCallbackQuery(f.ctx);}
async function text(f,value){f.ctx.message={text:String(value)};await handleTextMessage(f.ctx);}
test('slow preparation does not self-age a healthy event; final whole snapshot remains fresh',async()=>{
 const f=eventHarness();try{
  let clock=f.time,active=0,peak=0;const prepare=f.client.prepareMakerOrder.bind(f.client);
  f.client.getOrderbook=async coin=>({...structuredClone(f.books[coin]),time:clock});
  f.client.prepareMakerOrder=async args=>{active++;peak=Math.max(peak,active);await new Promise(r=>setImmediate(r));clock+=400;try{return await prepare(args);}finally{active--;}};
  const a=await assessLiquidityEvent(f.client,f.policy,()=>clock);
  assert.equal(a.suitability,'conditional',JSON.stringify(a.reasons));assert(peak>1);assert(peak<=6);
  assert(a.legs.every(l=>a.observedAt-l.time<=5000));assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
test('genuinely stale final books stay unavailable, not unsuitable or approvable',async()=>{
 const f=eventHarness();try{
  for(const b of Object.values(f.books))b.time=f.time-6000;
  const a=await assessLiquidityEvent(f.client,f.policy,()=>f.time);
  assert.equal(a.suitability,'unavailable');assert(a.reasons.some(r=>r.code==='book_data_unavailable'));assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
for(const language of ['en','ru'])test(`connected data retry preserves all inputs and gets fresh owner review (${language})`,async()=>{
 const f=eventHarness({language,routed:true});try{
  resetOutcomeCache();await route(f,'liq:new:live');await route(f,buttons(f).find(b=>b.text==='Championship').callback_data);
  f.client.getUserFees=async()=>{throw Error('controlled outage');};
  await text(f,30);await text(f,100);await text(f,10);
  const state=runtime.userStates.get(f.owner);assert.equal(state?.state,'LIQUIDITY_RETRY');
  assert.deepEqual([state.policy.durationMinutes,state.policy.budgetUsdc,state.policy.maxLossUsdc],[30,100,10]);
  const t=await getTranslator(language);assert(f.messages.at(-1).text.includes(t('liq_suitability_unavailable')));
  const retry=buttons(f).find(b=>b.callback_data.startsWith('liq:retry:')).callback_data;
  f.client.getUserFees=async()=>f.fees;for(const b of Object.values(f.books))b.time=Date.now();
  await route(f,retry);const s=await f.c.get(runtime.userStates.get(f.owner)?.sessionId);assert(s);assert.equal(s.assessment.suitability,'conditional');
  const review=f.messages.map(m=>m.text).join('\n');assert(review.includes('0.40000%'));assert(review.includes(t('liq_fee_bound_note')));
  const count=(await f.c.list()).length;await route(f,retry);assert.equal((await f.c.list()).length,count);assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
test('verified tight spread is unsuitable, not missing data',async()=>{
 const f=eventHarness();try{
  for(const b of Object.values(f.books))b.levels=[[{px:'0.499',sz:'1000'}],[{px:'0.501',sz:'1000'}]];
  const a=await assessLiquidityEvent(f.client,f.policy,()=>f.time);
  assert.equal(a.suitability,'unsuitable');assert(a.reasons.some(r=>r.code==='spread_below_policy'));assert(a.legs.every(l=>!l.unavailable));
 }finally{await f.close();}
});
