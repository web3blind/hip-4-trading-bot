import test from 'node:test';
import assert from 'node:assert/strict';
import {eventHarness} from './liquidity-event-harness.js';
import * as runtime from '../../src/modules/bot/runtime.js';
import {resetOutcomeCache} from '../../src/modules/bot/features/outcomes.js';
import {handleCallbackQuery} from '../../src/modules/bot/routing/callback-router.js';
import {handleTextMessage} from '../../src/modules/bot/routing/text-router.js';
import {getTranslator} from '../../src/modules/i18n.js';
const buttons=f=>f.messages.findLast(m=>m.extra?.reply_markup).extra.reply_markup.inline_keyboard.flat();
async function route(f,data){f.ctx.callbackQuery={data};await handleCallbackQuery(f.ctx);}
async function text(f,value){f.ctx.message={text:String(value)};await handleTextMessage(f.ctx);}
async function select(f){resetOutcomeCache();await route(f,'liq:new:live');await route(f,buttons(f).find(b=>b.text==='Championship').callback_data);}
async function inputs(f,budget=100){await text(f,30);await text(f,budget);await text(f,10);}
for(const language of ['en','ru'])test(`real routers to SQLite and signed exchange: automatic policy, all sizes, fresh dynamic quotes, one-use grant (${language})`,async()=>{
 const f=eventHarness({language,routed:true});try{
  for(const coin of ['#300','#310','#320'])f.books[coin].levels=[[{px:'0.2',sz:'1000'}],[{px:'0.4',sz:'1000'}]];
  for(const coin of ['#301','#311','#321'])f.books[coin].levels=[[{px:'0.6',sz:'1000'}],[{px:'0.8',sz:'1000'}]];
  await select(f);await text(f,'bad');assert.equal(runtime.userStates.get(f.owner).index,0);
  await text(f,10);const oldBack=buttons(f).find(b=>b.callback_data.startsWith('liq:back:')).callback_data;
  await route(f,oldBack);assert.equal(runtime.userStates.get(f.owner).index,0);
  await route(f,oldBack);assert.equal(runtime.userStates.get(f.owner).index,0); // token rotated
  await inputs(f);const s=await f.c.get(runtime.userStates.get(f.owner)?.sessionId);assert(s,JSON.stringify(f.messages));
  assert.deepEqual(s.legs.map(l=>l.size),[50,17,50,17,50,17]);
  assert(s.assessment.requiredBudgetUsdc<=s.policy.budgetUsdc);
  assert(s.legs.every(l=>l.bid*l.size>=10&&l.ask*l.size>=10));
  const t=await getTranslator(language),review=f.messages.map(m=>m.text).join('\n');
  for(const l of s.legs)assert(review.includes(`${l.bid} / ${l.ask}`));
  assert(review.includes(t('liq_automatic_note')));assert(review.includes(t('liq_percentage_points')));
  assert.equal(f.actions.length,0);const grant=buttons(f).find(b=>b.callback_data.startsWith('confirm_liquidity_session:')).callback_data;
  await route(f,grant);await route(f,grant);assert.equal((await f.c.get(s.id)).status,'active');
  // Move books away from review extrema, without violating the probability domain.
  for(const coin of ['#300','#310','#320'])f.books[coin].levels=[[{px:'0.3',sz:'1000'}],[{px:'0.5',sz:'1000'}]];
  for(const coin of ['#301','#311','#321'])f.books[coin].levels=[[{px:'0.5',sz:'1000'}],[{px:'0.7',sz:'1000'}]];
  for(const b of Object.values(f.books))b.time=Date.now();
  await f.c.tick();assert.equal(f.actions.filter(a=>a.type==='order').length,1);
  const wire=f.actions.find(a=>a.type==='order').orders[0];assert.equal(Number(wire.p),.3);assert.equal(Number(wire.s),50);
  await route(f,`liq:stop:${s.id}`);assert.equal((await f.c.get(s.id)).status,'stopped');
 }finally{await f.close();}
});
for(const change of ['books','fees','deadline','balance','binding'])test(`real automatic grant rejects changed ${change}`,async()=>{
 const f=eventHarness({routed:true});try{
  await select(f);await inputs(f);const s=await f.c.get(runtime.userStates.get(f.owner)?.sessionId);assert(s,JSON.stringify(f.messages));
  const grant=buttons(f).find(b=>b.callback_data.startsWith('confirm_liquidity_session:')).callback_data;
  if(change==='books')f.books['#321'].levels=[[],[]];
  if(change==='fees')f.fees.userSpotCrossRate='0.002';
  if(change==='deadline')f.meta.outcomes[2].expiry=Date.now()+10000;
  if(change==='balance')f.setSpot(1);
  if(change==='binding')runtime.setHLClient({...f.client});
  await route(f,grant);runtime.setHLClient(f.client);await f.c.tick();assert.notEqual((await f.c.get(s.id)).status,'active');assert.equal(f.actions.length,0);
  runtime.setHLClient(f.client);await f.c.stop(s.id,{ownerId:f.owner});
 }finally{runtime.setHLClient(f.client);await f.close();}
});
for(const navigation of ['liq:cancel','back_menu'])test(`real automatic assessment cannot revive ${navigation}`,async()=>{
 const f=eventHarness({routed:true});let release;try{
  await select(f);await text(f,30);await text(f,100);
  let entered;const reached=new Promise(r=>entered=r),hold=new Promise(r=>release=r),original=f.client.getOrderbook;
  f.client.getOrderbook=async coin=>{entered();await hold;return original(coin);};
  const pending=text(f,10);await reached;await route(f,navigation);const retained=runtime.userStates.get(f.owner),count=f.messages.length;
  release();await pending;assert.equal(runtime.userStates.get(f.owner),retained);assert.equal(f.messages.length,count);
  assert.equal(f.actions.length,0);assert(!(await f.c.list()).some(s=>s.status==='draft'));
 }finally{release?.();await f.close();}
});
