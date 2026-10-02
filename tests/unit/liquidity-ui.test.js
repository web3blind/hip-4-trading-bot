import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {eventHarness} from './liquidity-event-harness.js';
import * as runtime from '../../src/modules/bot/runtime.js';
import {resetOutcomeCache} from '../../src/modules/bot/features/outcomes.js';
import {handleCallbackQuery} from '../../src/modules/bot/routing/callback-router.js';
import {handleTextMessage} from '../../src/modules/bot/routing/text-router.js';
import {getTranslator} from '../../src/modules/i18n.js';
import {mainMenuKeyboard} from '../../src/modules/bot/ui/keyboards.js';
const buttons=f=>f.messages.findLast(m=>m.extra?.reply_markup).extra.reply_markup.inline_keyboard.flat();
for(const navigation of ['liq:cancel','back_menu','liq:new:observe'])test(`pending real MCP assessment cannot replace newer router state after ${navigation}`,async()=>{
 const f=eventHarness();resetOutcomeCache();let release;try{
  let entered;const reached=new Promise(r=>entered=r),hold=new Promise(r=>release=r),original=f.client.getOrderbook;
  f.client.getOrderbook=async coin=>{entered();await hold;return original(coin);};
  const pending=f.propose();await reached;
  f.client.getOrderbook=original;
  f.ctx.callbackQuery={data:navigation};await handleCallbackQuery(f.ctx);
  const retained=runtime.userStates.get(f.owner),count=f.messages.length;
  release();await pending.catch(error=>assert.match(error.message,/Telegram|abandon|changed|cancel/i));
  assert.equal(runtime.userStates.get(f.owner),retained);assert.equal(f.messages.length,count);
  assert(!(await f.c.list()).some(s=>s.status==='draft'));assert.equal(f.actions.length,0);
  assert(!f.messages.slice(count).some(m=>m.extra?.reply_markup?.inline_keyboard.flat().some(b=>b.callback_data.startsWith('confirm_liquidity'))));
 }finally{release?.();await f.close();}
});
for(const navigation of ['liq:cancel','back_menu','liq:new:observe'])for(const result of ['resolve','reject'])test(`delivered MCP second assessment ${result} preserves newer router state after ${navigation}`,async()=>{
 const f=eventHarness();resetOutcomeCache();let release;try{
  let entered;const reached=new Promise(r=>entered=r),hold=new Promise(r=>release=r),assess=f.api.assessLiquiditySession;
  f.api.assessLiquiditySession=async id=>{entered();await hold;if(result==='reject')throw Error('Delayed review assessment failed');return assess(id);};
  const outcome=f.propose().then(value=>({value}),error=>({error}));await reached;
  assert.equal(runtime.userStates.get(f.owner).state,'LIQUIDITY_REVIEW_LOADING');
  const draft=(await f.c.list())[0];assert.equal(draft.status,'draft');
  f.ctx.callbackQuery={data:navigation};await handleCallbackQuery(f.ctx);
  const retained=runtime.userStates.get(f.owner),count=f.messages.length;
  release();const delivered=await outcome;
  assert(delivered.error,'Abandoned review must not report successful MCP delivery');
  assert.match(delivered.error.message,/Telegram|abandon|deliver|failed/i);
  assert.equal(runtime.userStates.get(f.owner),retained);assert.equal(f.messages.length,count);
  assert.equal((await f.c.get(draft.id)).status,'stopped');
  await assert.rejects(f.c.approve(draft.id,{ownerId:f.owner}));
  assert.equal(f.actions.length,0);
  assert(!f.messages.slice(count).some(m=>m.extra?.reply_markup?.inline_keyboard.flat().some(b=>b.callback_data.startsWith('confirm_liquidity'))));
 }finally{release?.();await f.close();}
});
for(const failure of ['assessment','Telegram'])test(`failed delivered MCP review ${failure} stops draft and removes owned confirmation`,async()=>{
 const f=eventHarness();try{
  if(failure==='assessment')f.api.assessLiquiditySession=async()=>{throw Error('Review assessment failed');};
  else {f.ctx.editMessageText=async()=>{throw Error('Telegram edit failed');};f.ctx.reply=async()=>{throw Error('Telegram send failed');};}
  const outcome=await f.propose().then(value=>({value}),error=>({error}));
  assert(outcome.error,'Failed review must not report successful MCP delivery');
  const rows=await f.c.list();assert.equal(rows.length,1);assert.equal(rows[0].status,'stopped');
  assert.equal(runtime.userStates.get(f.owner),undefined);
  await assert.rejects(f.c.approve(rows[0].id,{ownerId:f.owner}));assert.equal(f.actions.length,0);
  if(failure==='assessment'){const t=await getTranslator('en');assert.equal(f.messages.at(-1).text,t('liq_unavailable'));}
 }finally{await f.close();}
});
for(const language of ['en','ru']){
 test(`each connected sizing and deficient-side reason row names participant and side (${language})`,async()=>{
  const f=eventHarness({language});try{
   f.books['#321'].levels=[[],[]];const s=await f.propose(),t=await getTranslator(language),lines=f.messages.map(m=>m.text).join('\n').split('\n');
   for(const leg of s.assessment.legs.filter(l=>!l.unavailable)){
    const row=lines.find(l=>l.includes(leg.coin)&&l.includes(t('liq_minimum_shares')));assert(row);
    assert(row.includes(leg.name)&&row.includes(leg.sideName),row);
   }
   const reason=lines.find(l=>l.includes('#321')&&l.includes(t('liq_assessment_no_two_sided_book')));
   assert.match(reason,/Fallback.*NO.*#321/);assert.equal(f.actions.length,0);
  }finally{await f.close();}
 });
 test(`imbalanced book connected review has readable localized reason and per-row participant/side (${language})`,async()=>{
  const f=eventHarness({language});try{
   f.books['#320'].levels[1][0].sz='10000';
   const s=await f.propose();assert(s.assessment.reasons.some(r=>r.code==='book_imbalance'));
   const t=await getTranslator(language),text=f.messages.map(m=>m.text).join('\n');
   assert(!/liq_assessment_/.test(text));assert(text.includes(t('liq_assessment_book_imbalance')));
   const reason=text.split('\n').find(l=>l.includes(t('liq_assessment_book_imbalance')));assert.match(reason,/Fallback.*YES.*#320/);
   for(const leg of s.assessment.legs.filter(l=>!l.unavailable)){
    const row=text.split('\n').find(l=>l.includes(leg.coin)&&l.includes(t('liq_minimum_shares')));
    assert(row);assert(row.includes(leg.name));assert(row.includes(leg.sideName));
   }
   assert(!buttons(f).some(b=>b.callback_data.startsWith('confirm_liquidity')));assert.equal(f.actions.length,0);
  }finally{await f.close();}
 });
 for(const mode of ['live','observe'])test(`all connected ${mode} review chunks exclude incentives and keep financial caution (${language})`,async()=>{
  const f=eventHarness({language});try{
   await f.propose({mode});const text=f.messages.map(m=>m.text).join('\n'),t=await getTranslator(language);
   assert(!/reward|campaign|eligibility|payout|наград|кампани|выплат/i.test(text));
   assert(text.includes(t('liq_merged_book')));assert(text.includes(t('liq_risk')));assert(text.includes(t('liq_all_sides')));
   assert.equal(f.actions.length,0);
  }finally{await f.close();}
 });
}
async function pick(f,text) {const b=buttons(f).find(b=>b.text===text);assert(b,`Missing ${text}`);await f.ui.choose(f.ctx,b.callback_data);}
async function values(f) {for(const k of ['durationMinutes','budgetUsdc','maxLossUsdc'])await f.ui.input(f.ctx,runtime.userStates.get(f.owner),String(f.policy[k]));}
for(const language of ['en','ru']) test(`connected Telegram event-only wizard and reviewed economics, private one-use owner grant (${language})`,async()=>{
 const f=eventHarness({language});resetOutcomeCache();try {
  await f.ui.menu(f.ctx);assert(!buttons(f).some(b=>/campaign/.test(b.callback_data)));
  await f.ui.start(f.ctx,'live');assert.equal(runtime.userStates.get(f.owner).state,'LIQUIDITY_CATALOG');
  await pick(f,'Championship');assert.equal(runtime.userStates.get(f.owner).state,'LIQUIDITY_INPUT');
  assert.deepEqual(runtime.userStates.get(f.owner).policy.event,{type:'question',id:3});assert.equal(runtime.userStates.get(f.owner).policy.coin,undefined);
  assert(!buttons(f).some(b=>/side|outcome/.test(b.callback_data)));
  await values(f);const rows=await f.c.list();assert.equal(rows.length,1);assert.equal(rows[0].status,'draft');assert.equal(rows[0].legs.length,6);
  const text=f.messages.map(m=>m.text).join('\n');for(const coin of ['#300','#301','#310','#311','#320','#321'])assert(text.includes(coin));
  assert(!/reward|campaign|payout|награды|выплаты/i.test(text));assert(!/liq_assessment_/.test(text));assert.equal(f.actions.length,0);
  await f.confirm();await f.ui.confirm(f.ctx);assert.equal((await f.c.get(rows[0].id)).status,'active');assert.equal(f.actions.length,0);
  await f.c.tick();assert.equal(f.actions.filter(a=>a.type==='order').length,1);await f.ui.stop(f.ctx,rows[0].id);assert.equal((await f.c.get(rows[0].id)).status,'stopped');
 }finally{await f.close();}
});
test('standalone binary selects both sides; Back preserves event choice instead of offering a side picker',async()=>{
 const f=eventHarness({standalone:true});resetOutcomeCache();try {
  await f.ui.start(f.ctx,'observe');await pick(f,'Runner 30');assert.deepEqual(runtime.userStates.get(f.owner).policy.event,{type:'standalone',id:30});
  const back=buttons(f).find(b=>b.callback_data.startsWith('liq:back:'));await f.ui.stepBack(f.ctx,'stale');assert.equal(runtime.userStates.get(f.owner).index,0);
  await f.ui.stepBack(f.ctx,back.callback_data.slice(9));assert.equal(runtime.userStates.get(f.owner).state,'LIQUIDITY_CATALOG');await pick(f,'Runner 30');
  f.policy.mode='observe';await values(f);const s=(await f.c.list())[0];assert.equal(s.legs.length,2);await f.confirm();await f.c.tick();assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
test('deficient fallback named before launch; no confirmation when unsuitable',async()=>{
 const f=eventHarness();try {
  f.books['#320'].levels=[[],[]];const s=await f.propose();assert.equal((await f.c.get(s.id)).assessment.suitability,'unsuitable');
  const text=f.messages.map(m=>m.text).join('\n');assert.match(text,/Fallback/);assert(text.includes('#320'));
  assert(!buttons(f).some(b=>b.callback_data.startsWith('confirm_liquidity_session:')));await f.ui.confirm(f.ctx);assert.equal((await f.c.get(s.id)).status,'draft');assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
test('missing mandatory fallback shows both deficient sides and unknown minimum before confirmation',async()=>{
 const f=eventHarness();try {
  delete f.meta.questions[0].fallbackOutcome;const s=await f.propose();
  assert.equal(s.assessment.suitability,'unavailable');assert.equal(s.assessment.requiredBudgetUsdc,null);assert.equal(s.assessment.minimumBudgetUsdc,null);assert.equal(s.legs.filter(l=>l.fallback).length,2);
  const text=f.messages.map(m=>m.text).join('\n');assert.match(text,/Fallback missing/);assert.match(text,/Assessment unavailable/);assert(!buttons(f).some(b=>b.callback_data.startsWith('confirm_liquidity_session:')));assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
test('group, foreign owner, stale or changed client binding cannot grant',async()=>{
 const f=eventHarness();try {
  const s=await f.propose(),count=f.messages.length;
  await f.ui.showReview({...f.ctx,chat:{id:-1,type:'group'}},s.id);await f.ui.showReview({...f.ctx,from:{id:88}},s.id);assert.equal(f.messages.length,count);
  const old=buttons(f).find(b=>b.callback_data.startsWith('confirm_liquidity_session:')).callback_data;await f.ui.cancel(f.ctx);assert.equal(runtime.consumeConfirmation(f.owner,old),null);await f.ui.confirm(f.ctx);
  await f.ui.showReview(f.ctx,s.id);runtime.setHLClient({...f.client});await f.ui.confirm(f.ctx);assert.equal((await f.c.get(s.id)).status,'draft');assert.equal(f.actions.length,0);runtime.setHLClient(f.client);
 }finally{await f.close();}
});
test('real callback and text routers preserve event-only catalog, reject side-token and abandoned wizard callbacks',async()=>{
 const f=eventHarness();resetOutcomeCache();try {
  const t=await getTranslator('en');assert(mainMenuKeyboard(t).inline_keyboard.flat().some(b=>b.callback_data==='liq:menu'));
  const route=async(data,ctx=f.ctx)=>{ctx.callbackQuery={data};await handleCallbackQuery(ctx);};
  await route('liq:new:live',{...f.ctx,chat:{id:-1,type:'group'}});assert.equal(f.messages.length,0);
  await route('liq:new:live');f.ctx.message={text:'#300'};await handleTextMessage(f.ctx);assert.equal(runtime.userStates.get(f.owner).policy.coin,undefined);
  const selected=buttons(f).find(b=>b.text==='Championship').callback_data;await route(selected);assert.equal(runtime.userStates.get(f.owner).state,'LIQUIDITY_INPUT');
  const back=buttons(f).find(b=>b.callback_data.startsWith('liq:back:')).callback_data;await route('back_menu');assert.equal(runtime.userStates.has(f.owner),false);await route(back);assert.equal(runtime.userStates.has(f.owner),false);
 }finally{await f.close();}
});
for(const replacement of ['cancel','new start','client'])test(`async catalog refresh cannot revive or replace state after ${replacement}`,async()=>{
 const f=eventHarness();resetOutcomeCache();try {
  let entered,release;const reached=new Promise(r=>entered=r),hold=new Promise(r=>release=r),original=f.client.getOutcomeMeta;
  f.client.getOutcomeMeta=async()=>{entered();await hold;return original();};const loading=f.ui.start(f.ctx,'live');await reached;
  if(replacement==='cancel')await f.ui.cancel(f.ctx);
  if(replacement==='client')runtime.setHLClient({...f.client});
  let newer;
  if(replacement==='new start'){f.client.getOutcomeMeta=original;newer=f.ui.start(f.ctx,'observe');await new Promise(setImmediate);}
  const retained=runtime.userStates.get(f.owner);release();await loading;if(newer)await newer;
  assert.equal(runtime.userStates.get(f.owner),retained);assert.equal(f.actions.length,0);runtime.setHLClient(f.client);
 }finally{await f.close();}
});
test('cancel while proposal is awaiting prevents late confirmation and revokes the unused draft',async()=>{
 const f=eventHarness();resetOutcomeCache();try {
  await f.ui.start(f.ctx,'live');await pick(f,'Championship');
  const fields=['durationMinutes','budgetUsdc'];
  for(const k of fields)await f.ui.input(f.ctx,runtime.userStates.get(f.owner),String(f.policy[k]));
  let entered,release;const reached=new Promise(r=>entered=r),hold=new Promise(r=>release=r),original=f.api.proposeLiquiditySession;
  f.api.proposeLiquiditySession=async(...args)=>{entered();await hold;return original(...args);};
  const pending=f.ui.input(f.ctx,runtime.userStates.get(f.owner),String(f.policy.maxLossUsdc));await reached;await f.ui.cancel(f.ctx);release();await pending;
  assert.equal(runtime.userStates.has(f.owner),false);assert(!buttons(f).some(b=>b.callback_data.startsWith('confirm_liquidity_session:')));const rows=await f.c.list();assert.equal(rows[0].status,'stopped');assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
test('invalid numeric input and inconsistent total bounds retain the event, never accept raw coin/side',async()=>{
 const f=eventHarness();resetOutcomeCache();try {
  await f.ui.start(f.ctx,'live');await pick(f,'Championship');const s=runtime.userStates.get(f.owner);
  for(const raw of ['#300','-1','0','NaN','1abc']){await f.ui.input(f.ctx,s,raw);assert.equal(s.index,0);}
  const broken={...f.policy,maxLossUsdc:101};for(const k of ['durationMinutes','budgetUsdc','maxLossUsdc'])await f.ui.input(f.ctx,s,String(broken[k]));
  assert.equal(s.index,0);assert.deepEqual(s.policy.event,{type:'question',id:3});assert.equal((await f.c.list()).length,0);
 }finally{await f.close();}
});
test('locale dictionary key parity and all assessment reason keys have EN/RU copy',()=>{
 const en=JSON.parse(readFileSync(new URL('../../src/locales/en.json',import.meta.url))),ru=JSON.parse(readFileSync(new URL('../../src/locales/ru.json',import.meta.url)));
 assert.deepEqual(Object.keys(en).sort(),Object.keys(ru).sort());for(const code of ['membership_unavailable','leg_unavailable','insufficient_depth','insufficient_spendable_usdc','insufficient_shared_budget','merged_book_mismatch','imbalance_and_adverse_selection'])assert(en['liq_assessment_'+code]&&ru['liq_assessment_'+code]);
});
