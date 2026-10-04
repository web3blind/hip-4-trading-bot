import {Api} from 'grammy';
import test from 'node:test';
import assert from 'node:assert/strict';
import {eventHarness} from './liquidity-event-harness.js';
import * as runtime from '../../src/modules/bot/runtime.js';
const realNow=Date.now;let controlledAt;Date.now=()=>controlledAt??realNow();
const {initBot,stopBot}=await import('../../src/modules/bot/bot.js');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<3500;i++){if(fn())return;await sleep(10);}assert.fail('Native fixture rendezvous timed out');}
async function native(f,transport){
 runtime.rateLimits.clear();
 const bot=await initBot('123456:synthetic-test-token',f.owner);
 bot.botInfo={id:999,is_bot:true,first_name:'Fixture',username:'fixture_bot'};
 // Execute the canonical Grammy client, including AbortSignal propagation;
 // only its fetch boundary is synthetic. No real Telegram/network requests.
 const api=new Api('123456:synthetic-test-token',{fetch:async(url,options)=>{
  const method=String(url).split('/').at(-1),payload=JSON.parse(options.body);
  await transport?.(method,payload,options.signal);
  if(method==='editMessageText'||method==='sendMessage')f.messages.push({text:payload.text,extra:{reply_markup:payload.reply_markup}});
  if(method==='editMessageReplyMarkup')f.messages.at(-1).extra.reply_markup=payload.reply_markup;
  return {json:async()=>({ok:true,result:method==='answerCallbackQuery'?true:{message_id:1,date:0,chat:f.ctx.chat,text:payload.text}})};
 }});
 bot.api.config.use(async(prev,method,payload,signal)=>({ok:true,result:await api.raw[method](payload,signal)}));
 let id=0;
 return data=>bot.handleUpdates([{update_id:++id,callback_query:{id:String(id),from:f.ctx.from,chat_instance:'fixture',data,message:{message_id:1,date:0,chat:f.ctx.chat}}}]);
}
function many(f,n){const base=f.meta.outcomes[0];f.meta.questions=[];f.meta.outcomes=Array.from({length:n},(_,i)=>({...base,outcome:100+i,name:`Candidate ${i}`}));}
const healthy=()=>({time:Date.now(),levels:[[{px:'0.4',sz:'1000'}],[{px:'0.6',sz:'1000'}]]});
async function selectHeld(f,transport,branch) {
 const route=await native(f,transport);
 await route('liq:new:live');const state=runtime.userStates.get(f.owner);
 await until(()=>!state.catalogueTask);
 const pick=f.messages.at(-1).extra.reply_markup.inline_keyboard.flat().find(b=>b.text.includes('Runner'));
 assert(pick);
 let books=0;f.client.getOrderbook=async()=>{books++;if(branch==='unavailable')throw Error('Controlled unavailable book');return branch==='weak'?{time:Date.now(),levels:[[],[]]}:healthy();};
 runtime.rateLimits.clear();await route(pick.callback_data);
 return {route,state,books:()=>books};
}
for(const branch of ['weak','unavailable','prompt'])for(const exit of ['cancel','shutdown','invalidate','activation'])for(const failure of [false,true])test(`native selected ${branch} publication drains before ${exit}; late ${failure?'failure':'success'}`,async()=>{
 const f=eventHarness({routed:true,standalone:true});let release,pending;
 try{
  let entered=false,signalSeen;const hold=new Promise(r=>release=r);
  const selected=await selectHeld(f,async(method,payload,signal)=>{
   if(method==='editMessageText'&&/^(No events|Search finished|Step)/.test(payload.text||'')){
    entered=true;signalSeen=signal;await hold;if(failure)throw Error('Controlled late publication failure');
   }
  },branch);
  await until(()=>entered);const {route,state}=selected,task=state.catalogueTask;
  assert(task,'Selected publication must retain original owned task');assert(signalSeen,'Selected publication must have bounded native signal');
  let done=false;pending=(exit==='cancel'?route('liq:cancel'):exit==='shutdown'?stopBot():exit==='activation'?runtime.activateHLClient(f.client,{startWorkers:false}):runtime.invalidateUserState(f.owner)).then(()=>done=true);
  await sleep(80);assert.equal(done,false,'Replacement must drain actual publication');
  release();await pending;await task;await sleep(20);
  assert(!runtime.userStates.has(f.owner));assert(!state.catalogueTask);
  if(exit==='cancel')assert.match(f.messages.at(-1).text,/Cancelled/i);
  assert.equal(f.actions.length,0);assert.equal(selected.books(),branch==='unavailable'?4:2);
 }finally{release?.();await pending;await stopBot();runtime.rateLimits.clear();await f.close();}
});
for(const branch of ['weak','unavailable','prompt'])test(`canonical selected ${branch} publication aborts transport within 10s on Cancel`,{timeout:15000},async()=>{
 const f=eventHarness({routed:true,standalone:true});let release;
 try{
  let entered=false,active=0,aborted=0,signalSeen;
  const selected=await selectHeld(f,async(method,payload,signal)=>{
   if(method==='editMessageText'&&/^(No events|Search finished|Step)/.test(payload.text||'')){
    entered=true;signalSeen=signal;active++;
    await new Promise((resolve,reject)=>{release=()=>{active--;resolve();};signal?.addEventListener('abort',()=>{active--;aborted++;release=undefined;reject(Error('Controlled native abort'));},{once:true});});
   }
  },branch);
  await until(()=>entered);assert(signalSeen,'Selected publication must use AbortSignal');
  const task=selected.state.catalogueTask;assert(task);const started=performance.now();await selected.route('liq:cancel');await task;
  const elapsed=performance.now()-started;assert(elapsed>=9000&&elapsed<12000);assert.equal(active,0);assert.equal(aborted,1);
  assert.match(f.messages.at(-1).text,/Cancelled/i);assert(!runtime.userStates.has(f.owner));assert(!selected.state.catalogueTask);assert.equal(f.actions.length,0);
  console.log(JSON.stringify({fixture:`canonical selected ${branch}`,elapsedMs:Math.round(elapsed),active,aborted,selectionBooks:selected.books(),actions:f.actions.length}));
 }finally{release?.();await stopBot();runtime.rateLimits.clear();await f.close();}
});
test('native detached terminal render failure is contained and task cleaned',async()=>{const f=eventHarness({routed:true,standalone:true});try{let renders=0;const route=await native(f,async method=>{if(['editMessageText','sendMessage'].includes(method)&&++renders>1)throw Error('Telegram transport unavailable');});f.client.getOutcomeMeta=async()=>{throw Error('Metadata unavailable');};await route('liq:new:live');const state=runtime.userStates.get(f.owner);await until(()=>!state.catalogueTask);await sleep(80);assert.equal(f.actions.length,0);}finally{await stopBot();runtime.rateLimits.clear();await f.close();}});
for(const exit of ['cancel','shutdown','invalidate','activation'])for(const failure of [false,true])test(`native held qualified publication drained before ${exit}; late ${failure?'failure':'success'}`,async()=>{const f=eventHarness({routed:true,standalone:true});let release;try{many(f,20);f.client.getOrderbook=async()=>healthy();let entered=false;const hold=new Promise(r=>release=r);const route=await native(f,async(method,payload)=>{if(method==='editMessageText'&&payload.text?.includes('Choose an event')){entered=true;await hold;if(failure)throw Error('Late Telegram failure');}});await route('liq:new:live');await until(()=>entered);const state=runtime.userStates.get(f.owner),task=state.catalogueTask;let done=false;const pending=(exit==='cancel'?route('liq:cancel'):exit==='shutdown'?stopBot():exit==='activation'?runtime.activateHLClient(f.client,{startWorkers:false}):runtime.invalidateUserState(f.owner)).then(()=>done=true);await sleep(100);const drainedEarly=done;release();await pending;await task;await sleep(80);assert.equal(drainedEarly,false,'Replacement/shutdown must await actual publication, not only Promise.race');assert(!runtime.userStates.has(f.owner));if(exit==='cancel')assert.match(f.messages.at(-1).text,/Cancelled/i);assert(!state.catalogueTask);assert.equal(f.actions.length,0);}finally{release?.();await stopBot();runtime.rateLimits.clear();await f.close();}});
test('canonical Telegram transport bounds held publication cancellation to 10s and aborts fetch',{timeout:15000},async()=>{
 const f=eventHarness({routed:true,standalone:true});try{
  many(f,20);f.client.getOrderbook=async()=>healthy();let entered=false,active=0,aborted=0;
  const route=await native(f,async(method,payload,signal)=>{
   if(method==='editMessageText'&&payload.text?.includes('Choose an event')){
    entered=true;active++;
    await new Promise((_,reject)=>signal.addEventListener('abort',()=>{active--;aborted++;reject(Error('Aborted fixture transport'));},{once:true}));
   }
  });
  await route('liq:new:live');await until(()=>entered);const start=performance.now();
  await route('liq:cancel');const elapsed=performance.now()-start;
  assert(elapsed>=9000&&elapsed<12000);assert.equal(active,0);assert.equal(aborted,1);
  assert.match(f.messages.at(-1).text,/Cancelled/i);assert(!runtime.userStates.has(f.owner));assert.equal(f.actions.length,0);
  console.log(JSON.stringify({fixture:'canonical Telegram fetch timeout drain',elapsedMs:Math.round(elapsed),active,aborted}));
 }finally{await stopBot();runtime.rateLimits.clear();await f.close();}
});
test('native saturation retains qualified navigation; Next freshly reads every displayed book', {timeout:40000},async()=>{const f=eventHarness({routed:true,standalone:true});try{many(f,600);controlledAt=realNow();let reads=0;f.client.getOrderbook=async()=>{if(++reads===11)controlledAt+=6000;return healthy();};const route=await native(f);await route('liq:new:live');const state=runtime.userStates.get(f.owner);await until(()=>!state.catalogueTask);assert.equal(reads,1200);assert.equal(state.catalogIndex.length,600);const buttons=f.messages.at(-1).extra.reply_markup.inline_keyboard.flat();const next=buttons.find(b=>/Next/i.test(b.text));assert(next,'Actual native keyboard must retain qualified-result Next at saturation');assert(!buttons.some(b=>/Continue|Retry|Verify/i.test(b.text)));runtime.rateLimits.clear();await route(next.callback_data);await until(()=>!state.catalogueTask);assert.equal(reads,1210);assert.equal(state.choices.filter(a=>a.kind==='event').length,5);assert.equal(f.actions.length,0);console.log(JSON.stringify({fixture:'native 600 healthy saturation',qualifiedIndex:state.catalogIndex.length,discoveryBooks:1200,pageFreshBooks:10}));}finally{await stopBot();runtime.rateLimits.clear();await f.close();}});
