import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolveLiquidityEvent} from '../../src/modules/liquidity/event.js';
import {eventHarness} from './liquidity-event-harness.js';
import * as runtime from '../../src/modules/bot/runtime.js';
import {getTranslator} from '../../src/modules/i18n.js';
import {handleCallbackQuery} from '../../src/modules/bot/routing/callback-router.js';
import {handleTextMessage} from '../../src/modules/bot/routing/text-router.js';
import {liquidityName,liquiditySideName,formatSportsTemplate,liquidityDisplaySide} from '../../src/modules/liquidity/labels.js';
async function route(f,data){f.ctx.callbackQuery={data};await handleCallbackQuery(f.ctx);}
async function text(f,value){f.ctx.message={text:value};await handleTextMessage(f.ctx);}
const fixture=JSON.parse(readFileSync(new URL('./fixtures/liquidity-naming-public.json',import.meta.url)));
const sports=fixture.outcomes.filter(o=>[6214,6215].includes(o.outcome));
const expected=['Houston Texans — Dallas Cowboys · NFL · 04 Oct 2026 17:00 UTC','Chicago Bears — New York Jets · NFL · 04 Oct 2026 17:00 UTC'];
test('recorded public sports events and sides are readable, distinct and fingerprint unchanged',()=>{
 const meta={outcomes:sports,questions:[]};
 const before=JSON.stringify(meta);
 for(const [i,o] of sports.entries()){
  const r=resolveLiquidityEvent(meta,{type:'standalone',id:o.outcome});
  assert.equal(r.label,expected[i]);assert.deepEqual(r.legs.map(l=>l.sideName),i===0?['Houston Texans','Dallas Cowboys']:['Chicago Bears','New York Jets']);
  assert(r.legs.every(l=>l.name===r.label));assert.deepEqual(r.members,[o.outcome]);
  assert.equal(r.fingerprint,createHash('sha256').update(JSON.stringify({question:undefined,specs:[o]})).digest('hex'));
 }
 assert.equal(JSON.stringify(meta),before);
});
test('sports template unknown data falls back to stable identity, not invented teams or sides',()=>{
 for(const outcome of [91,92]){
  const spec={outcome,name:'template:sportsContestWinner',description:'competition:NFL',sideSpecs:[{name:'template:{shortNameA}'},{name:'template:{shortNameB}'}]};
  assert(liquidityName(spec).includes(`#${outcome}`));assert.equal(liquiditySideName(spec,0),'Side 1');
  assert.equal(liquiditySideName({...spec,sideSpecs:[]},1),'Side 2');
 }
 assert.equal(formatSportsTemplate(sports[0].name,sports[0].description),expected[0]);
 assert.equal(liquidityName({outcome:93,name:'template:newUnsupported',description:'secretField:technicalValue'}),'Event #93');
});
test('public grouped sports legs retain participants, draw and fallback as distinct identities',()=>{
 const r=resolveLiquidityEvent(fixture,{type:'question',id:359});
 assert(r.label.startsWith('Croatia — England · UEFA Nations League'));
 assert.deepEqual(r.legs.map(l=>l.name),['Croatia','Croatia','Draw','Draw','England','England','Fallback','Fallback']);
 assert.deepEqual(r.legs.map(l=>l.sideName),['YES','NO','YES','NO','YES','NO','YES','NO']);
});
test('public policy rate title includes authoritative month and institution, not raw keywords',()=>{
 const q=fixture.questions.find(q=>q.question===289),r=resolveLiquidityEvent(fixture,{type:'question',id:289});
 assert(r.label.startsWith("October 2026 · Federal Reserve's Open Market Committee"));
 assert.doesNotMatch(r.label,/template:|policyMeasure:|institution:/);
 assert.equal(r.legs.length,(q.namedOutcomes.length+1)*2);assert(r.legs.some(l=>l.fallback&&l.name==='Fallback'));
});
for(const language of ['en','ru'])test(`standard binary and unknown sports side displays localize (${language})`,async()=>{
 const t=await getTranslator(language);assert.equal(liquidityDisplaySide('YES',t),t('yes'));assert.equal(liquidityDisplaySide('NO',t),t('no'));
 assert.equal(liquidityDisplaySide('Side 2',t),`${t('side')} 2`);assert.equal(liquidityDisplaySide('Houston Texans',t),'Houston Texans');
});
for(const language of ['en','ru'])test(`connected catalogue, selection and assessment use recorded sports identities (${language})`,async()=>{
 const f=eventHarness({language,standalone:true,routed:true});try{
  f.meta.outcomes.splice(0,f.meta.outcomes.length,...structuredClone(sports));
  await route(f,'liq:new:live');
  const buttons=f.messages.at(-1).extra.reply_markup.inline_keyboard.flat();
  for(const title of expected)assert(buttons.some(b=>b.text===title.slice(0,60)));
  await route(f,buttons.find(b=>b.text===expected[0].slice(0,60)).callback_data);
  const state=runtime.userStates.get(f.owner);assert.equal(state.selection.event,expected[0]);
  for(const value of ['30','100','30'])await text(f,value);
  const review=f.messages.map(m=>m.text).join('\n');
  assert(review.includes(expected[0]));
  for(const [coin,team] of [['#62140','Houston Texans'],['#62141','Dallas Cowboys']])assert(review.includes(`· ${team} (${coin})`));
  assert.doesNotMatch(review,/template:|shortName[A-B]|competition:|countedPlay:/);
  const [s]=await f.c.list();assert(s);assert.equal(s.assessment.legs.length,2);assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
