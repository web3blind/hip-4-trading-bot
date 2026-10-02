import test from 'node:test';
import assert from 'node:assert/strict';
import {eventHarness} from './liquidity-event-harness.js';
import * as runtime from '../../src/modules/bot/runtime.js';
import {resetOutcomeCache,fetchAndCacheOutcomes} from '../../src/modules/bot/features/outcomes.js';
import {HLClient} from '../../src/modules/hyperliquid.js';
import {liquidityCatalogue} from '../../src/modules/liquidity/catalog.js';
import {OUTCOMES_PAGE_SIZE} from '../../src/modules/bot/constants.js';
import {getTranslator} from '../../src/modules/i18n.js';
import {handleCallbackQuery} from '../../src/modules/bot/routing/callback-router.js';
const buttons=f=>f.messages.at(-1).extra.reply_markup.inline_keyboard.flat();
async function route(f,data){f.ctx.callbackQuery={data};await handleCallbackQuery(f.ctx);}
async function start(f){resetOutcomeCache();await route(f,'liq:new:live');}
// A scan may finish/reject before a mocked request is reached. Never wait forever
// for that request (Node's file reporter otherwise buffers every prior result).
async function enteredScan(pending,reached){
 let timer;try{
  await Promise.race([reached,pending.then(()=>{throw Error('Scan ended before transport entry');},error=>{throw error;}),
   new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Transport entry timed out')),5000);})]);
 }finally{clearTimeout(timer);}
}
test('scan prerequisite failure completes without an unbounded transport rendezvous',{timeout:1000},async()=>{
 const f=eventHarness({routed:true});try{
  f.client.getOutcomeMeta=async()=>{throw Error('Controlled metadata prerequisite failure');};
  const reached=new Promise(()=>{}),pending=start(f);
  await assert.rejects(enteredScan(pending,reached),/Scan ended before transport entry/);
  assert(f.messages.at(-1).text.includes((await getTranslator('en'))('liq_unavailable')));
  assert.equal(runtime.userStates.has(f.owner),false);assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
for(const language of ['en','ru'])for(const operation of ['page','event'])for(const navigation of ['cancel','back'])test(`visible ${navigation} aborts held ${operation} scan (${language})`,{timeout:5000},async()=>{
 const f=eventHarness({language,routed:true});const originalFetch=globalThis.fetch;let release,pending;try{
  mixedGroups(f);await start(f);const t=await getTranslator(language);
  const visible=buttons(f),navigate=visible.find(b=>b.text===t(navigation==='cancel'?'cancel':'back')).callback_data;
  const pick=visible.find(b=>b.text===(operation==='page'?t('liq_next'):'Group 0')).callback_data;
  let entered,aborted=0,calls=0;const reached=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
  globalThis.fetch=async(url,{body,signal})=>{
   const request=JSON.parse(body);assert.equal(request.type,'l2Book');calls++;entered();
   return new Promise((resolve,reject)=>{
    const fail=()=>{aborted++;reject(Error('Controlled abort'));};
    if(signal.aborted)fail();else signal.addEventListener('abort',fail,{once:true});
    hold.then(()=>resolve({ok:true,json:async()=>structuredClone(f.books[request.coin])}));
   });
  };
  f.client._infoRequest=HLClient.prototype._infoRequest.bind(f.client);
  f.client.getOrderbook=HLClient.prototype.getOrderbook.bind(f.client);
  pending=route(f,pick);await enteredScan(pending,reached);
  const state=runtime.userStates.get(f.owner),token=state.token;
  await route(f,pick);assert.equal(runtime.userStates.get(f.owner),state);assert.equal(state.token,token,'Consumed event/page cannot replay');
  await route(f,navigate);assert.equal(runtime.userStates.has(f.owner),false,'Actually visible navigation invalidates the in-flight scan');
  const count=f.messages.length;await pending;assert.equal(aborted,calls);assert(calls>0&&calls<=6);
  release();await new Promise(r=>setTimeout(r,10));assert.equal(f.messages.length,count);assert.equal(runtime.userStates.has(f.owner),false);
  assert.equal(f.actions.length,0);assert.equal((await f.c.list()).length,0);
 }finally{release?.();await pending;globalThis.fetch=originalFetch;await f.close();}
});
test('final catalogue refreshes earlier healthy evidence after a slow later event',async()=>{
 const f=eventHarness();try{
  mixedGroups(f);f.meta.questions=f.meta.questions.slice(0,2);f.meta.outcomes=f.meta.outcomes.slice(0,6);
  let time=f.time,reads=new Map(),firstFinished=false;
  f.client.getOrderbook=async coin=>{
   reads.set(coin,(reads.get(coin)||0)+1);
   if(Number(coin.slice(1))>=1030&&!firstFinished){await new Promise(r=>setImmediate(r));time+=6000;firstFinished=true;}
   const book=structuredClone(f.books[coin]);book.time=time;return book;
  };
  const events=await liquidityCatalogue(f.client,{now:()=>time});
  assert(events.some(e=>e.questionId===100),'Healthy earlier event is retained using final fresh reads');
  for(const coin of ['#1000','#1001','#1010','#1011','#1020','#1021'])assert.equal(reads.get(coin),2,'Earlier evidence must be refreshed');
  assert([...reads.values()].every(n=>n<=2),'At most one refresh per mandatory book');assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
test('unrefreshable final evidence is UNKNOWN, never a verified empty/weak catalogue',async()=>{
 const f=eventHarness();try{
  mixedGroups(f);f.meta.questions=f.meta.questions.slice(0,2);f.meta.outcomes=f.meta.outcomes.slice(0,6);
  let time=f.time,late=false;const reads=new Map();
  f.client.getOrderbook=async coin=>{
   reads.set(coin,(reads.get(coin)||0)+1);
   if(Number(coin.slice(1))>=1030&&!late){await new Promise(r=>setImmediate(r));time+=6000;late=true;}
   const book=structuredClone(f.books[coin]);book.time=Number(coin.slice(1))<1030?f.time:time;return book;
  };
  await assert.rejects(liquidityCatalogue(f.client,{now:()=>time}),/freshness unavailable/);
  assert([...reads.values()].every(n=>n<=2));assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
for(const language of ['en','ru'])for(const coin of ['#300','#301','#310','#311','#320','#321'])test(`catalogue omits complete event for weak ${coin} (${language}), ordinary catalogue unchanged`,async()=>{
 const f=eventHarness({language,routed:true});try{
  f.books[coin].levels[0][0].sz='1';await start(f);
  const t=await getTranslator(language);assert(f.messages.at(-1).text.includes(t('liq_no_sufficient_books')));
  assert(!buttons(f).some(b=>b.text==='Championship'));
  assert((await fetchAndCacheOutcomes(f.client)).some(e=>e.questionId===3));
  assert.equal(f.actions.length,0);assert.equal((await f.c.list()).length,0);
 }finally{await f.close();}
});
test('selected event quality is refreshed, not taken from displayed catalogue/cache',async()=>{
 const f=eventHarness({routed:true});try{
  await start(f);const pick=buttons(f).find(b=>b.text==='Championship').callback_data;
  f.books['#321'].levels=[[],[]];await route(f,pick);
  assert.notEqual(runtime.userStates.get(f.owner)?.state,'LIQUIDITY_INPUT');assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
for(const language of ['en','ru'])for(const change of ['empty','stale','invalid','api','membership','mirror'])test(`catalogue ${change} fails closed (${language})`,async()=>{
 const f=eventHarness({language,routed:true});try{
  if(change==='empty')f.books['#321'].levels=[[],[]];
  if(change==='stale')f.books['#321'].time=Date.now()-6000;
  if(change==='invalid')f.books['#321'].levels[1][0].sz='bad';
  if(change==='api')f.client.getOrderbook=async()=>{throw Error('API unavailable');};
  if(change==='membership')f.meta.outcomes.pop();
  if(change==='mirror')f.books['#321'].levels[1][0].px='0.7';
  await start(f);assert(!buttons(f).some(b=>b.text==='Championship'));
  const t=await getTranslator(language);assert(f.messages.at(-1).text.includes(t(['api','membership','stale'].includes(change)?'liq_unavailable':'liq_no_sufficient_books')));
 }finally{await f.close();}
});
for(const [precision,bid,ask,depth,expected] of [[0,.4,.6,25,true],[0,.4,.6,24.99,false],[2,.31,.41,32.26,true],[2,.31,.41,32.25,false],[2,.310009,.410009,32.26,true],[2,.310009,.410009,32.25,false]])test(`actual rounded $10 minimum precision=${precision} bid=${bid} depth=${depth}`,async()=>{
 const f=eventHarness({standalone:true,routed:true});try{
  f.meta.outcomes[0].sideSpecs=[{szDecimals:precision},{szDecimals:precision}];
  f.books['#300'].levels=[[{px:String(bid),sz:String(depth)}],[{px:String(ask),sz:String(depth)}]];
  f.books['#301'].levels=[[{px:String(1-ask),sz:String(depth)}],[{px:String(1-bid),sz:String(depth)}]];
  await start(f);assert.equal(buttons(f).some(b=>b.text==='Runner 30'),expected);assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
for(const ratio of [4,4.0001])test(`imbalance ratio ${ratio} uses existing strict >4 boundary`,async()=>{
 const f=eventHarness({standalone:true,routed:true});try{
  f.books['#300'].levels[0][0].sz=String(25*ratio);f.books['#300'].levels[1][0].sz='25';
  f.books['#301'].levels[0][0].sz='25';f.books['#301'].levels[1][0].sz=String(25*ratio);
  await start(f);assert.equal(buttons(f).some(b=>b.text==='Runner 30'),ratio===4);
 }finally{await f.close();}
});
function mixedGroups(f){
 f.meta.questions=[];f.meta.outcomes=[];
 const strong=[];
 for(let i=0;i<OUTCOMES_PAGE_SIZE+4;i++){
  const ids=[100+i*3,101+i*3,102+i*3];
  f.meta.questions.push({question:100+i,name:`Group ${i}`,namedOutcomes:ids.slice(0,2),fallbackOutcome:ids[2],settledNamedOutcomes:[]});
  for(const id of ids){f.meta.outcomes.push({outcome:id,name:`Member ${id}`,quoteToken:'USDC',expiry:Date.now()+86400000,szDecimals:0});for(const side of [0,1])f.books['#'+(id*10+side)]={time:Date.now(),levels:[[{px:'0.4',sz:'1000'}],[{px:'0.6',sz:'1000'}]]};}
  if(i===1||i===3)f.books['#'+(ids[2]*10+1)].levels[1][0].sz='1';else strong.push(`Group ${i}`);
 }
 return strong;
}
for(const language of ['en','ru'])test(`real routers paginate mixed strong/weak full groups AFTER filtering (${language})`,async()=>{
 const f=eventHarness({language,routed:true});try{
  const strong=mixedGroups(f),t=await getTranslator(language),reads=[];let pending=0,peak=0;
  const read=f.client.getOrderbook;f.client.getOrderbook=async coin=>{reads.push(coin);pending++;peak=Math.max(peak,pending);await new Promise(r=>setTimeout(r,2));try{return await read(coin);}finally{pending--;}};
  f.client.getUserFees=f.client.getUserBalances=f.client.getOpenOrders=async()=>assert.fail('Catalogue must not read private/account evidence');
  let metaReads=0;const meta=f.client.getOutcomeMeta;f.client.getOutcomeMeta=async()=>{metaReads++;return meta();};
  await start(f);
  const groupNames=()=>buttons(f).filter(b=>/^Group /.test(b.text)).map(b=>b.text);
  assert.deepEqual(groupNames(),strong.slice(0,OUTCOMES_PAGE_SIZE));assert(f.messages.at(-1).text.includes('1/2'));
  assert.equal(metaReads,1);assert.equal(reads.length,f.meta.outcomes.length*2);assert.equal(new Set(reads).size,reads.length);assert(peak<=6&&peak>1);
  const next=buttons(f).find(b=>b.text===t('liq_next')).callback_data;
  await route(f,next);assert.deepEqual(groupNames(),strong.slice(OUTCOMES_PAGE_SIZE));
  const pick=buttons(f).find(b=>/^Group /.test(b.text)).callback_data;
  const priorToken=runtime.userStates.get(f.owner).token,priorReads=reads.length;
  await route(f,next);assert.equal(runtime.userStates.get(f.owner).token,priorToken,'Stale page token must not replay');assert.equal(reads.length,priorReads);assert.equal(f.messages.at(-1).text,t('session_expired'));
  const before=reads.length;await route(f,pick);assert.equal(reads.length-before,6,'Pick checks only selected complete event');
  assert.equal(runtime.userStates.get(f.owner).state,'LIQUIDITY_INPUT');
  const back=buttons(f).find(b=>b.callback_data.startsWith('liq:back:')).callback_data;
  await route(f,back);assert.deepEqual(groupNames(),strong.slice(OUTCOMES_PAGE_SIZE));assert(f.messages.at(-1).text.includes('2/2'));
  assert.equal(f.actions.length,0);assert.equal((await f.c.list()).length,0);
 }finally{await f.close();}
});
for(const navigation of ['liq:cancel','back_menu','client','account','network','ttl'])test(`catalogue scan cancellation cannot revive ${navigation}`,async()=>{
 const f=eventHarness({routed:true});let release;const realNow=Date.now;try{
  let entered;const reached=new Promise(r=>entered=r),hold=new Promise(r=>release=r);let calls=0;
  mixedGroups(f);const read=f.client.getOrderbook;f.client.getOrderbook=async coin=>{calls++;entered();await hold;return read(coin);};
  const scan=start(f);await enteredScan(scan,reached);
  if(navigation==='client')runtime.setHLClient({...f.client});
  else if(navigation==='account')f.client.address='0x'+'b'.repeat(40);
  else if(navigation==='network')f.client.network='mainnet';
  else if(navigation==='ttl')runtime.userStates.get(f.owner).expiresAt=realNow()-1;
  else await route(f,navigation);
  const state=runtime.userStates.get(f.owner),count=f.messages.length;
  await scan;assert(calls<=6);assert.equal(f.messages.length,count);assert.equal(runtime.userStates.get(f.owner),state);
  release();await new Promise(r=>setTimeout(r,10));assert(calls<=6);assert.equal(f.actions.length,0);
 }finally{Date.now=realNow;release?.();runtime.setHLClient(f.client);f.client.network='testnet';await f.close();}
});
test('deadline cancels unfinished catalogue without authoritative partial strong results',async()=>{
 const f=eventHarness();let release;try{
  mixedGroups(f);const original=f.client.getOrderbook,hold=new Promise(r=>release=r);let calls=0;
  f.client.getOrderbook=async coin=>{calls++;if(Number(coin.slice(1))>=1030)await hold;return original(coin);};
  const start=performance.now();await assert.rejects(liquidityCatalogue(f.client,{timeoutMs:60}),/deadline/);
  assert(performance.now()-start<500);const before=calls;release();await new Promise(r=>setTimeout(r,10));assert.equal(calls,before);
  assert.equal(f.actions.length,0);
 }finally{release?.();await f.close();}
});
test('API error after strong event never presents incomplete scan as complete catalogue',async()=>{
 const f=eventHarness({routed:true});try{
  mixedGroups(f);const read=f.client.getOrderbook;
  f.client.getOrderbook=async coin=>{if(coin==='#1030')throw Error('API down after strong event');return read(coin);};
  await start(f);assert(!buttons(f).some(b=>/^Group /.test(b.text)));assert(f.messages.at(-1).text.includes((await getTranslator('en'))('liq_unavailable')));
  assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
for(const stop of ['cancel','deadline','metadata'])test(`real HLClient aborts in-flight public transport on ${stop}`,async()=>{
 const f=eventHarness(),client=new HLClient(null,'testnet'),originalFetch=globalThis.fetch;let active=true,entered,aborted=0,calls=0;
 const reached=new Promise(r=>entered=r);
 try{
  globalThis.fetch=async(url,{body,signal})=>{
   assert(url.endsWith('/info'));const request=JSON.parse(body);
   assert(['outcomeMeta','l2Book'].includes(request.type),'No fee, account or exchange requests');
   if(request.type==='outcomeMeta'&&stop!=='metadata')return {ok:true,json:async()=>structuredClone(f.meta)};
   calls++;if(stop==='metadata'||calls===6)entered();
   return new Promise((_,reject)=>{const fail=()=>{aborted++;reject(Error('Controlled transport aborted'));};if(signal.aborted)fail();else signal.addEventListener('abort',fail,{once:true});});
  };
  const pending=liquidityCatalogue(client,{selected:{type:'question',id:3},isCurrent:()=>active,timeoutMs:stop==='deadline'?80:1000});
  await enteredScan(pending,reached);if(stop!=='deadline')active=false;
  await assert.rejects(pending,/deadline|superseded/);await new Promise(r=>setTimeout(r,5));
  assert.equal(aborted,calls);assert.equal(calls,stop==='metadata'?1:6);assert.equal(client.wallet,null);
 }finally{globalThis.fetch=originalFetch;await f.close();}
});