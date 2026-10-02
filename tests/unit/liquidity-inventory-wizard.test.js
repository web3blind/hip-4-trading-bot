import test from 'node:test';
import assert from 'node:assert/strict';
import {eventHarness} from './liquidity-event-harness.js';
import * as runtime from '../../src/modules/bot/runtime.js';
import {resetOutcomeCache} from '../../src/modules/bot/features/outcomes.js';
import {getTranslator} from '../../src/modules/i18n.js';
const fields=['durationMinutes','budgetUsdc','maxLossUsdc'];
const prompts=['liq_duration','liq_budget','liq_loss'];
const buttons=f=>f.messages.findLast(m=>m.extra?.reply_markup).extra.reply_markup.inline_keyboard.flat();
async function start(f,mode='live') {
 resetOutcomeCache();await f.ui.start(f.ctx,mode);
 const choice=buttons(f).find(b=>b.text==='Championship');assert(choice);
 await f.ui.choose(f.ctx,choice.callback_data);return runtime.userStates.get(f.owner);
}
async function enter(f,state,policy=f.policy){for(const field of fields)await f.ui.input(f.ctx,state,String(policy[field]));}
for(const language of ['en','ru'])test(`three monetary prompts and automatic prepared policy (${language})`,async()=>{
 const f=eventHarness({language});try{
  const state=await start(f),t=await getTranslator(language);
  for(const [i,field] of fields.entries()){
   assert.equal(f.messages.at(-1).text,`${t('liq_step')} ${i+1}/3\n${t(prompts[i])}`);
   await f.ui.input(f.ctx,state,String(f.policy[field]));
  }
  const [s]=await f.c.list();assert(s);assert.equal(s.policy.orderSizeShares,1);
  assert.equal(s.policy.minPrice,.00001);assert.equal(s.policy.maxPrice,.99999);
  assert.equal(s.policy.maxInventoryShares,1000000);assert.equal(s.policy.maxActions,1000);
  assert(s.policy.minSpread>.004&&s.policy.minSpread<.005);
  assert.equal(s.assessment.suitability,'conditional');assert.equal(s.legs.length,6);
  for(const leg of s.assessment.legs){assert.equal(leg.size,25);assert(leg.size*leg.bid>=10);}
  assert(s.assessment.requiredBudgetUsdc>60&&s.assessment.requiredBudgetUsdc<61);
  const text=f.messages.map(m=>m.text).join('\n');assert(text.includes(t('liq_automatic_note')));
  for(const l of s.assessment.legs)assert(text.includes(`${l.bid} / ${l.ask}`));
  assert.equal(f.actions.length,0);await f.confirm();await f.c.tick();
  assert.equal(f.actions.filter(a=>a.type==='order').length,1);
  assert.equal(Number(f.actions.find(a=>a.type==='order').orders[0].s),25);
 }finally{await f.close();}
});
for(const budget of [10,60,60.6,100,100000])test(`all-leg rounded reserves enforce automatic budget ${budget}`,async()=>{
 const f=eventHarness();try{
  f.setSpot(100000);await enter(f,await start(f),{...f.policy,budgetUsdc:budget,maxLossUsdc:1});
  const [s]=await f.c.list();assert(s);assert.equal(s.assessment.suitability,budget>=60.6?'conditional':'unsuitable');
  if(budget<60.6)assert(s.assessment.reasons.some(r=>r.code==='insufficient_shared_budget'));
  assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
test('Back edits monetary inputs without retaining derivation',async()=>{
 const f=eventHarness();try{
  const s=await start(f);await f.ui.input(f.ctx,s,'30');await f.ui.input(f.ctx,s,'100');
  const b=buttons(f).find(b=>b.callback_data.startsWith('liq:back:'));
  await f.ui.stepBack(f.ctx,b.callback_data.slice(9));assert.equal(s.index,1);
  assert.equal(s.policy.minSpread,undefined);await f.ui.input(f.ctx,s,'60');await f.ui.input(f.ctx,s,'1');
  const [row]=await f.c.list();assert.equal(row.policy.budgetUsdc,60);assert.equal(row.assessment.suitability,'unsuitable');
 }finally{await f.close();}
});
for(const overrides of [{maxLossUsdc:101},{budgetUsdc:9,maxLossUsdc:1},{budgetUsdc:100001},{durationMinutes:1441}])test(`invalid remaining limits ${JSON.stringify(overrides)}`,async()=>{
 const f=eventHarness();try{
  await enter(f,await start(f),{...f.policy,...overrides});
  assert.equal((await f.c.list()).length,0);assert.equal(f.actions.length,0);
  assert(!buttons(f).some(b=>b.callback_data.startsWith('confirm_liquidity')));
 }finally{await f.close();}
});
test('automatic minimum sizes honor actual per-side precision and fee-aware spread on every mandatory leg',async()=>{
 const f=eventHarness();try{
  for(const o of f.meta.outcomes)o.sideSpecs=[{szDecimals:2},{szDecimals:1}];
  for(const coin of ['#300','#310','#320'])f.books[coin].levels=[[{px:'0.31',sz:'1000'}],[{px:'0.41',sz:'1000'}]];
  for(const coin of ['#301','#311','#321'])f.books[coin].levels=[[{px:'0.59',sz:'1000'}],[{px:'0.69',sz:'1000'}]];
  await enter(f,await start(f));const [s]=await f.c.list();assert(s);
  assert.deepEqual(s.legs.map(l=>l.size),[32.26,17,32.26,17,32.26,17]);
  for(const l of s.legs){assert(l.bid*l.size>=10);assert(s.policy.minSpread>l.feeRate*(l.bid+l.ask));}
  assert(s.policy.minSpread<=Math.max(...s.legs.map(l=>l.feeRate*(l.bid+l.ask)))+0.00002+1e-10);
  assert(s.assessment.requiredBudgetUsdc<=100);assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
for(const defect of ['fallback','fees','stale','near deadline','narrow'])test(`automatic assessment fails closed: ${defect}`,async()=>{
 const f=eventHarness();try{
  if(defect==='fallback')f.books['#321'].levels=[[],[]];
  if(defect==='fees')delete f.fees.userSpotCrossRate;
  if(defect==='stale')f.books['#321'].time-=10000;
  if(defect==='near deadline')f.meta.outcomes[2].expiry=Date.now()+10000;
  if(defect==='narrow')for(const book of Object.values(f.books))book.levels=[[{px:'0.499',sz:'1000'}],[{px:'0.501',sz:'1000'}]];
  await enter(f,await start(f));const [s]=await f.c.list();
  if(defect==='narrow'){assert(s);assert.equal(s.assessment.suitability,'unsuitable');assert.equal(s.legs.length,6);}
  else {assert.equal(s,undefined);assert.match(f.messages.at(-1).text,/Automatic assessment blocked/);}
  assert(!buttons(f).some(b=>b.callback_data.startsWith('confirm_liquidity')));assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
