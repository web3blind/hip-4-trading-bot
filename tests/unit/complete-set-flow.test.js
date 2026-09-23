import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setSessionConfig } from '../../src/modules/config.js';
import { createCompleteSetFeature } from '../../src/modules/bot/features/complete-set.js';
import * as runtime from '../../src/modules/bot/runtime.js';
import {meta,templates,fees,account,fixedNow} from '../fixtures/complete-set.js';

function setup(result){
 let writes=0, metadata=meta;let scale=1;const saved=[];
 const px=[.283,.263,.444];
 const client={network:'mainnet',address:account,getOutcomeMeta:async()=>metadata,getOutcomeTemplates:async()=>templates,getUserFees:async()=>fees,
  getOrderbook:async coin=>{const i=[44830,44840,44850].indexOf(Number(coin.slice(1)));return{levels:[[],[{px:String(px[i]*scale),sz:'200'}]]};},
  prepareOrder:async r=>({...r,maxSpend:r.price*r.size*1.01}),getAvailableUsdc:async()=>500,
  placeOrders:async (orders,options)=>{writes++;assert.equal(orders.length,3);assert(orders.every(o=>o.orderType==='Market'));assert.equal(options.throwOnError,false);return result||{status:'ok',response:{type:'order',data:{statuses:orders.map((o,i)=>({filled:{oid:100+i,totalSz:o.size,avgPx:o.price}}))}}};}
 };
 runtime.setHLClient(client);setSessionConfig({language:'ru',hlNetwork:'mainnet',notifications:{}});
 const attempts=[];
 const feature=createCompleteSetFeature({client,persistOrder:x=>saved.push(x),attempts:{create:x=>attempts.push({state:'prepared',...x}),update:(id,state,legs)=>Object.assign(attempts.find(a=>a.id===id),{state,legs})},now:()=>fixedNow});
 const messages=[];const ctx={chat:{id:77},editMessageText:async(t,opts)=>messages.push({t,opts}),reply:async(t,opts)=>messages.push({t,opts})};
 return{feature,ctx,messages,saved,attempts,client,get writes(){return writes},set scale(v){scale=v},setPrice:(i,p)=>{px[i]=p},set metadata(v){metadata=v}};
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
test('reject $20 total; no trade or review confirmation',async()=>{const h=setup();try{await review(h,'20');assert.equal(h.writes,0);assert.equal(runtime.userStates.get(77).state,'AWAITING_SET_AMOUNT');assert(h.messages.at(-1).t.includes('$10'));}finally{runtime.userStates.delete(77);setSessionConfig(null);runtime.setHLClient(null);}});
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
