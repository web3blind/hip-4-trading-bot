import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HLClient } from '../../src/modules/hyperliquid.js';
import { setSessionConfig } from '../../src/modules/config.js';
import { createCompleteSetFeature } from '../../src/modules/bot/features/complete-set.js';
import * as runtime from '../../src/modules/bot/runtime.js';
import {meta,templates,fees,account,fixedNow} from '../fixtures/complete-set.js';

function setup(result){
 let writes=0, metadata=meta;let scale=1, balance=500, bookError=false;const saved=[];
 const px=[.283,.263,.444];
 const client={network:'mainnet',address:account,getOutcomeMeta:async()=>metadata,getOutcomeTemplates:async()=>templates,getUserFees:async()=>fees,
  getOrderbook:async coin=>{if(bookError) throw Error('offline');const i=[44830,44840,44850].indexOf(Number(coin.slice(1)));return{levels:[[],[{px:String(px[i]*scale),sz:'200'}]]};},
  prepareOrder:async r=>({...r,maxSpend:r.price*r.size*1.01}),getAvailableUsdc:async()=>balance,
  placeOrders:async (orders,options)=>{writes++;assert.equal(orders.length,3);assert(orders.every(o=>o.orderType==='Market'));assert.equal(options.throwOnError,false);return result||{status:'ok',response:{type:'order',data:{statuses:orders.map((o,i)=>({filled:{oid:100+i,totalSz:o.size,avgPx:o.price}}))}}};}
 };
 runtime.setHLClient(client);setSessionConfig({language:'ru',hlNetwork:'mainnet',notifications:{}});
 const attempts=[];
 const feature=createCompleteSetFeature({client,persistOrder:x=>saved.push(x),attempts:{create:x=>attempts.push({state:'prepared',...x}),update:(id,state,legs)=>Object.assign(attempts.find(a=>a.id===id),{state,legs})},now:()=>fixedNow});
 const messages=[];const ctx={chat:{id:77},editMessageText:async(t,opts)=>messages.push({t,opts}),reply:async(t,opts)=>messages.push({t,opts})};
 return{feature,ctx,messages,saved,attempts,client,get writes(){return writes},set scale(v){scale=v},set balance(v){balance=v},set bookError(v){bookError=v},setPrice:(i,p)=>{px[i]=p},set metadata(v){metadata=v},set feesInvalid(v){client.getUserFees=async()=>v?{}:fees}};
}
async function review(h,budget='100'){
 await h.feature.open(h.ctx,'325');
 const state=runtime.userStates.get(77);assert.equal(state.state,'AWAITING_SET_AMOUNT');
 await h.feature.inputAmount(h.ctx,state,budget);
 return h.messages.at(-1);
}
function consume(h){const markup=h.messages.at(-1).opts.reply_markup;const callback=markup.inline_keyboard?.[0]?.[0]?.callback_data||markup.keyboard?.[0]?.[0]?.callback_data;
 // grammy InlineKeyboard exposes inline_keyboard.
 assert(callback?.startsWith('confirm_set_buy:'));
 assert.equal(runtime.consumeConfirmation(77,callback),'confirm_set_buy');return callback;
}
test('reject $20 total with actual minimum; no trade or review confirmation',async()=>{const h=setup();try{await review(h,'20');assert.equal(h.writes,0);assert.equal(runtime.userStates.get(77).state,'AWAITING_SET_AMOUNT');assert(h.messages.at(-1).t.includes('Минимальная сумма: $'));}finally{runtime.userStates.delete(77);setSessionConfig(null);runtime.setHLClient(null);}});
test('fresh re-quote rejects worse prices without any exchange write',async()=>{const h=setup();try{await review(h);consume(h);h.scale=1.01;await h.feature.confirm(h.ctx);assert.equal(h.writes,0);assert(h.messages.at(-1).t.includes('изменились'));}finally{runtime.userStates.delete(77);setSessionConfig(null);runtime.setHLClient(null);}});
test('unchanged total cost but one leg ask worsens: abort rather than partially fill IOC bundle',async()=>{
 const h=setup();try {await review(h);consume(h);h.setPrice(0,.293);h.setPrice(1,.253);await h.feature.confirm(h.ctx);assert.equal(h.writes,0);assert(h.messages.at(-1).t.includes('изменились'));}
 finally {runtime.userStates.delete(77);setSessionConfig(null);runtime.setHLClient(null);}
});
test('equal IOC batch only after one-time confirmation; all three OIDs persisted',async()=>{const h=setup();try{await review(h);const token=consume(h);await h.feature.confirm(h.ctx);assert.equal(h.writes,1);assert.equal(h.saved.length,3);assert(h.saved.every(o=>o.status==='filled'));assert.equal(runtime.consumeConfirmation(77,token),null);}finally{runtime.userStates.delete(77);setSessionConfig(null);runtime.setHLClient(null);}});
test('all IOC rejects produce rejected state without a false partial-exposure warning',async()=>{
 const statuses=Array.from({length:3},()=>({error:'IOC rejected'}));
 const h=setup({status:'ok',response:{type:'order',data:{statuses}}});
 try {await review(h);consume(h);await h.feature.confirm(h.ctx);assert.equal(h.writes,1);assert.equal(h.attempts[0].state,'rejected');
  assert.equal(h.saved.length,0);assert(h.messages.at(-1).t.includes('Все заявки отклонены'));
 } finally {runtime.userStates.delete(77);setSessionConfig(null);runtime.setHLClient(null);}
});
test('one rejected leg produces partial warning, no automatic retry',async()=>{const h=setup({status:'ok',response:{type:'order',data:{statuses:[{filled:{oid:100,totalSz:60,avgPx:.283}},{error:'IOC rejected'},{filled:{oid:102,totalSz:60,avgPx:.444}}]}}});try{await review(h);consume(h);await h.feature.confirm(h.ctx);assert.equal(h.writes,1);assert.equal(h.saved.length,2);assert(h.messages.at(-1).t.includes('НЕ полностью'));}finally{runtime.userStates.delete(77);setSessionConfig(null);runtime.setHLClient(null);}});
test('open preflights minimum and balance; percentages are floored and infeasible options hidden',async()=>{
 const h=setup();try {
  h.balance=207.69;await h.feature.open(h.ctx,'325');
  const buttons=h.messages.at(-1).opts.reply_markup.inline_keyboard.flat();
  assert.match(h.messages.at(-1).t,/Доступный баланс USDC: \$207\.69/);
  assert.match(buttons[0].text,/^Минимум \(\d+\.\d\d \$\)$/);
  assert(!buttons.some(b=>b.text.startsWith('10%')));
  assert(buttons.some(b=>b.text==='30% (62.30 $)'));
  assert(buttons.some(b=>b.text==='100% (макс., 207.69 $)'));
  const min=buttons[0].callback_data;await h.feature.chooseAmount(h.ctx,'325',min.split(':')[2],'min');
  assert.equal(runtime.userStates.get(77).state,'CONFIRMING_SET_BUY');assert.equal(h.writes,0);
 }finally{runtime.userStates.delete(77);setSessionConfig(null);runtime.setHLClient(null);}
});
test('recorded shallow cheap leg: actual wire rounding produces feasible minimum, not $40',async()=>{
 const h=setup();try {
  // Public ask levels observed 2026-09-27; IDs/rules use the isolated fixture.
  const asks=[[[.2493,54],[.24931,66]],[[.2499,19],[.25098,68],[.2514,20]],[[.4844,264]]];
  h.client.getOrderbook=async coin=>({levels:[[],asks[[44830,44840,44850].indexOf(Number(coin.slice(1)))].map(([px,sz])=>({px:String(px),sz:String(sz)}))]});
  Object.setPrototypeOf(h.client,HLClient.prototype);
  h.client.prepareOrder=HLClient.prototype.prepareOrder;
  h.client._getSzDecimals=async()=>0;
  h.client._resolveSpotAssetIndex=async coin=>100_000_000+Number(coin.slice(1));
  await h.feature.open(h.ctx,'325');
  const buttons=h.messages.at(-1).opts.reply_markup.inline_keyboard.flat();
  assert.equal(buttons[0].text,'Минимум (40.78 $)');
  assert.deepEqual(buttons.filter(b=>/^\d+%/.test(b.text)).map(b=>b.text),[
   '10% (50.00 $)','30% (150.00 $)','50% (250.00 $)','70% (350.00 $)',
   '80% (400.00 $)','90% (450.00 $)','100% (макс., 500.00 $)']);
  const state=runtime.userStates.get(77);
  await h.feature.inputAmount(h.ctx,state,'40');
  assert.match(h.messages.at(-1).t,/Минимальная сумма: \$40\.78/);
  await h.feature.chooseAmount(h.ctx,'325',state.token,'min');
  const confirmed=runtime.userStates.get(77);
  assert.equal(confirmed.state,'CONFIRMING_SET_BUY');
  assert.equal(confirmed.budget,40.78);
  assert(confirmed.quote.orders.every(o=>o.size===41 && o.price*o.size>=10));
  assert(confirmed.quote.maxSpend<=40.78);
  assert.equal(h.writes,0);
 }finally{runtime.userStates.delete(77);setSessionConfig(null);runtime.setHLClient(null);}
});
test('insufficient balance displays minimum but offers no infeasible amount button',async()=>{
 const h=setup();try {h.balance=20.76;await h.feature.open(h.ctx,'325');
  assert.match(h.messages.at(-1).t,/Доступного баланса меньше минимума/);
  assert.deepEqual(h.messages.at(-1).opts.reply_markup.inline_keyboard.flat().map(b=>b.callback_data),['back_menu']);
  await h.feature.inputAmount(h.ctx,runtime.userStates.get(77),'20');assert.match(h.messages.at(-1).t,/Бюджет мал/);
  assert.equal(h.writes,0);
 }finally{runtime.userStates.delete(77);setSessionConfig(null);runtime.setHLClient(null);}
});
test('missing fee, broken book and no net opportunity have distinct copy without orders',async()=>{
 const h=setup();try {
  h.feesInvalid=true;await h.feature.open(h.ctx,'325');assert.match(h.messages.at(-1).t,/Не удалось проверить/);
  h.feesInvalid=false;h.bookError=true;await h.feature.open(h.ctx,'325');assert.match(h.messages.at(-1).t,/Не удалось проверить/);
  h.bookError=false;h.scale=1.1;await h.feature.open(h.ctx,'325');assert.match(h.messages.at(-1).t,/подходящего набора нет/);
  h.scale=1;h.metadata={};await h.feature.open(h.ctx,'325');assert.match(h.messages.at(-1).t,/Не удалось проверить/);
  assert.equal(h.writes,0);
 }finally{runtime.userStates.delete(77);setSessionConfig(null);runtime.setHLClient(null);}
});
test('new menu invalidates older amount callback even for same question',async()=>{
 const h=setup();try {
  await h.feature.open(h.ctx,'325');const old=runtime.userStates.get(77);
  await h.feature.open(h.ctx,'325');const next=runtime.userStates.get(77);
  assert.notEqual(old.token,next.token);
  await h.feature.chooseAmount(h.ctx,'325',old.token,'100');assert.equal(runtime.userStates.get(77),next);
  assert.equal(h.writes,0);
 }finally{runtime.userStates.delete(77);setSessionConfig(null);runtime.setHLClient(null);}
});
test('changed books or API error on confirmation never masquerades as submitted or sends orders',async()=>{
 const h=setup();try {await review(h);consume(h);h.bookError=true;await h.feature.confirm(h.ctx);
  assert.match(h.messages.at(-1).t,/Не удалось проверить/);assert.equal(h.writes,0);
 }finally{runtime.userStates.delete(77);setSessionConfig(null);runtime.setHLClient(null);}
});
test('slow old open cannot replace newer keyboard or state',async()=>{
 const h=setup();try {
  const read=h.client.getOutcomeMeta;let release;
  h.client.getOutcomeMeta=()=>new Promise(resolve=>{release=()=>resolve(meta)});
  const stale=h.feature.open(h.ctx,'325');
  await new Promise(resolve=>setImmediate(resolve));
  h.client.getOutcomeMeta=read;
  await h.feature.open(h.ctx,'325');const active=runtime.userStates.get(77),messageCount=h.messages.length;
  release();await stale;
  assert.equal(runtime.userStates.get(77),active);assert.equal(h.messages.length,messageCount);
 }finally{runtime.userStates.delete(77);setSessionConfig(null);runtime.setHLClient(null);}
});
test('slow old review cannot install confirmation after a newer menu opens',async()=>{
 const h=setup();try {
  await h.feature.open(h.ctx,'325');const old=runtime.userStates.get(77);
  let release;const read=h.client.getOutcomeMeta;
  h.client.getOutcomeMeta=()=>new Promise(resolve=>{release=()=>resolve(meta)});
  const stale=h.feature.inputAmount(h.ctx,old,'100');
  await new Promise(resolve=>setImmediate(resolve));
  h.client.getOutcomeMeta=read;await h.feature.open(h.ctx,'325');const active=runtime.userStates.get(77),messageCount=h.messages.length;
  release();await stale;
  assert.equal(runtime.userStates.get(77),active);assert.equal(h.messages.length,messageCount);assert.equal(h.writes,0);
 }finally{runtime.userStates.delete(77);setSessionConfig(null);runtime.setHLClient(null);}
});
