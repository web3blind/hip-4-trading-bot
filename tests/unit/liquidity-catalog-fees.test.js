import test from 'node:test';
import assert from 'node:assert/strict';
import {eventHarness} from './liquidity-event-harness.js';
import {liquidityCatalogue} from '../../src/modules/liquidity/catalog.js';
import * as runtime from '../../src/modules/bot/runtime.js';
import {getTranslator} from '../../src/modules/i18n.js';
import {readFileSync} from 'node:fs';
import {resolveLiquidityEvent,assessLiquidityEvent} from '../../src/modules/liquidity/event.js';
import {catalogueEventAdmission} from '../../src/modules/liquidity/catalog.js';
import {automaticLiquidityPolicy} from '../../src/modules/liquidity/automatic-policy.js';
import {feeEvidence} from '../../src/modules/liquidity/market.js';
const publicFixture=JSON.parse(readFileSync(new URL('./fixtures/liquidity-naming-public.json',import.meta.url)));
const buttons=f=>f.messages.at(-1).extra.reply_markup.inline_keyboard.flat();
for(const fallbackScale of [1,2])test(`catalogue uses exact all-leg automatic threshold and assessment spread admission, fallback scale ${fallbackScale}`,async()=>{
 const f=eventHarness();try{
  f.meta.outcomes[2].deployerFeeScale=fallbackScale;
  for(const book of Object.values(f.books))book.levels=[[{px:'0.497',sz:'1000000'}],[{px:'0.503',sz:'1000000'}]];
  const resolved=resolveLiquidityEvent(f.meta,f.policy.event),quality=await catalogueEventAdmission(f.meta,resolved,new Map(Object.entries(f.books)),f.fees,f.time);
  const auto=await automaticLiquidityPolicy(f.client,f.policy,()=>f.time),a=await assessLiquidityEvent(f.client,auto,()=>f.time);
  assert.equal(quality.minSpread,auto.minSpread);assert.equal(quality.eligible,fallbackScale===1);
  assert.equal(a.reasons.some(r=>r.code==='spread_below_policy'),!quality.eligible);
  for(const leg of quality.legs)assert.equal(leg.feeRate,feeEvidence(f.fees,f.meta.outcomes.find(o=>o.outcome===leg.outcomeId).deployerFeeScale));
  assert.equal(quality.pairs.length,3);assert(quality.pairs.every(p=>p.depthCountedOnce));assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
test('negative maker fee evidence is never credited as a rebate',async()=>{
 const f=eventHarness();try{
  const resolved=resolveLiquidityEvent(f.meta,f.policy.event),books=new Map(Object.entries(f.books));
  const negative=await catalogueEventAdmission(f.meta,resolved,books,f.fees,f.time);
  const zero=await catalogueEventAdmission(f.meta,resolved,books,{...f.fees,userSpotAddRate:'0',feeSchedule:{...f.fees.feeSchedule,spotAdd:'0'}},f.time);
  assert.equal(negative.minSpread,zero.minSpread);assert.deepEqual(negative.legs.map(l=>l.feeRate),zero.legs.map(l=>l.feeRate));
 }finally{await f.close();}
});
test('healthy depth with one wire tick spread is hidden before inputs',async()=>{
 const f=eventHarness({standalone:true});try{
  f.meta.outcomes=[structuredClone(publicFixture.outcomes.find(o=>o.outcome===6214))];
  f.books['#62140']={time:f.time,levels:[[{px:'0.49999',sz:'1000000'}],[{px:'0.5',sz:'1000000'}]]};
  f.books['#62141']={time:f.time,levels:[[{px:'0.5',sz:'1000000'}],[{px:'0.50001',sz:'1000000'}]]};
  await f.ui.start(f.ctx,'live');assert(!buttons(f).some(b=>b.text.startsWith('Houston Texans')));
  assert.equal(runtime.userStates.get(f.owner).state,'LIQUIDITY_CATALOG');assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
test('viable fee/spread event remains visible and fees are read once per scan',async()=>{
 const f=eventHarness();try{
  let calls=0;f.client.getUserFees=async options=>{calls++;assert(options.signal instanceof AbortSignal);return f.fees;};
  const result=await liquidityCatalogue(f.client);assert.equal(calls,1);assert(result.some(e=>e.questionId===3));assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
test('fee change on event pick removes it before monetary inputs',async()=>{
 const f=eventHarness({standalone:true});try{
  for(const book of Object.values(f.books))book.levels=[[{px:'0.497',sz:'1000000'}],[{px:'0.503',sz:'1000000'}]];
  await f.ui.start(f.ctx,'live');const pick=buttons(f).find(b=>b.text==='Runner 30');assert(pick);
  f.fees.userSpotCrossRate='0.002';await f.ui.choose(f.ctx,pick.callback_data);
  assert(!runtime.userStates.get(f.owner));assert.equal((await f.c.list()).length,0);assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
test('missing account fee evidence is catalogue unknown with retry, not verified weak/empty',async()=>{
 const f=eventHarness();try{
  f.client.getUserFees=async()=>{throw Error('PRIVATE_DO_NOT_LOG');};
  await assert.rejects(liquidityCatalogue(f.client),e=>e.code==='catalogue_unknown');
  await f.ui.start(f.ctx,'live');assert.equal(f.messages.at(-1).text,(await getTranslator('en'))('liq_catalog_terminal_unknown'));
  assert(buttons(f).some(b=>b.callback_data.startsWith('liq:pick:')));assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
test('unknown mandatory fallback scale is unknown while unrelated complete event is shown',async()=>{
 const f=eventHarness();try{
  delete f.meta.outcomes[2].deployerFeeScale;
  f.meta.outcomes.push({outcome:40,name:'Known',quoteToken:'USDC',expiry:f.time+86400000,deployerFeeScale:1});
  const result=await liquidityCatalogue(f.client);assert.deepEqual(result.map(e=>e.outcomeId),[40]);
  assert.deepEqual(result.summary,{total:2,qualified:1,weak:0,unknown:1,partial:true});assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
