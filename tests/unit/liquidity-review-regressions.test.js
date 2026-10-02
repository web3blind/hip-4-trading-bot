import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {HLClient} from '../../src/modules/hyperliquid.js';
import {createLiquidityStore} from '../../src/modules/liquidity/store.js';
import {createLiquidityService} from '../../src/modules/liquidity/engine.js';
import {createLiquidityCoordinator,proposeLiquiditySession,approveLiquiditySession,tickLiquidity,getLiquiditySession} from '../../src/modules/liquidity/coordinator.js';
import {createLiquidityMcp} from '../../src/modules/liquidity/mcp.js';
import {handleCallbackQuery} from '../../src/modules/bot/routing/callback-router.js';
import * as runtime from '../../src/modules/bot/runtime.js';
import {setSessionConfig} from '../../src/modules/config.js';
import {initDatabase,closeDatabase} from '../../src/modules/database.js';

const account='0x'+'1'.repeat(40),start=Date.parse('2026-01-01T00:00:00Z');
const policy=()=>({mode:'live',coin:'#300',account,network:'testnet',durationMinutes:30,budgetUsdc:100,maxInventoryShares:100,orderSizeShares:30,minPrice:.2,maxPrice:.8,minSpread:.1,maxLossUsdc:30,maxActions:3});
function setup(real=false) {
 const dir=mkdtempSync(join(tmpdir(),'liq-review-'));let time=start,status='open',nextOid=11;
 const submitted=[],canceled=[],orders=new Map(),fees={userSpotCrossRate:'0.001',feeSchedule:{spotCross:'0.001'}};
 const client=real?new HLClient('0x'+'1'.repeat(64),'testnet'):{network:'testnet',address:account};
 const meta={outcomes:[{outcome:30,quoteToken:'USDC',name:'Event',expiry:start+86400000,szDecimals:0,deployerFeeScale:1}],questions:[]};
 Object.assign(client,{
  getOutcomeMeta:async()=>meta,getUserBalances:async()=>({balances:[]}),getOpenOrders:async()=>[...orders.values()].filter(x=>x.status==='open').map(x=>x.order),
  getUserFees:async()=>fees,getAvailableUsdc:async()=>100,getUserFillsByTime:async()=>[],
  getOrderbook:async()=>({time,levels:[[{px:'0.4'}],[{px:'0.6'}]]}),
  getOrderStatus:async id=>{const x=[...orders.values()].find(x=>x.order.oid===id||x.order.cloid===id);return x?{order:x}:{status:'unknownOid'};},
  cancelOrder:async(coin,id)=>{canceled.push(id);orders.get(id).status='canceled';return {verifiedCancelled:[id]};}
 });
 if(real) {
  client._infoRequest=async request=>{assert.equal(request.type,'userFees');return fees;};
  client._exchangeRequest=async payload=>{
   assert(payload.signature);submitted.push(payload.action);
   const wire=payload.action.orders[0],id=nextOid++;
   assert.equal(wire.t.limit.tif,'Alo');
   orders.set(id,{status:'open',order:{oid:id,cloid:wire.c,coin:'#300',side:wire.b?'B':'A'}});
   return {status:'ok',response:{type:'order',data:{statuses:[{resting:{oid:id}}]}}};
  };
 }else{
  client.prepareMakerOrder=async ({coin,isBuy,price,size})=>({coin,isBuy,price,size,orderType:'PostOnly',maxSpend:12.12});
  client.placeMakerOrders=async requests=>{
   submitted.push(requests);const r=requests[0],id=nextOid++;
   orders.set(id,{status,order:{oid:id,cloid:r.cloid,coin:r.coin,side:r.isBuy?'B':'A'}});
   return {status:'ok',response:{type:'order',data:{statuses:[{resting:{oid:id}}]}}};
  };
 }
 const store=createLiquidityStore({dataDir:dir,account:client.address,network:'testnet'});
 const engine=createLiquidityService({store,ownerId:77,now:()=>time});
 return {dir,store,engine,client,submitted,canceled,orders,fees,setTime:v=>{time=v},setStatus:v=>{status=v;for(const x of orders.values())x.status=v},close(){store.close();rmSync(dir,{recursive:true,force:true})}};
}
async function approve(f){const row=f.engine.propose({...policy(),account:f.client.address.toLowerCase()},{requestId:'review_req_123'});await f.engine.approve(row.id,{ownerId:77,client:f.client});return row.id;}

test('draft stop with ordinary inventory cannot starve active expiry',async()=>{const f=setup();try{
 const id=await approve(f);await f.engine.tick(f.client);
 f.client.getUserBalances=async()=>({balances:[{coin:'#400',total:'5'}]});
 const draft=f.engine.propose({...policy(),coin:'#400'},{requestId:'draft_other_123'});
 f.engine.requestStop(draft.id,{ownerId:77,client:f.client});await f.engine.stop(draft.id,{ownerId:77,client:f.client});
 assert.equal(f.engine.get(draft.id).status,'stopped');
 f.setTime(start+31*60000);await f.engine.tick(f.client);assert.equal(f.engine.get(id).status,'stopped');assert.deepEqual(f.canceled,[11]);
}finally{f.close()}});
test('stop during approval cannot revive draft',async()=>{const f=setup();try{
 const draft=f.engine.propose(policy(),{requestId:'draft_race_123'}),original=f.client.getUserFees;
 f.client.getUserFees=async()=>{f.engine.requestStop(draft.id,{ownerId:77,client:f.client});return original();};
 await assert.rejects(f.engine.approve(draft.id,{ownerId:77,client:f.client}),/stopped during approval/);
 assert.equal(f.engine.get(draft.id).status,'stopped');assert.equal(f.engine.get(draft.id).startedAt,null);
}finally{f.close()}});

test('real HLClient fee await crosses expiry: never signs, aborted intent is terminal',async()=>{const f=setup(true);try{
 const id=await approve(f);let signed=0;
 const originalSign=f.client.wallet._signTypedData.bind(f.client.wallet);
 f.client.wallet._signTypedData=async(...args)=>{signed++;return originalSign(...args)};
 f.client._infoRequest=async()=>{f.setTime(start+31*60000);return f.fees};
 await f.engine.tick(f.client);
 assert.equal(signed,0);
 assert.equal(f.submitted.length,0);assert.equal(f.engine.get(id).orders[0].state,'aborted');
 assert.equal(f.engine.hasUnresolved(),false);assert.equal(f.engine.get(id).status,'stopped');
}finally{f.close()}});
test('expired unresolved owned order is recovered after SQLite reopen',async()=>{const f=setup();try{
 const id=await approve(f);await f.engine.tick(f.client);
 const row=f.store.get(id);row.status='expired';f.store.save(row);
 f.store.close();const reopened=createLiquidityStore({dataDir:f.dir,account,network:'testnet'});
 const recovery=createLiquidityService({store:reopened,ownerId:77,now:()=>start+31*60000});
 await recovery.recover(f.client);assert.deepEqual(f.canceled,[11]);assert.equal(recovery.get(id).status,'stopped');
 reopened.close();f.close=()=>rmSync(f.dir,{recursive:true,force:true});
}finally{f.close()}});
test('definitive rejection survives unknownOid and cleanup without cancel',async()=>{const f=setup();try{
 const id=await approve(f);
 f.client.placeMakerOrders=async()=>({status:'ok',response:{type:'order',data:{statuses:[{error:'ALO rejected'}]}}});
 await f.engine.tick(f.client);await f.engine.tick(f.client);
 assert.equal(f.engine.get(id).orders[0].state,'rejected');
 await f.engine.stop(id,{ownerId:77,client:f.client});assert.equal(f.engine.get(id).status,'stopped');
 assert.deepEqual(f.canceled,[]);assert.equal(f.engine.hasUnresolved(),false);
}finally{f.close()}});
test('external cancellation pauses without replacement; owner cancellation is expected',async()=>{const f=setup();try{
 const id=await approve(f);await f.engine.tick(f.client);f.setStatus('canceled');
 await f.engine.tick(f.client);await f.engine.tick(f.client);
 assert.equal(f.engine.get(id).status,'paused');assert.equal(f.engine.get(id).reason,'outside_order_cancellation');
 assert.equal(f.submitted.length,1);await f.engine.stop(id,{ownerId:77,client:f.client});assert.equal(f.engine.get(id).status,'stopped');
}finally{f.close()}});
test('stop persists while engine awaits a read and cannot be overwritten by its stale snapshot',async()=>{const f=setup();try{
 const id=await approve(f);let release,entered;const reached=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
 f.client.getUserFees=async()=>{entered();await hold;return f.fees};
 const ticking=f.engine.tick(f.client);await reached;
 assert.equal(f.engine.requestStop(id,{ownerId:77,client:f.client}).status,'stopping');
 assert.equal(f.store.get(id).stopRequested,true);release();await ticking;
 assert.equal(f.submitted.length,0);assert.equal(f.engine.get(id).status,'stopped');
}finally{f.close()}});
test('real HLClient fee preparation yields to durable stop, never transmits order',async()=>{const f=setup(true);try{
 const id=await approve(f);let release,entered;const reached=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
 f.client._infoRequest=async()=>{entered();await hold;return f.fees};
 const ticking=f.engine.tick(f.client);await reached;
 assert.equal(f.engine.requestStop(id,{ownerId:77,client:f.client}).stopRequested,true);
 release();await ticking;
 assert.equal(f.submitted.length,0);assert.equal(f.engine.get(id).orders[0].state,'aborted');
 assert.equal(f.engine.get(id).status,'stopped');
}finally{f.close()}});
test('signing yield crossing expiry cannot transmit signed maker order',async()=>{const f=setup(true);try{
 const id=await approve(f);let release,entered;const reached=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
 const original=f.client.wallet._signTypedData.bind(f.client.wallet);
 f.client.wallet._signTypedData=async(...args)=>{entered();await hold;return original(...args)};
 const ticking=f.engine.tick(f.client);await reached;
 f.setTime(start+31*60000);release();await ticking;
 assert.equal(f.submitted.length,0);assert.equal(f.engine.get(id).orders[0].state,'aborted');
 assert.equal(f.engine.get(id).status,'stopped');
}finally{f.close()}});
test('actual Telegram callback early busy gate and MCP stop persist while worker awaits',async()=>{
 const f=setup(true),owner=77,credential={id:'credential_123456',generation:1,scope:'trade'};
 const expiry=Date.now()+86400000;
 f.client.getOutcomeMeta=async()=>({outcomes:[{outcome:30,quoteToken:'USDC',name:'Event',expiry,deployerFeeScale:1}],questions:[]});
 f.client.getOrderbook=async()=>({time:Date.now(),levels:[[{px:'0.4',sz:'1000'}],[{px:'0.6',sz:'1000'}]]});
 f.client.getUserBalances=async()=>({balances:[{coin:'USDC',total:'100',hold:'0'}]});
 initDatabase({accountAddress:f.client.address,network:'testnet'});
 runtime.setAllowedUserId(owner);runtime.setHLClient(f.client);setSessionConfig({language:'en',hlNetwork:'testnet'});
 const c=createLiquidityCoordinator({getClient:()=>f.client,getOwner:()=>owner,locks:new Map(),dataDir:f.dir,
  credentialCurrent:async()=>true,conflicts:()=>false});
 const api={getLiquiditySession:id=>c.get(id),stopLiquiditySession:(id,opts)=>c.stop(id,opts)};
 const mcp=createLiquidityMcp({api,getClient:()=>f.client,getOwner:()=>owner,currentCredential:async()=>true});
 try{
  await tickLiquidity();await c.tick(); // initial recovery before grant
  for(const path of ['telegram','mcp']) {
   f.client.getUserFees=async()=>f.fees;
   const row=path==='telegram'
     ?await proposeLiquiditySession((()=>{const p=policy();delete p.coin;return {...p,account:f.client.address.toLowerCase(),event:{type:'standalone',id:30}};})(),{requestId:`review_${path}_123`})
     :await c.propose((()=>{const p=policy();delete p.coin;return {...p,account:f.client.address.toLowerCase(),event:{type:'standalone',id:30}};})(),{requestId:`review_${path}_123`,credentialId:credential.id,credentialGeneration:credential.generation});
   if(path==='telegram') await approveLiquiditySession(row.id,{ownerId:owner});
   else await c.approve(row.id,{ownerId:owner});
   f.client.getUserFees=async()=>f.fees;
   let release,entered;const reached=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
   f.client.getUserFees=async()=>{entered();await hold;return f.fees};
   const ticking=path==='telegram'?tickLiquidity():c.tick();await reached;
   if(path==='telegram') {
    const ctx={chat:{id:owner,type:'private'},from:{id:owner},callbackQuery:{data:`liq:stop:${row.id}`},
      answerCallbackQuery:async()=>{},editMessageText:async()=>{},reply:async()=>{}};
    await handleCallbackQuery(ctx);
   } else {
    const result=await mcp('liquidity_stop_session',{session_id:row.id},credential);
    assert.equal(result.status,'stopping');
   }
   const current=path==='telegram'?getLiquiditySession(row.id):c.get(row.id);
   assert.equal((await current).stopRequested,true,path);
   release();await ticking;
   assert.equal((await (path==='telegram'?getLiquiditySession(row.id):c.get(row.id))).status,'stopped',path);
   assert.equal(f.submitted.length,0,path);
  }
 }finally{runtime.setHLClient(null);runtime.setAllowedUserId(null);runtime.busyLocks.delete(owner);closeDatabase();f.close();}
});
