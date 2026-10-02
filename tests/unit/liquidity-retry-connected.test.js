import test from 'node:test';
import assert from 'node:assert/strict';
import {eventHarness} from './liquidity-event-harness.js';
import * as runtime from '../../src/modules/bot/runtime.js';
import {resetOutcomeCache} from '../../src/modules/bot/features/outcomes.js';
import {handleCallbackQuery} from '../../src/modules/bot/routing/callback-router.js';
import {handleTextMessage} from '../../src/modules/bot/routing/text-router.js';
const buttons=f=>f.messages.findLast(m=>m.extra?.reply_markup).extra.reply_markup.inline_keyboard.flat();
async function route(f,data,ctx=f.ctx){ctx.callbackQuery={data};await handleCallbackQuery(ctx);}
async function text(f,value){f.ctx.message={text:String(value)};await handleTextMessage(f.ctx);}
async function select(f){resetOutcomeCache();await route(f,'liq:new:live');await route(f,buttons(f).find(b=>b.text==='Championship').callback_data);await text(f,30);await text(f,100);}
async function failed(f){await select(f);f.client.getUserFees=async()=>{throw Error('Read timeout');};await text(f,10);return buttons(f).find(b=>b.callback_data.startsWith('liq:retry:')).callback_data;}
for(const change of ['cancel','menu','client','network','expired','foreign','stale token'])test(`connected retry refuses ${change} without creating draft or orders`,async()=>{
 const f=eventHarness({routed:true});try{
  const callback=await failed(f),state=runtime.userStates.get(f.owner);
  f.client.getUserFees=async()=>f.fees;
  if(change==='cancel')await route(f,'liq:cancel');
  if(change==='menu')await route(f,'back_menu');
  if(change==='client')runtime.setHLClient({...f.client});
  if(change==='network')f.client.network='mainnet';
  if(change==='expired')state.expiresAt=Date.now()-1;
  const ctx=change==='foreign'?{...f.ctx,from:{id:99}}:f.ctx;
  await route(f,change==='stale token'?'liq:retry:0000000000000000':callback,ctx);
  f.client.network='testnet';runtime.setHLClient(f.client);
  assert.equal((await f.c.list()).length,0);assert.equal(f.actions.length,0);
 }finally{f.client.network='testnet';runtime.setHLClient(f.client);await f.close();}
});
for(const navigation of ['liq:cancel','back_menu'])test(`pending connected retry cannot revive after ${navigation}`,async()=>{
 const f=eventHarness({routed:true});let release;try{
  const callback=await failed(f);f.client.getUserFees=async()=>f.fees;
  let entered;const reached=new Promise(r=>entered=r),hold=new Promise(r=>release=r),original=f.client.getOrderbook;
  f.client.getOrderbook=async coin=>{entered();await hold;return original(coin);};
  const pending=route(f,callback);await reached;await route(f,navigation);const state=runtime.userStates.get(f.owner),count=f.messages.length;
  release();await pending;assert.equal(runtime.userStates.get(f.owner),state);assert.equal(f.messages.length,count);assert.equal((await f.c.list()).length,0);assert.equal(f.actions.length,0);
 }finally{release?.();await f.close();}
});
test('unsuitable persisted review retains inputs; Back edits last input and replacement stops old draft',async()=>{
 const f=eventHarness({routed:true});try{
  await select(f);await text(f,1); // budget 100: usable
  let state=runtime.userStates.get(f.owner);assert.equal(state.state,'CONFIRMING_LIQUIDITY_SESSION');await route(f,'liq:cancel');
  await select(f);state=runtime.userStates.get(f.owner);state.policy.budgetUsdc=20;await text(f,1);
  state=runtime.userStates.get(f.owner);assert.equal(state.state,'LIQUIDITY_RETRY');const id=state.draftId;assert(id);assert.equal((await f.c.get(id)).assessment.suitability,'unsuitable');
  const back=buttons(f).find(b=>b.callback_data.startsWith('liq:back:')).callback_data;await route(f,back);assert.equal(state.index,2);assert.equal(state.policy.durationMinutes,30);assert.equal(state.policy.budgetUsdc,20);
  await route(f,buttons(f).find(b=>b.callback_data.startsWith('liq:back:')).callback_data);assert.equal(state.index,1);
  await text(f,100);await text(f,10);const review=runtime.userStates.get(f.owner);assert.equal(review.state,'CONFIRMING_LIQUIDITY_SESSION');assert.equal((await f.c.get(id)).status,'stopped');assert.equal((await f.c.get(review.sessionId)).assessment.suitability,'conditional');assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
test('changed evidence at automatic owner approval preserves inputs but requires a fresh one-use review',async()=>{
 const f=eventHarness({routed:true});try{
  await select(f);await text(f,10);const id=runtime.userStates.get(f.owner).sessionId;
  const grant=buttons(f).find(b=>b.callback_data.startsWith('confirm_liquidity_session:')).callback_data;
  const original=f.client.getUserFees;f.client.getUserFees=async()=>{throw Error('Read timeout');};await route(f,grant);
  const state=runtime.userStates.get(f.owner);assert.equal(state.state,'LIQUIDITY_RETRY');assert.equal(state.draftId,id);assert.equal(state.policy.budgetUsdc,100);assert.equal((await f.c.get(id)).status,'draft');
  f.client.getUserFees=original;for(const b of Object.values(f.books))b.time=Date.now();await route(f,buttons(f).find(b=>b.callback_data.startsWith('liq:retry:')).callback_data);
  const fresh=runtime.userStates.get(f.owner);assert.equal(fresh.state,'CONFIRMING_LIQUIDITY_SESSION');assert.notEqual(fresh.sessionId,id);await route(f,grant);assert.equal(runtime.userStates.get(f.owner),fresh);assert.equal((await f.c.get(id)).status,'stopped');assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
test('connected assessment failure during second review retains inputs and safely replaces draft',async()=>{
 const f=eventHarness({routed:true});try{
  await select(f);
  // Only the second assessment fails; proposal uses the real coordinator and SQLite.
  f.ui= (await import('../../src/modules/bot/features/liquidity.js')).createLiquidityFeature({service:async()=>({...f.api,assessLiquiditySession:async()=>{throw Error('Review timeout');}})});
  await f.ui.input(f.ctx,runtime.userStates.get(f.owner),'10');
  const state=runtime.userStates.get(f.owner);assert.equal(state.state,'LIQUIDITY_RETRY');assert(state.draftId);assert.equal(state.policy.budgetUsdc,100);assert.equal(state.policy.durationMinutes,30);assert.equal(state.policy.maxLossUsdc,10);assert.equal(f.actions.length,0);assert(!buttons(f).some(b=>b.callback_data.startsWith('confirm_liquidity')));
 }finally{await f.close();}
});
