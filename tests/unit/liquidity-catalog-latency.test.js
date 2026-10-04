import test from 'node:test';
import assert from 'node:assert/strict';
import {eventHarness} from './liquidity-event-harness.js';
import {liquidityCatalogue} from '../../src/modules/liquidity/catalog.js';
import * as runtime from '../../src/modules/bot/runtime.js';
import {handleCallbackQuery} from '../../src/modules/bot/routing/callback-router.js';
async function route(f,data){f.ctx.callbackQuery={data};await handleCallbackQuery(f.ctx);}
function many(f){f.meta.questions=[];f.meta.outcomes=Array.from({length:100},(_,i)=>({...f.meta.outcomes[0],outcome:100+i,name:`Candidate ${i}`}));}
function timed(f){let at=Date.now(),calls=[];f.client.getOrderbook=async coin=>{calls.push(coin);at+=80;return {coin,time:at,levels:[[{px:'0.4',sz:'1000'}],[{px:'0.6',sz:'1000'}]]};};return {calls,now:()=>at};}
test('bounded page: first page and navigation do not scan unrelated universe',async()=>{
 const f=eventHarness({standalone:true});try{many(f);const c=timed(f),start=c.now();
 const first=await liquidityCatalogue(f.client,{page:1,pageSize:5,now:c.now});
 assert.equal(first.length,5);assert.equal(c.calls.length,10);assert(c.now()-start<2000);assert.equal(first.pagination.page,1);assert.equal(first.pagination.pages,20);assert.equal(first.summary.unscanned,95);assert(first.summary.partial);
 const before=c.calls.length,next=await liquidityCatalogue(f.client,{page:2,pageSize:5,now:c.now});assert.equal(next.length,5);assert.equal(c.calls.length-before,10);assert(!c.calls.slice(before).some(x=>c.calls.slice(0,before).includes(x)));
 }finally{await f.close();}
});
test('real router first/next/previous are page-directed and selected always rereads both legs',async()=>{
 const f=eventHarness({routed:true,standalone:true});try{many(f);const c=timed(f);const read=f.client.getOrderbook;f.client.getOrderbook=async coin=>({...await read(coin),time:Date.now()});await route(f,'liq:new:live');assert.equal(c.calls.length,10);
 let s=runtime.userStates.get(f.owner),index=s.choices.findIndex(x=>x.kind==='view'&&x.view.page===2);assert(index>=0);await route(f,`liq:pick:${s.token}:${index}`);assert.equal(c.calls.length,20);
 s=runtime.userStates.get(f.owner);index=s.choices.findIndex(x=>x.kind==='view'&&x.view.page===1);await route(f,`liq:pick:${s.token}:${index}`);assert.equal(c.calls.length,30);
 s=runtime.userStates.get(f.owner);index=s.choices.findIndex(x=>x.kind==='event');await route(f,`liq:pick:${s.token}:${index}`);assert.equal(c.calls.length,32);assert.equal(runtime.userStates.get(f.owner).state,'LIQUIDITY_INPUT');assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
for(const change of ['books','fees','metadata','mode'])test(`page revisit reads current ${change}, not cached admission`,async()=>{
 const f=eventHarness({standalone:true});try{many(f);const c=timed(f);await liquidityCatalogue(f.client,{page:1,now:c.now});
 if(change==='books')f.client.getOrderbook=async coin=>({coin,time:c.now(),levels:[[],[]]});
 if(change==='fees')f.client.getUserFees=async()=>({...f.fees,userSpotCrossRate:'0.02',feeSchedule:{spotCross:'0.02',spotAdd:'0.02'}});
 if(change==='metadata')f.meta.outcomes.splice(0,5);
 if(change==='mode'){for(const o of f.meta.outcomes){o.name='binaryPrice';o.description='perp:xyz:XYZ100|priceDescription:Index|seconds:90|threshold:30870|time:20261009-2000';}}
 const next=await liquidityCatalogue(f.client,{page:1,now:c.now});
 if(change==='metadata'){assert.equal(next[0].outcomeId,105);assert.equal(next.pagination.pages,19);}else assert.equal(next.length,0);
 if(change==='mode'){const observe=await liquidityCatalogue(f.client,{page:1,mode:'observe',now:c.now});assert.equal(observe.length,5);}
 assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
for(const language of ['en','ru'])test(`unknown candidate window retains next/retry without verified empty (${language})`,async()=>{
 const f=eventHarness({routed:true,standalone:true,language});try{many(f);const read=f.client.getOrderbook;f.client.getOrderbook=async coin=>({...await read(coin),time:Date.now()-10000});await route(f,'liq:new:live');
 const {getTranslator}=await import('../../src/modules/i18n.js'),t=await getTranslator(language),s=runtime.userStates.get(f.owner);
 assert(f.messages.at(-1).text.includes(t('liq_catalog_page_unknown')));assert(!f.messages.at(-1).text.includes(t('liq_no_sufficient_books')));
 assert(s.choices.some(x=>x.kind==='view'&&x.view.page===2));assert(s.choices.some(x=>x.kind==='view'&&x.view.page===1));assert(!s.choices.some(x=>x.kind==='event'));assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
for(const members of [12,24,25])test(`whole-event page budget: ${members*2} mandatory books, never publish a subset`,async()=>{
 const f=eventHarness({standalone:true});try{many(f);const ids=f.meta.outcomes.slice(0,members).map(o=>o.outcome);f.meta.questions=[{question:55,name:'Large event',namedOutcomes:ids.slice(0,-1),fallbackOutcome:ids.at(-1),settledNamedOutcomes:[]}];const c=timed(f);
 const result=await liquidityCatalogue(f.client,{page:1,now:c.now});
 if(members<=24){assert.equal(c.calls.length,members*2);assert.deepEqual(result.map(e=>e.questionId),[55]);assert.equal(result.summary.qualified,1);}
 else {assert.equal(c.calls.length,0);assert.equal(result.length,0);assert.equal(result.summary.unknown,1);assert.equal(result.summary.unscanned,75);const selected=await liquidityCatalogue(f.client,{selected:{type:'question',id:55},now:c.now});assert.equal(c.calls.length,50);assert.equal(selected.length,1);}
 assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
for(const navigation of ['menu','cancel'])test(`visible first-loading ${navigation} aborts actual metadata HTTP and suppresses late output`,{timeout:5000},async()=>{
 const f=eventHarness({routed:true,standalone:true}),original=globalThis.fetch;let release,pending;try{
 let entered,aborted=0;const reached=new Promise(r=>entered=r),held=new Promise(r=>release=r);
 globalThis.fetch=async(url,{body,signal})=>{assert.equal(JSON.parse(body).type,'outcomeMeta');entered();return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{aborted++;reject(Error('Controlled abort'));},{once:true});held.then(()=>resolve({ok:true,json:async()=>structuredClone(f.meta)}));});};
 const {HLClient}=await import('../../src/modules/hyperliquid.js');f.client.getOutcomeMeta=HLClient.prototype.getOutcomeMeta.bind(f.client);f.client._infoRequest=HLClient.prototype._infoRequest.bind(f.client);
 pending=route(f,'liq:new:live');await reached;const s=runtime.userStates.get(f.owner),index=s.choices.findIndex(x=>x.kind===navigation);assert(index>=0);await route(f,`liq:pick:${s.token}:${index}`);const count=f.messages.length;await pending;assert.equal(aborted,1);release();await new Promise(r=>setTimeout(r,10));assert.equal(f.messages.length,count);assert(!runtime.userStates.has(f.owner));assert.equal(f.actions.length,0);
 }finally{release?.();await pending;globalThis.fetch=original;await f.close();}
});
