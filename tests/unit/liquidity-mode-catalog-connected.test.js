import test from 'node:test';
import assert from 'node:assert/strict';
import {eventHarness} from './liquidity-event-harness.js';
import * as runtime from '../../src/modules/bot/runtime.js';
import {handleCallbackQuery} from '../../src/modules/bot/routing/callback-router.js';
import {handleTextMessage} from '../../src/modules/bot/routing/text-router.js';
import {liquidityCatalogue} from '../../src/modules/liquidity/catalog.js';
import {getTranslator} from '../../src/modules/i18n.js';
const buttons=f=>f.messages.findLast(m=>m.extra?.reply_markup).extra.reply_markup.inline_keyboard.flat();
async function route(f,data){f.ctx.callbackQuery={data};await handleCallbackQuery(f.ctx);}
test('live catalogue excludes unsupported price even with unknown fee metadata',async()=>{
 const f=eventHarness({standalone:true});try{price(f);delete f.meta.outcomes[0].deployerFeeScale;assert.equal((await liquidityCatalogue(f.client)).length,0);}finally{await f.close();}
});
for(const change of ['expired','settled','missing fees'])test(`observation price catalogue still rejects ${change}`,async()=>{
 const f=eventHarness({standalone:true});try{
  price(f);
  if(change==='expired')f.meta.outcomes[0].expiry=Date.now()-1;
  if(change==='settled')f.meta.outcomes[0].settled=true;
  if(change==='missing fees')delete f.meta.outcomes[0].deployerFeeScale;
  if(change==='missing fees')await assert.rejects(liquidityCatalogue(f.client,{mode:'observe'}),e=>e.code==='catalogue_unknown');
  else assert.equal((await liquidityCatalogue(f.client,{mode:'observe'})).length,0);
  assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
for(const change of ['cancel','TTL'])test(`real unsupported price stale selection preserves ${change} guard`,async()=>{
 const f=eventHarness({routed:true,standalone:true});try{
  await route(f,'liq:new:live');const pick=buttons(f)[0].callback_data;
  price(f);if(change==='cancel')await route(f,'liq:cancel');else runtime.userStates.get(f.owner).expiresAt=Date.now()-1;
  await route(f,pick);assert.notEqual(runtime.userStates.get(f.owner)?.state,'LIQUIDITY_INPUT');assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
test('real observation catalogue preserves mode across pagination, retry and step back',async()=>{
 const f=eventHarness({routed:true,standalone:true});try{
  price(f);for(let id=100;id<120;id++)f.meta.outcomes.push({...f.meta.outcomes[0],outcome:id});
  await route(f,'liq:new:observe');let state=runtime.userStates.get(f.owner);
  const next=state.choices.findIndex(a=>a.kind==='view');assert(next>=0);
  await route(f,`liq:pick:${state.token}:${next}`);state=runtime.userStates.get(f.owner);assert(state.choices.some(a=>a.kind==='event'));
  const original=f.client.getOutcomeMeta;f.client.getOutcomeMeta=async()=>{throw Error('Controlled timeout');};
  const view=state.choices.findIndex(a=>a.kind==='view');await route(f,`liq:pick:${state.token}:${view}`);f.client.getOutcomeMeta=original;
  await route(f,buttons(f)[0].callback_data);state=runtime.userStates.get(f.owner);const index=state.choices.findIndex(a=>a.kind==='event');assert(index>=0);
  await route(f,`liq:pick:${state.token}:${index}`);assert.equal(runtime.userStates.get(f.owner).state,'LIQUIDITY_INPUT');
  await route(f,buttons(f).find(b=>b.callback_data.startsWith('liq:back:')).callback_data);
  state=runtime.userStates.get(f.owner);assert.equal(state.state,'LIQUIDITY_CATALOG');assert(state.choices.some(a=>a.kind==='event'));assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
function price(f){const o=f.meta.outcomes[0];o.name='binaryPrice';o.description='perp:xyz:XYZ100|priceDescription:the Pyth US100 index price|seconds:90|threshold:30870|time:20261009-2000';}
for(const mode of ['live','observe'])test(`real router catalogue ${mode}: healthy price selection and sports unchanged`,async()=>{
 const f=eventHarness({routed:true});try{
  // Separate healthy price outcome, with explicit synthetic authoritative expiry/fees.
  f.meta.outcomes.push({...f.meta.outcomes[0],outcome:7732,name:'binaryPrice',description:'perp:xyz:XYZ100|priceDescription:the Pyth US100 index price|seconds:90|threshold:30870|time:20261009-2000'});
  await route(f,`liq:new:${mode}`);
  const state=runtime.userStates.get(f.owner),choices=state.choices.filter(a=>a.kind==='event');
  assert(choices.some(a=>a.event==='question:3'));
  assert.equal(choices.some(a=>a.event==='standalone:7732'),mode==='observe');
  const index=state.choices.findIndex(a=>a.event===(mode==='observe'?'standalone:7732':'question:3'));
  await route(f,`liq:pick:${state.token}:${index}`);assert.equal(runtime.userStates.get(f.owner).state,'LIQUIDITY_INPUT');
  assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
test('direct catalogue defaults safe live; observation admits healthy price',async()=>{
 const f=eventHarness({standalone:true});try{price(f);assert.equal((await liquidityCatalogue(f.client)).length,0);assert.equal((await liquidityCatalogue(f.client,{mode:'observe'})).length,1);}finally{await f.close();}
});
for(const retry of [false,true])test(`selected refresh refuses newly unsupported live price before input (retry=${retry})`,async()=>{
 const f=eventHarness({routed:true,standalone:true});try{
  await route(f,'liq:new:live');const pick=buttons(f).find(b=>b.callback_data.startsWith('liq:pick:')).callback_data;
  if(retry){const original=f.client.getOutcomeMeta;f.client.getOutcomeMeta=async()=>{throw Error('Controlled timeout');};await route(f,pick);f.client.getOutcomeMeta=original;}
  price(f);await route(f,retry?buttons(f)[0].callback_data:pick);
  assert.notEqual(runtime.userStates.get(f.owner)?.state,'LIQUIDITY_INPUT');assert.equal((await f.c.list()).length,0);assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
for(const language of ['en','ru'])test(`real assessment shows explicit unsupported price reason and retains unsuitable code (${language})`,async()=>{
 const f=eventHarness({routed:true,standalone:true,language});try{
  await route(f,'liq:new:live');await route(f,buttons(f)[0].callback_data);price(f);
  for(const value of [30,100,10]){f.ctx.message={text:String(value)};await handleTextMessage(f.ctx);}
  const t=await getTranslator(language);assert.notEqual(t('liq_assessment_live_price_unsupported'),'liq_assessment_live_price_unsupported');
  assert(f.messages.at(-1).text.includes(t('liq_assessment_live_price_unsupported')));
  const {assessLiquidityEvent}=await import('../../src/modules/liquidity/event.js');const a=await assessLiquidityEvent(f.client,f.policy);assert.equal(a.suitability,'unsuitable');assert(a.reasons.some(r=>r.code==='market_unsuitable'&&r.subreason==='live_price_unsupported'));
  assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
