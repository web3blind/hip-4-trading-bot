import test from 'node:test';
import assert from 'node:assert/strict';
import {eventHarness} from './liquidity-event-harness.js';
import {liquidityCatalogue} from '../../src/modules/liquidity/catalog.js';
import * as runtime from '../../src/modules/bot/runtime.js';
import {handleCallbackQuery} from '../../src/modules/bot/routing/callback-router.js';
const route=async(f,data)=>{f.ctx.callbackQuery={data};await handleCallbackQuery(f.ctx);};
function many(f,n=100){f.meta.questions=[];f.meta.outcomes=Array.from({length:n},(_,i)=>({...f.meta.outcomes[0],outcome:100+i,name:`Candidate ${i}`}));}
function large(f){many(f,25);f.meta.questions=[{question:55,name:'Large complete event',namedOutcomes:f.meta.outcomes.slice(0,-1).map(o=>o.outcome),fallbackOutcome:124,settledNamedOutcomes:[]}];}
function button(f,kind){const s=runtime.userStates.get(f.owner),i=s.choices.findIndex(x=>x.kind===kind);assert(i>=0,`Rendered ${kind} action`);const data=`liq:pick:${s.token}:${i}`;assert(f.messages.at(-1).extra.reply_markup.inline_keyboard.flat().some(b=>b.callback_data===data));return data;}
test('95 weak candidates auto skipped to first five qualified in one routed loading operation',async()=>{
 const f=eventHarness({routed:true,standalone:true});try{many(f);let reads=0;f.client.getOrderbook=async coin=>{reads++;await new Promise(r=>setTimeout(r,2));return {coin,time:Date.now(),levels:Number(coin.slice(1))<1950?[[],[]]:[[{px:'0.4',sz:'1000'}],[{px:'0.6',sz:'1000'}]]};};const start=performance.now();await route(f,'liq:new:live');const s=runtime.userStates.get(f.owner);assert.equal(s.choices.filter(x=>x.kind==='event').length,5);assert.equal(reads,200);assert.equal(f.actions.length,0);console.log(JSON.stringify({fixture:'95 weak then 5 healthy',firstQualifiedMs:Math.round(performance.now()-start),discoveryClicks:0,bookReads:reads}));}finally{await f.close();}
});
for(const language of ['en','ru'])test(`oversized 50-book complete event has explicit verify then distinct fresh select UI (${language})`,async()=>{
 const f=eventHarness({routed:true,standalone:true,language});try{large(f);let reads=[];f.client.getOrderbook=async coin=>{reads.push(coin);return {coin,time:Date.now(),levels:[[{px:'0.4',sz:'1000'}],[{px:'0.6',sz:'1000'}]]};};await route(f,'liq:new:live');assert.equal(reads.length,0);await route(f,button(f,'verify'));assert.equal(new Set(reads).size,50);assert.equal(runtime.userStates.get(f.owner).state,'LIQUIDITY_CATALOG');await route(f,button(f,'event'));assert.equal(reads.length,100);assert.equal(runtime.userStates.get(f.owner).state,'LIQUIDITY_INPUT');assert.equal(f.actions.length,0);}finally{await f.close();}
});
test('progressive read budget preserves continuation and honest unscanned coverage',async()=>{
 const f=eventHarness({standalone:true});try{many(f);let at=Date.now(),reads=0;f.client.getOrderbook=async coin=>{reads++;at+=30;return {coin,time:at,levels:[[],[]]};};const result=await liquidityCatalogue(f.client,{page:1,progressive:true,maxDiscoveryBooks:20,now:()=>at});assert.equal(reads,20);assert.equal(result.summary.weak,10);assert.equal(result.summary.unscanned,90);assert.equal(result.pagination.nextPage,3);assert(result.summary.partial);}finally{await f.close();}
});
for(const phase of ['progressive','large'])for(const navigation of ['menu','cancel'])test(`rendered ${navigation} aborts ${phase} book HTTP; no late publication`,{timeout:5000},async()=>{
 const f=eventHarness({routed:true,standalone:true}),original=globalThis.fetch;let pending,release;try{
  if(phase==='large'){large(f);await route(f,'liq:new:live');}else many(f);
  let entered,aborted=0,count=0;const reached=new Promise(r=>entered=r),held=new Promise(r=>release=r);
  globalThis.fetch=async(url,{body,signal})=>{const request=JSON.parse(body);assert.equal(request.type,'l2Book');count++;
   if(phase==='progressive'&&count<=10)return {ok:true,json:async()=>({time:Date.now(),levels:[[],[]]})};
   entered();return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{aborted++;reject(Error('Controlled abort'));},{once:true});held.then(()=>resolve({ok:true,json:async()=>({time:Date.now(),levels:[[{px:'0.4',sz:'1000'}],[{px:'0.6',sz:'1000'}]]})}));});
  };
  f.client.getOrderbook=f.client.constructor.prototype.getOrderbook.bind(f.client);f.client._infoRequest=f.client.constructor.prototype._infoRequest.bind(f.client);
  pending=route(f,phase==='large'?button(f,'verify'):'liq:new:live');await reached;await route(f,button(f,navigation));const messages=f.messages.length;await pending;assert(aborted>0);release();await new Promise(r=>setTimeout(r,20));assert.equal(f.messages.length,messages);assert(!runtime.userStates.has(f.owner));assert.equal(f.actions.length,0);
 }finally{release?.();await pending;globalThis.fetch=original;await f.close();}
});
for(const drift of ['metadata','account','network','mode','ttl','client'])test(`continuation resets on ${drift} drift, never supplies admission proof`,async()=>{
 const f=eventHarness({standalone:true});try{many(f);let at=Date.now(),calls=[];f.client.getOrderbook=async coin=>{calls.push(coin);return {time:at,levels:[[],[]]};};const first=await liquidityCatalogue(f.client,{page:1,progressive:true,maxDiscoveryBooks:10,now:()=>at});calls=[];
 if(drift==='metadata')f.meta.outcomes.reverse();if(drift==='account')f.client.address='0x'+'2'.repeat(40);if(drift==='network')f.client.network='mainnet';if(drift==='ttl')at+=60001;
 const next=await liquidityCatalogue(drift==='client'?{...f.client}:f.client,{page:2,cursor:first.cursor,progressive:true,maxDiscoveryBooks:10,mode:drift==='mode'?'observe':'live',now:()=>at});assert.equal(next.pagination.page,1);assert.equal(calls.length,10);assert.equal(next.length,0);assert.equal(next.summary.weak,5);assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
test('large stale verification remains specifically unknown; rendered retry is full and one-use',async()=>{
 const f=eventHarness({routed:true,standalone:true});try{large(f);await route(f,'liq:new:live');let reads=0;f.client.getOrderbook=async()=>{reads++;return {time:Date.now()-10000,levels:[[{px:'0.4',sz:'1000'}],[{px:'0.6',sz:'1000'}]]};};await route(f,button(f,'verify'));assert.equal(runtime.userStates.get(f.owner).state,'LIQUIDITY_CATALOG');assert(f.messages.at(-1).text.includes('Complete-event suitability is unknown'));const retry=button(f,'verify');f.client.getOrderbook=async()=>{reads++;return {time:Date.now(),levels:[[{px:'0.4',sz:'1000'}],[{px:'0.6',sz:'1000'}]]};};await route(f,retry);assert.equal(reads,100);await route(f,retry);assert.equal(reads,100);assert.equal(f.actions.length,0);}finally{await f.close();}
});
test('80ms public-book fixture measures first QUALIFIED and clicks before/after, not empty-window latency',{timeout:15000},async()=>{
 const f=eventHarness({standalone:true});try{many(f);const metrics=[];for(const progressive of [false,true]){
  let books=0,metadata=0,fees=0;f.client.getOutcomeMeta=async()=>{metadata++;return structuredClone(f.meta);};f.client.getUserFees=async()=>{fees++;return f.fees;};
  f.client.getOrderbook=async coin=>{books++;await new Promise(r=>setTimeout(r,80));return {time:Date.now(),levels:Number(coin.slice(1))<1950?[[],[]]:[[{px:'0.4',sz:'1000'}],[{px:'0.6',sz:'1000'}]]};};
  const start=performance.now();let clicks=0,result;for(let page=1;page<=20;page++){result=await liquidityCatalogue(f.client,{page,progressive});if(result.length)break;clicks++;}
  assert.equal(result.length,5);assert.equal(books,200);assert.equal(clicks,progressive?0:19);assert.equal(metadata,progressive?1:20);metrics.push({progressive,firstQualifiedMs:Math.round(performance.now()-start),discoveryClicks:clicks,books,metadata,fees});
 }console.log(JSON.stringify({fixture:'100 standalone; first 95 weak; last 5 healthy; deterministic 80ms/read; concurrency unchanged <=6; no human click dwell included',metrics}));assert.equal(f.actions.length,0);}finally{await f.close();}
});
test('elapsed scheduling budget returns honest continuation without scanning remainder',async()=>{
 const f=eventHarness({standalone:true});try{many(f);let time=Date.now(),books=0;f.client.getOrderbook=async()=>{books++;time+=100;return {time,levels:[[],[]]};};const r=await liquidityCatalogue(f.client,{page:1,progressive:true,discoveryBudgetMs:1500,now:()=>time});assert.equal(books,20);assert.equal(r.pagination.nextPage,3);assert.equal(r.summary.weak,10);assert.equal(r.summary.unscanned,90);assert.equal(r.length,0);assert(r.summary.partial);}finally{await f.close();}
});
for(const phase of ['initial','progressive','large'])for(const drift of ['client','account','network','mode','ttl'])test(`${phase} loading invalidates ${drift} binding and suppresses late publication`,{timeout:3000},async()=>{
 const f=eventHarness({routed:true,standalone:true});let pending,release;try{
  if(phase==='large'){large(f);await route(f,'liq:new:live');}else many(f);
  let enter,aborted=0,calls=0;const reached=new Promise(r=>enter=r),held=new Promise(r=>release=r);
  f.client.getOrderbook=async(coin,{signal})=>{calls++;if(phase==='progressive'&&calls<=10)return {time:Date.now(),levels:[[],[]]};enter();return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{aborted++;reject(Error('Controlled abort'));},{once:true});held.then(()=>resolve({time:Date.now(),levels:[[{px:'0.4',sz:'1000'}],[{px:'0.6',sz:'1000'}]]}));});};
  pending=route(f,phase==='large'?button(f,'verify'):'liq:new:live');await reached;const state=runtime.userStates.get(f.owner),count=f.messages.length;
  if(drift==='client')runtime.setHLClient({...f.client});if(drift==='account')f.client.address='0x'+'2'.repeat(40);if(drift==='network')f.client.network='mainnet';if(drift==='mode')state.policy.mode='observe';if(drift==='ttl')state.expiresAt=0;
  await pending;assert(aborted>0);release();await new Promise(r=>setTimeout(r,10));assert.equal(f.messages.length,count);assert.equal(f.actions.length,0);
 }finally{release?.();await pending;runtime.setHLClient(f.client);await f.close();}
});
