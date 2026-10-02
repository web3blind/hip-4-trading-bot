import test from 'node:test';
import assert from 'node:assert/strict';
import {eventHarness} from './liquidity-event-harness.js';
import * as runtime from '../../src/modules/bot/runtime.js';
import {resetOutcomeCache} from '../../src/modules/bot/features/outcomes.js';
import {getTranslator} from '../../src/modules/i18n.js';

const fields=['durationMinutes','budgetUsdc','orderSizeShares','minPrice','maxPrice','minSpread','maxLossUsdc','maxActions'];
const prompts=['liq_duration','liq_budget','liq_order_size','liq_min_price','liq_max_price','liq_spread','liq_loss','liq_actions'];
const buttons=f=>f.messages.findLast(m=>m.extra?.reply_markup).extra.reply_markup.inline_keyboard.flat();
async function start(f,mode='live') {
 resetOutcomeCache();await f.ui.start(f.ctx,mode);
 const choice=buttons(f).find(b=>b.text==='Championship');assert(choice);
 await f.ui.choose(f.ctx,choice.callback_data);
 return runtime.userStates.get(f.owner);
}
async function enter(f,state,policy=f.policy) {
 for(const field of fields)await f.ui.input(f.ctx,state,String(policy[field]));
}
async function back(f) {
 const button=buttons(f).find(b=>b.callback_data.startsWith('liq:back:'));assert(button);
 await f.ui.stepBack(f.ctx,button.callback_data.slice(9));
}
for(const language of ['en','ru'])test(`eight prompts, automatic persisted ceiling, private approval and bounded maker execution (${language})`,async()=>{
 const f=eventHarness({language});try {
  const state=await start(f),t=await getTranslator(language);
  for(const [i,field] of fields.entries()) {
   assert.equal(f.messages.at(-1).text,`${t('liq_step')} ${i+1}/8\n${t(prompts[i])}`);
   await f.ui.input(f.ctx,state,String(f.policy[field]));
  }
  const [s]=await f.c.list();assert(s);assert.equal(s.policy.maxInventoryShares,500);
  assert.equal(s.policy.budgetUsdc,100);assert.equal(s.policy.orderSizeShares,30);
  assert.equal(s.policy.maxLossUsdc,30);assert.equal(s.policy.maxActions,12);
  assert.equal(s.status,'draft');assert.equal(s.assessment.suitability,'conditional');
  assert.equal(f.actions.length,0);
  const text=f.messages.map(m=>m.text).join('\n');
  assert.notEqual(t('liq_inventory_auto_note'),'liq_inventory_auto_note');assert(text.includes(t('liq_inventory_auto_note')));
  assert(text.includes(`${t('liq_inventory_label')}: 500`));
  const grant=buttons(f).find(b=>b.callback_data.startsWith('confirm_liquidity_session:')).callback_data;
  await f.confirm();assert.equal((await f.c.get(s.id)).status,'active');
  assert.equal(runtime.consumeConfirmation(f.owner,grant),null);
  await f.c.tick();assert.equal(f.actions.filter(a=>a.type==='order').length,1);
  const active=await f.c.get(s.id);
  assert.equal(active.policy.maxInventoryShares,500);
  assert(active.orders.filter(o=>o.isBuy).reduce((n,o)=>n+o.size,0)<=500);
  await f.ui.stop(f.ctx,s.id);assert.equal((await f.c.get(s.id)).status,'stopped');
 }finally{await f.close();}
});
for(const [budget,minPrice,cap] of [[100,.3,334],[10,.00001,1000000],[100000,.00001,1000000],[10,.99998,11],[100000,.99998,100003]])test(`bounded ceiling from budget ${budget} / minimum price ${minPrice}`,async()=>{
 const f=eventHarness();try {
  f.setSpot(100000);const state=await start(f,'observe');
  await enter(f,state,{...f.policy,budgetUsdc:budget,minPrice,maxPrice:.99999,maxLossUsdc:1,orderSizeShares:1});
  const [s]=await f.c.list();assert(s);assert.equal(s.policy.maxInventoryShares,cap);
  assert(Number.isFinite(s.policy.maxInventoryShares));assert(s.policy.maxInventoryShares>=1&&s.policy.maxInventoryShares<=1000000);
  assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
test('Back edits both price and budget without retaining a stale automatic ceiling',async()=>{
 const f=eventHarness();try {
  const state=await start(f);
  for(const field of fields.slice(0,4))await f.ui.input(f.ctx,state,String(f.policy[field]));
  await back(f);assert.equal(state.index,3);assert.equal(state.policy.maxInventoryShares,undefined);
  await f.ui.input(f.ctx,state,'.3');assert.equal(state.index,3); // existing decimal grammar is unchanged
  await f.ui.input(f.ctx,state,'0.3');assert.equal(state.index,4);
  while(state.index>1)await back(f);
  assert.equal(state.policy.maxInventoryShares,undefined);
  await f.ui.input(f.ctx,state,'120');
  for(const field of fields.slice(2))await f.ui.input(f.ctx,state,String(field==='minPrice'?.3:f.policy[field]));
  const [s]=await f.c.list();assert(s);assert.equal(s.policy.maxInventoryShares,400);assert.equal(s.policy.budgetUsdc,120);
  assert.equal(s.assessment.suitability,'conditional');assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
for(const overrides of [{orderSizeShares:501},{maxLossUsdc:101},{minPrice:.8,maxPrice:.2}])test(`inconsistent monetary/order limits reset without proposing: ${JSON.stringify(overrides)}`,async()=>{
 const f=eventHarness();try {
  const state=await start(f);await enter(f,state,{...f.policy,...overrides});
  assert.equal(state.state,'LIQUIDITY_INPUT');assert.equal(state.index,0);
  assert.equal(state.policy.maxInventoryShares,undefined);assert.equal(state.policy.budgetUsdc,undefined);
  assert.deepEqual(state.policy.event,{type:'question',id:3});assert.equal((await f.c.list()).length,0);
  assert.equal(f.actions.length,0);
  await enter(f,state);assert.equal((await f.c.list())[0].policy.maxInventoryShares,500);
 }finally{await f.close();}
});
for(const overrides of [{budgetUsdc:9,maxLossUsdc:1},{budgetUsdc:100001},{minSpread:.50001},{orderSizeShares:1000001,minPrice:.00001}])test(`unsupported limits cannot grant: ${JSON.stringify(overrides)}`,async()=>{
 const f=eventHarness();try {
  const state=await start(f);await enter(f,state,{...f.policy,...overrides});
  assert.equal((await f.c.list()).length,0);assert.equal(f.actions.length,0);
  assert(!buttons(f).some(b=>b.callback_data.startsWith('confirm_liquidity_session:')));
 }finally{await f.close();}
});
test('automatic share ceiling does not bypass all-side budget or fee reservations',async()=>{
 const f=eventHarness();try {
  const state=await start(f);await enter(f,state,{...f.policy,budgetUsdc:72,maxLossUsdc:10});
  const [s]=await f.c.list();assert.equal(s.policy.maxInventoryShares,360);
  assert.equal(s.assessment.suitability,'unsuitable');
  assert(s.assessment.reasons.some(r=>r.code==='insufficient_shared_budget'));
  assert(s.assessment.requiredBudgetUsdc>72); // six buys at 0.4 x 30 need fees/reserves too
  assert(!buttons(f).some(b=>b.callback_data.startsWith('confirm_liquidity_session:')));
  await f.ui.confirm(f.ctx);await f.c.tick();assert.equal(f.actions.length,0);assert.equal((await f.c.get(s.id)).status,'draft');
 }finally{await f.close();}
});
