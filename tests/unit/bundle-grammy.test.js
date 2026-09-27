import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {initDatabase,closeDatabase,createCompleteSetAttempt,updateCompleteSetAttempt,getBundleCloseRequest} from '../../src/modules/database.js';
import {handleCallbackQuery} from '../../src/modules/bot/routing/callback-router.js';
import {setAllowedUserId,setHLClient,userStates,invalidateUserState} from '../../src/modules/bot/runtime.js';
import {setSessionConfig} from '../../src/modules/config.js';
import {createBundlesFeature} from '../../src/modules/bot/features/bundles.js';
const account='0x'+'b'.repeat(40),coins=['#610','#620'];

test('Grammy route reads scoped bundle, confirms once, persists before IOC and blocks stale replay',async()=>{
 initDatabase({accountAddress:account,network:'testnet'});
 setAllowedUserId(123);setSessionConfig({language:'en',hlNetwork:'testnet'});
 await invalidateUserState(123);
 const id=randomUUID(),created=Date.now();
 const legs=coins.map((coin,i)=>({coin,size:30,filledSize:30,oid:String(i+100),price:.3,cloid:'0x'+String(i+1).repeat(32)}));
 createCompleteSetAttempt({id,questionId:61,budget:30,shares:30,coins,account,network:'testnet',ruleDigest:'a'.repeat(64),feeDigest:'b'.repeat(64),legs});
 updateCompleteSetAttempt(id,'filled',legs);
 const fillTime=Date.now();
 const fills=coins.map((coin,i)=>({coin,oid:String(i+100),side:'B',tid:i+1,time:fillTime,sz:'30',px:'.3',fee:'0',feeToken:'USDC',startPosition:'0'}));
 let writes=0,persistedBeforeWrite=false;
 const client={address:account,network:'testnet',getUserFillsByTime:async(start,end)=>fills.filter(f=>f.time>=start&&f.time<=end),
  getUserBalances:async()=>({balances:coins.map(coin=>({coin,total:'30',hold:'0'}))}),getAllMids:async()=>({'#610':'.4','#620':'.4'}),
  getUserFees:async()=>({userSpotCrossRate:'.001',feeSchedule:{spotCross:'.001'}}),getOutcomeMeta:async()=>({outcomes:coins.map(c=>({outcome:Number(c.slice(1))/10,deployerFeeScale:1}))}),getOrderbook:async()=>({levels:[[{px:'.4',sz:'30'}],[]]}),
  prepareOrder:async o=>o,placeOrders:async orders=>{writes++;persistedBeforeWrite=!!getBundleCloseRequest(id);return {status:'ok',response:{type:'order',data:{statuses:orders.map((_,i)=>({filled:{oid:i+200,totalSz:'30',avgPx:'.4'}}))}}};}};
 setHLClient(client);
 const messages=[],ctx={chat:{id:123,type:'private'},from:{id:123},callbackQuery:{},answerCallbackQuery:async()=>{},
  editMessageText:async(text,extra)=>{messages.push({text,extra})},reply:async(text,extra)=>{messages.push({text,extra})}};
 const route=async data=>{ctx.callbackQuery.data=data;await handleCallbackQuery(ctx)};
 try {
  await route('bundles');assert.match(messages.at(-1).text,/Bundles/);
  await route(`bundle_detail:${id}`);assert(messages.at(-1).extra.reply_markup.inline_keyboard.flat().some(b=>b.callback_data===`bundle_review:${id}`));
  await route(`bundle_review:${id}`);
  const abandoned=messages.at(-1).extra.reply_markup.inline_keyboard.flat().find(b=>b.callback_data.startsWith('confirm_bundle_close:')).callback_data;
  await route('bundles');await route(abandoned);assert.equal(writes,0);
  await route(`bundle_review:${id}`);
  const confirm=messages.at(-1).extra.reply_markup.inline_keyboard.flat().find(b=>b.callback_data.startsWith('confirm_bundle_close:')).callback_data;
  assert.equal(writes,0);await route(confirm);assert.equal(writes,1);assert.equal(persistedBeforeWrite,true);
  await route(confirm);assert.equal(writes,1);
 } finally {await invalidateUserState(123);setHLClient(null);closeDatabase();}
});

test('expired during asynchronous fresh quote never persists or signs',async()=>{
 initDatabase({accountAddress:account,network:'testnet'});
 setSessionConfig({language:'en',hlNetwork:'testnet'});
 let clock=1000,writes=0;
 const client={address:account,network:'testnet',placeOrders:async()=>{writes++}};
 setHLClient(client);
 const id=randomUUID(),snapshot={id,status:'active',ownershipCertain:true,label:'Question',coins,remaining:[{coin:coins[0],size:30,live:30,available:30}],cost:9,proceeds:0};
 const order={coin:coins[0],size:30,price:.4,orderType:'Market',isBuy:false};
 const feature=createBundlesFeature({client:()=>client,now:()=>clock,load:async()=>[snapshot],quote:async()=>{clock+=120001;return {orders:[order],expected:12,net:3}}});
 userStates.set(123,{state:'CONFIRMING_BUNDLE_CLOSE',id,binding:'testnet:'+account,orders:[order],expected:12,expiresAt:121000});
 const messages=[],ctx={chat:{id:123,type:'private'},editMessageText:async text=>messages.push(text),reply:async text=>messages.push(text)};
 try {await feature.confirm(ctx);assert.equal(writes,0);assert.equal(getBundleCloseRequest(id),undefined);assert.match(messages.at(-1),/Cannot safely close/);}
 finally {await invalidateUserState(123);setHLClient(null);closeDatabase();}
});

test('Grammy bundle pagination reaches later rows',async()=>{
 setSessionConfig({language:'en',hlNetwork:'testnet'});
 const rows=Array.from({length:44},(_,i)=>({id:randomUUID(),label:`Question ${i}`,questionId:i,status:'closed',net:i,cost:10}));
 const feature=createBundlesFeature({client:()=>({address:account}),load:async()=>rows});
 const messages=[],ctx={editMessageText:async(text,extra)=>messages.push({text,extra}),reply:async(text,extra)=>messages.push({text,extra})};
 await feature.list(ctx);assert(messages.at(-1).extra.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='bundle_page:1'));
 await feature.list(ctx,2);assert(messages.at(-1).extra.reply_markup.inline_keyboard.flat().some(b=>b.callback_data===`bundle_detail:${rows[40].id}`));
});
