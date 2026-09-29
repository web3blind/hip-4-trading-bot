import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {HLClient} from '../../src/modules/hyperliquid.js';
import {createLiquidityCoordinator} from '../../src/modules/liquidity/coordinator.js';
import {createLiquidityMcp} from '../../src/modules/liquidity/mcp.js';
import {createLiquidityFeature} from '../../src/modules/bot/features/liquidity.js';
import {setSessionConfig} from '../../src/modules/config.js';
import * as runtime from '../../src/modules/bot/runtime.js';

for(const finish of ['owner_stop','credential_revoked']) test(`live owner grant to real ALO wire and ${finish}, without network writes`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'liq-live-')),owner=77,messages=[],actions=[],orders=new Map();
 const client=new HLClient('0x'+'1'.repeat(64),'testnet');
 const expiry=Date.now()+86400000;let valid=true;
 const fees={userSpotCrossRate:'0.001',feeSchedule:{spotCross:'0.001'}};
 client.getOutcomeMeta=async()=>({outcomes:[{outcome:30,quoteToken:'USDC',name:'Event',expiry,szDecimals:0,deployerFeeScale:1}],questions:[]});
 client._infoRequest=async request=>{assert.equal(request.type,'userFees');return fees;};
 client.getUserFees=async()=>fees;
 client.getAvailableUsdc=async()=>100;
 client.getUserBalances=async()=>({balances:[]});
 client.getUserFillsByTime=async()=>[];
 client.getOrderbook=async()=>({time:Date.now(),levels:[[{px:'0.4'}],[{px:'0.6'}]]});
 client.getOpenOrders=async()=>[...orders.values()].filter(o=>o.status==='open').map(o=>o.order);
 client.getOrderStatus=async id=>({order:[...orders.values()].find(o=>o.order.oid===id||o.order.cloid===id)});
 client._exchangeRequest=async payload=>{
  assert(payload.signature);const a=payload.action;actions.push(a);
  if(a.type==='order'){
   assert.equal(a.orders.length,1);const o=a.orders[0],oid=100+orders.size;
   assert.equal(o.t.limit.tif,'Alo');
   orders.set(oid,{status:'open',order:{oid,cloid:o.c,coin:'#300',side:o.b?'B':'A'}});
   return {status:'ok',response:{type:'order',data:{statuses:[{resting:{oid}}]}}};
  }
  assert.equal(a.type,'cancel');for(const o of a.cancels){assert(orders.has(o.o));orders.get(o.o).status='canceled';}
  return {status:'ok',response:{type:'cancel',data:{statuses:a.cancels.map(()=>'success')}}};
 };
 const key={id:'1234567890abcdef',generation:'1234567890abcdef12345678',scope:'trade'};
 const c=createLiquidityCoordinator({getClient:()=>client,getOwner:()=>owner,dataDir:dir,locks:new Map(),conflicts:()=>false,credentialCurrent:async()=>valid});
 const api={listLiquiditySessions:()=>c.list(),getLiquiditySession:id=>c.get(id),proposeLiquiditySession:(p,o)=>c.propose(p,o),approveLiquiditySession:(id,o)=>c.approve(id,o),stopLiquiditySession:(id,o)=>c.stop(id,o)};
 const ui=createLiquidityFeature({service:async()=>api});
 const ctx={chat:{id:owner,type:'private'},from:{id:owner},editMessageText:async(t,o)=>messages.push({t,o}),reply:async(t,o)=>messages.push({t,o})};
 runtime.setAllowedUserId(owner);runtime.setHLClient(client);setSessionConfig({language:'en',hlNetwork:'testnet'});
 const mcp=createLiquidityMcp({api,getClient:()=>client,getOwner:()=>owner,currentCredential:async()=>valid,deliver:id=>ui.showReview(ctx,id)});
 try {
  const {session}=await mcp('liquidity_request_session',{request_id:'live_request_123',mode:'live',coin:'#300',durationMinutes:30,budgetUsdc:100,maxInventoryShares:100,orderSizeShares:30,minPrice:.2,maxPrice:.8,minSpread:.1,maxLossUsdc:30,maxActions:2},key);
  assert.match(messages.at(-1).t,/Rewards are unverified/);
  await c.tick();assert.equal(actions.length,0);assert.equal((await c.get(session.id)).status,'draft');
  await assert.rejects(c.approve(session.id,{ownerId:88}),/Owner/);
  const callback=messages.at(-1).o.reply_markup.inline_keyboard.flat().find(b=>b.callback_data.startsWith('confirm_liquidity_session:')).callback_data;
  assert.equal(runtime.consumeConfirmation(owner,callback),'confirm_liquidity_session');await ui.confirm(ctx);
  assert.equal((await c.get(session.id)).status,'active');assert.equal(actions.length,0);
  await c.tick();assert.equal(actions.length,1);assert.equal(actions[0].type,'order');
  assert.equal(actions[0].orders[0].s,'30');assert.equal(actions[0].orders[0].p,'0.4');
  await c.tick();assert.equal(actions.length,1); // resting order is not duplicated
  if(finish==='owner_stop')await ui.stop(ctx,session.id);else{valid=false;await c.tick();}
  assert.equal((await c.get(session.id)).status,'stopped');assert.equal(actions[1].type,'cancel');
  await c.tick();assert.equal(actions.length,2);
  assert.equal((await c.get(session.id)).exposure.shares,0);
 }finally{try{await c.shutdown();}finally{await runtime.invalidateUserState(owner);runtime.setHLClient(null);rmSync(dir,{recursive:true,force:true});}}
});
