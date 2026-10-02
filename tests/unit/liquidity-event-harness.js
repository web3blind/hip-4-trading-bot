import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {HLClient} from '../../src/modules/hyperliquid.js';
import {createLiquidityCoordinator} from '../../src/modules/liquidity/coordinator.js';
import * as routedCoordinator from '../../src/modules/liquidity/coordinator.js';
import {createLiquidityFeature} from '../../src/modules/bot/features/liquidity.js';
import {createLiquidityMcp} from '../../src/modules/liquidity/mcp.js';
import * as runtime from '../../src/modules/bot/runtime.js';
import {setSessionConfig} from '../../src/modules/config.js';
import {initDatabase} from '../../src/modules/database.js';
export function eventHarness({language='en',standalone=false,routed=false}={}) {
 const dir=mkdtempSync(join(tmpdir(),'liq-event-connected-')),owner=77;
 const client=new HLClient('0x'+'1'.repeat(64),'testnet'),actions=[],orders=new Map(),fills=[],balances=new Map(),books={};
 let time=Date.now(),valid=true,spot=100,exchangeMode='normal';
 const fees={userSpotCrossRate:'0.001',userSpotAddRate:'-0.0001',feeSchedule:{spotCross:'0.001',spotAdd:'-0.0001'}};
 const meta={outcomes:(standalone?[30]:[30,31,32]).map(outcome=>({outcome,quoteToken:'USDC',name:outcome===32?'Fallback':`Runner ${outcome}`,expiry:time+86400000,szDecimals:0,deployerFeeScale:1})),questions:standalone?[]:[{question:3,name:'Championship',namedOutcomes:[30,31],fallbackOutcome:32,settledNamedOutcomes:[]}]};
 const policy={event:{type:standalone?'standalone':'question',id:standalone?30:3},mode:'live',account:client.address.toLowerCase(),network:'testnet',durationMinutes:30,budgetUsdc:100,maxInventoryShares:200,orderSizeShares:30,minPrice:.2,maxPrice:.8,minSpread:.1,maxLossUsdc:30,maxActions:12};
 for(const o of meta.outcomes)for(const side of [0,1])books['#'+(o.outcome*10+side)]={time,levels:[[{px:'0.4',sz:'1000'}],[{px:'0.6',sz:'1000'}]]};
 client.getOutcomeMeta=async()=>structuredClone(meta);client.getAllMids=async()=>({});
 client.getUserFees=async()=>fees;client._infoRequest=async r=>{assert.equal(r.type,'userFees');return fees;};
 client.getAvailableUsdc=async()=>{assert.fail('Do not use combined perp/spot balance');};
 client.getUserBalances=async()=>({balances:[{coin:'USDC',total:String(spot),hold:String([...orders.values()].filter(o=>o.status==='open' && o.order.side==='B').reduce((n,o)=>n+o.remaining*o.px,0))},...[...balances].map(([coin,total])=>({coin,total:String(total)}))]});
 client.getUserFillsByTime=async()=>structuredClone(fills);
 client.getOrderbook=async coin=>structuredClone(books[coin]||{time,levels:[[{px:'0.4',sz:'1000'}],[{px:'0.6',sz:'1000'}]]});
 client.getOpenOrders=async()=>[...orders.values()].filter(o=>o.status==='open').map(o=>({...o.order}));
 client.getOrderStatus=async id=>({order:structuredClone([...orders.values()].find(o=>o.order.oid===id||o.order.cloid===id))});
 client._exchangeRequest=async payload=>{
  assert(payload.signature);const a=payload.action;actions.push(a);
  if(a.type==='order') {
   if(exchangeMode==='unknown')throw Error('Controlled unknown exchange response');
   if(exchangeMode==='rejected')return {status:'ok',response:{type:'order',data:{statuses:a.orders.map(()=>({error:'Controlled rejection'}))}}};
   const statuses=a.orders.map(w=>{assert.equal(w.t.limit.tif,'Alo');const oid=100+orders.size,coin='#'+String(w.a-100000000);orders.set(oid,{status:'open',order:{oid,coin,cloid:w.c,side:w.b?'B':'A',size:Number(w.s)},px:Number(w.p),remaining:Number(w.s)});return {resting:{oid}};});
   return {status:'ok',response:{type:'order',data:{statuses}}};
  }
  assert.equal(a.type,'cancel');for(const w of a.cancels){assert(orders.has(w.o));orders.get(w.o).status='canceled';}
  return {status:'ok',response:{type:'cancel',data:{statuses:a.cancels.map(()=>'success')}}};
 };
 if(routed)initDatabase({network:client.network,accountAddress:client.address});
 const credential={id:'1234567890abcdef',generation:'1234567890abcdef12345678',scope:'trade'};
 const c=routed?{
  list:routedCoordinator.listLiquiditySessions,get:routedCoordinator.getLiquiditySession,
  assess:routedCoordinator.assessLiquiditySession,propose:routedCoordinator.proposeLiquiditySession,
  approve:routedCoordinator.approveLiquiditySession,stop:routedCoordinator.stopLiquiditySession,
  tick:routedCoordinator.tickLiquidity,shutdown:routedCoordinator.shutdownLiquidity,
 }:createLiquidityCoordinator({getClient:()=>client,getOwner:()=>owner,dataDir:dir,now:()=>time,locks:new Map(),conflicts:()=>false,credentialCurrent:async()=>valid});
 const api={listLiquiditySessions:()=>c.list(),getLiquiditySession:id=>c.get(id),assessLiquiditySession:id=>c.assess(id),proposeLiquiditySession:(p,o)=>c.propose(p,o),approveLiquiditySession:(id,o)=>c.approve(id,o),stopLiquiditySession:(id,o)=>c.stop(id,o)};
 const ui=createLiquidityFeature({service:async()=>api}),messages=[];
 const ctx={chat:{id:owner,type:'private'},from:{id:owner},messages,editMessageText:async(text,extra)=>messages.push({text,extra}),reply:async(text,extra)=>messages.push({text,extra}),answerCallbackQuery:async()=>{}};
 runtime.setAllowedUserId(owner);runtime.setHLClient(client);setSessionConfig({language,hlNetwork:'testnet'});
 const mcp=createLiquidityMcp({api,getClient:()=>client,getOwner:()=>owner,currentCredential:async()=>valid,deliver:(id,expectedState)=>ui.showReview(ctx,id,expectedState)});
 return {dir,owner,client,meta,policy,api,c,ui,ctx,messages,actions,orders,fills,balances,holdings:balances,books,credential,fees,mcp,
  get exchangeMode(){return exchangeMode},set exchangeMode(v){exchangeMode=v},get valid(){return valid},set valid(v){valid=v},
  args(){const a={...policy,request_id:"event_request_123"};delete a.account;delete a.network;return a;},
  approve:id=>c.approve(id,{ownerId:owner}),
  setSpot:v=>spot=v,setTime:v=>{time=v},get time(){return time},set time(v){time=v},revoke:()=>valid=false,
  async propose(overrides={}) {const args={...policy,...overrides,request_id:'event_request_'+String((await c.list()).length)};delete args.account;delete args.network;return (await mcp('liquidity_request_session',args,credential)).session;},
  async confirm(){const b=messages.at(-1).extra.reply_markup.inline_keyboard.flat().find(b=>b.callback_data.startsWith('confirm_liquidity_session:'));assert(b,'A suitable owner review is required');assert.equal(runtime.consumeConfirmation(owner,b.callback_data),'confirm_liquidity_session');await ui.confirm(ctx);},
  fill(oid,amount){const o=orders.get(oid),sz=amount??o.remaining;assert(sz>0&&sz<=o.remaining);const isBuy=o.order.side==='B',start=balances.get(o.order.coin)||0;const fee=.001;fills.push({oid,tid:fills.length+1,coin:o.order.coin,side:o.order.side,sz:String(sz),px:String(o.px),fee:String(fee),feeToken:'USDC',time,startPosition:String(start)});balances.set(o.order.coin,start+(isBuy?sz:-sz));spot+=(isBuy?-1:1)*sz*o.px-fee;o.remaining-=sz;if(o.remaining===0)o.status='filled';},
  async close(){try{await c.shutdown();}catch{/* An explicitly asserted unresolved session is retained, never submitted live. */}finally{await runtime.invalidateUserState(owner);runtime.setHLClient(null);rmSync(dir,{recursive:true,force:true});}},
 };
}
