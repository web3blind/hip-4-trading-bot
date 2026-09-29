import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLiquidityStore } from '../../src/modules/liquidity/store.js';
import { createLiquidityService } from '../../src/modules/liquidity/engine.js';
const account='0x'+'1'.repeat(40),t=Date.parse('2026-01-01T00:00:00Z');
const policy=(mode='live')=>({mode,coin:'#300',account,network:'testnet',durationMinutes:30,budgetUsdc:100,maxInventoryShares:100,orderSizeShares:20,minPrice:0.2,maxPrice:0.8,minSpread:0.1,maxLossUsdc:30,maxActions:2});
function fixture(mode='live',authorize=async()=>true) {
  const dir=mkdtempSync(join(tmpdir(),'liq-engine-'));let time=t,oid=11,placed=[],cancelled=[],balance=0,foreign=[],status='open',fills=[];
  const meta={outcomes:[{outcome:30,quoteToken:'USDC',name:'Sample',description:'time:20260102-0000',szDecimals:0,deployerFeeScale:1}]};
  const client={network:'testnet',address:account,
    getOutcomeMeta:async()=>meta,getUserBalances:async()=>({balances:balance?[{coin:'#300',total:String(balance)}]:[]}),getOpenOrders:async()=>foreign,
    getUserFees:async()=>({userSpotCrossRate:'0.001',feeSchedule:{spotCross:'0.001'}}),getAvailableUsdc:async()=>100,
    getOrderbook:async()=>({time,levels:[[{px:'0.4'}],[{px:'0.6'}]]}),
    prepareMakerOrder:async ({coin,isBuy,price,size})=>({coin,isBuy,price,size,orderType:'PostOnly',maxSpend:8.08}),
    placeMakerOrders:async r=>{placed.push(r);return {status:'ok',response:{type:'order',data:{statuses:[{resting:{oid:oid++}}]}}};},
    getOrderStatus:async id=>{const index=typeof id==='number'?id-11:placed.findIndex(batch=>batch[0]?.cloid===id);return {order:{status,order:{oid:typeof id==='number'?id:11+index,cloid:placed[index]?.[0]?.cloid,coin:'#300',side:placed[index]?.[0]?.isBuy?'B':'A'}}}},getUserFillsByTime:async()=>fills,
    cancelOrder:async(coin,id)=>{cancelled.push(id);status='canceled';return {verifiedCancelled:[id]}}};
  const store=createLiquidityStore({dataDir:dir,account,network:'testnet'});
  const service=createLiquidityService({store,ownerId:7,now:()=>time,authorize});
  return {dir,store,service,client,meta,placed,cancelled,setTime:v=>{time=v},setStatus:v=>{status=v},setBalance:v=>{balance=v},setFills:v=>{fills=v},setForeign:v=>{foreign=v},close(){store.close();rmSync(dir,{recursive:true,force:true})}};
}
async function approved(f,mode='live') {const s=f.service.propose(policy(mode),{requestId:'request001'});await f.service.approve(s.id,{ownerId:7,client:f.client});return s.id;}
test('strict policy, owner, foreign order and idempotent request',async()=>{const f=fixture();try{
  assert.throws(()=>f.service.propose({...policy(),extra:1},{requestId:'request001'}));
  assert.throws(()=>f.service.propose({...policy(),budgetUsdc:'100'},{requestId:'request001'}));
  const s=f.service.propose(policy(),{requestId:'request001'});assert.equal(f.service.propose(policy(),{requestId:'request001'}).id,s.id);
  await assert.rejects(f.service.approve(s.id,{ownerId:8,client:f.client}));
  f.setForeign([{coin:'#300',oid:50}]);await assert.rejects(f.service.approve(s.id,{ownerId:7,client:f.client}));
  f.setForeign([]);await f.service.approve(s.id,{ownerId:7,client:f.client});assert.equal(f.service.get(s.id).status,'active');
}finally{f.close()}});
test('observation never signs or cancels, even on stop/recover',async()=>{const f=fixture('observe');try{
  const id=await approved(f,'observe');await f.service.tick(f.client);assert.equal(f.service.get(id).proposals.length,1);
  await f.service.stop(id,{ownerId:7,client:f.client});await f.service.recover(f.client);
  assert.equal(f.placed.length,0);assert.equal(f.cancelled.length,0);
}finally{f.close()}});
test('durable prepared intent, controlled ALO, reopen recovery cancels owned OID only',async()=>{const f=fixture();try{
  const id=await approved(f);await f.service.tick(f.client);assert.equal(f.placed.length,1);assert.equal(f.service.get(id).orders[0].state,'open');
  assert.equal(f.service.get(id).orders[0].cloid,f.placed[0][0].cloid);f.store.close();
  const second=createLiquidityStore({dataDir:f.dir,account,network:'testnet'});
  const service=createLiquidityService({store:second,ownerId:7,now:()=>t});
  await service.recover(f.client);assert.deepEqual(f.cancelled,[11]);assert.equal(service.get(id).status,'stopped');
  assert.equal(service.hasUnresolved(),false);second.close();
  f.close=()=>rmSync(f.dir,{recursive:true,force:true});
}finally{f.close()}});
test('unknown CLOID never blindly resubmits or cancels foreign OID',async()=>{const f=fixture();try{
  const id=await approved(f);f.client.placeMakerOrders=async r=>{f.placed.push(r);throw Error('timeout')};
  await f.service.tick(f.client);assert.equal(f.service.get(id).orders[0].state,'unknown');
  f.client.getOrderStatus=async()=>({status:'unknownOid'});
  await f.service.tick(f.client);assert.equal(f.placed.length,1);
  await f.service.stop(id,{ownerId:7,client:f.client});assert.equal(f.service.hasUnresolved(),true);assert.deepEqual(f.cancelled,[]);
}finally{f.close()}});
test('late authorization and expiry suppress new orders',async()=>{
  const f=fixture('live',async()=>false);try{const id=await approved(f);await f.service.tick(f.client);assert.equal(f.placed.length,0);assert.equal(f.service.get(id).reason,'authorization_or_expiry');}finally{f.close()}
  const g=fixture();try{const id=await approved(g);g.setTime(t+31*60000);await g.service.tick(g.client);assert.equal(g.placed.length,0);assert.equal(g.service.get(id).status,'stopped');}finally{g.close()}
});
test('partial fill evidence, exposure continuity and external inventory pause',async()=>{const f=fixture();try{
  const id=await approved(f);await f.service.tick(f.client);f.setStatus('open');f.setBalance(10);
  f.setFills([{oid:11,tid:1,sz:'10',px:'0.4',fee:'0.01',feeToken:'USDC'}]);
  await f.service.tick(f.client);assert.equal(f.service.get(id).exposure.shares,10);assert.equal(f.placed.length,1);
  f.setBalance(11);await f.service.tick(f.client);assert.equal(f.service.get(id).reason,'Inventory or spend mismatch');assert.deepEqual(f.cancelled,[11]);
}finally{f.close()}});
test('proven shares may be offered ALO; cumulative buy spend never recycles',async()=>{const f=fixture();try{
  const id=await approved(f);await f.service.tick(f.client);
  f.setStatus('filled');f.setBalance(20);
  f.setFills([{oid:11,tid:1,sz:'20',px:'0.4',fee:'0.01',feeToken:'USDC'}]);
  await f.service.tick(f.client);
  assert.equal(f.placed[1][0].isBuy,false);assert.equal(f.placed[1][0].price,0.6);
  assert.equal(f.service.get(id).exposure.spend,8.01);
  assert.equal(f.service.get(id).orders[1].reserve,0);
}finally{f.close()}});
test('unknown fee, changed metadata, foreign order and near expiry fail closed',async()=>{
  for(const scenario of ['fee','metadata','foreign','expiry']) {const f=fixture();try {
    await approved(f);
    if(scenario==='fee') f.client.getUserFees=async()=>({});
    if(scenario==='metadata') f.meta.outcomes[0].name='Changed';
    if(scenario==='foreign') f.setForeign([{coin:'#300',oid:89}]);
    if(scenario==='expiry') f.client.prepareMakerOrder=async args=>{f.setTime(t+31*60000);return {coin:args.coin,isBuy:args.isBuy,price:args.price,size:args.size,orderType:'PostOnly',maxSpend:8.08}};
    await f.service.tick(f.client);assert.equal(f.placed.length,0,scenario);
  }finally{f.close()}}
});
test('credential revocation halts grant without an order',async()=>{const g=fixture();try {
  const draft=g.service.propose(policy(),{requestId:'request002',credentialId:'agent',credentialGeneration:1});
  await g.service.approve(draft.id,{ownerId:7,client:g.client});
  await g.service.revokeCredential('agent',1,g.client);
  assert.equal(g.service.get(draft.id).reason,'credential_revoked');
  await g.service.tick(g.client);assert.equal(g.placed.length,0);
}finally{g.close()}});
test('loss stop marks held shares against fresh bid and forbids replacement',async()=>{const f=fixture();try{
  const s=f.service.propose({...policy(),maxLossUsdc:0.1},{requestId:'request003'});
  await f.service.approve(s.id,{ownerId:7,client:f.client});await f.service.tick(f.client);
  f.setStatus('filled');f.setBalance(20);
  f.setFills([{oid:11,tid:3,sz:'20',px:'0.5',fee:'0.01',feeToken:'USDC'}]);
  await f.service.tick(f.client);
  assert.equal(f.service.get(s.id).reason,'loss_stop');assert.equal(f.placed.length,1);
  assert.equal(f.service.get(s.id).exposure.shares,20);
}finally{f.close()}});
test('cancel race with partial fill retains inventory evidence and stopped session',async()=>{const f=fixture();try{
  const id=await approved(f);await f.service.tick(f.client);
  f.setBalance(5);f.setFills([{oid:11,tid:7,sz:'5',px:'0.4',fee:'0.01',feeToken:'USDC'}]);
  await f.service.stop(id,{ownerId:7,client:f.client});
  assert.equal(f.service.get(id).status,'stopped');assert.equal(f.service.get(id).exposure.shares,5);
  assert.deepEqual(f.cancelled,[11]);assert.equal(f.placed.length,1);
}finally{f.close()}});
test('MCP namespaced request and string credential generation retain idempotence',()=>{const f=fixture();try{
  const opts={requestId:'a'.repeat(16)+':'+'b'.repeat(24)+':request001',credentialId:'a'.repeat(16),credentialGeneration:'b'.repeat(24)};
  const s=f.service.propose(policy(),opts);
  assert.equal(f.service.propose(policy(),opts).id,s.id);
  assert.equal(f.service.get(s.id).credentialGeneration,opts.credentialGeneration);
  assert.throws(()=>f.service.propose(policy(),{...opts,requestId:'bad:request001'}));
  assert.throws(()=>f.service.propose(policy(),{...opts,credentialGeneration:'bad'}));
}finally{f.close()}});
test('unknown CLOID lookup cannot adopt a mismatched or incomplete OID',async()=>{
  for(const mismatch of ['cloid','coin','side','account','missingCloid','missingCoin','missingSide']) {const f=fixture();try{
    const id=await approved(f);
    f.client.placeMakerOrders=async orders=>{f.placed.push(orders);throw Error('timeout')};
    await f.service.tick(f.client);
    const cloid=f.service.get(id).orders[0].cloid;
    const detail={oid:999,cloid,coin:'#300',side:'B'};
    if(mismatch==='cloid') detail.cloid='0x'+'f'.repeat(32);
    if(mismatch==='coin') detail.coin='#400';
    if(mismatch==='side') detail.side='A';
    if(mismatch==='missingCloid') delete detail.cloid;
    if(mismatch==='missingCoin') delete detail.coin;
    if(mismatch==='missingSide') delete detail.side;
    f.client.getOrderStatus=async()=>({account:mismatch==='account'?'0x'+'2'.repeat(40):account,order:{status:'open',order:detail}});
    await f.service.stop(id,{ownerId:7,client:f.client});
    assert.equal(f.service.get(id).orders[0].oid,null,mismatch);
    assert.equal(f.service.get(id).status,'recovery_required',mismatch);
    assert.deepEqual(f.cancelled,[],mismatch);
    await f.service.tick(f.client);
    assert.equal(f.placed.length,1,mismatch);
    assert.deepEqual(f.cancelled,[],mismatch);
  }finally{f.close()}}
});
test('validated CLOID may be adopted and cancelled on next cleanup tick without new quotes',async()=>{const f=fixture();try{
  const id=await approved(f);f.client.placeMakerOrders=async orders=>{f.placed.push(orders);throw Error('timeout')};
  await f.service.tick(f.client);
  f.client.getOrderStatus=async()=>({order:{status:'open',order:{oid:777,cloid:f.placed[0][0].cloid,coin:'#300',side:'B'}}});
  f.client.cancelOrder=async(coin,oid)=>{f.cancelled.push(oid);throw Error('outage')};
  await f.service.stop(id,{ownerId:7,client:f.client});
  assert.equal(f.service.get(id).status,'recovery_required');assert.deepEqual(f.cancelled,[777]);
  f.client.cancelOrder=async(coin,oid)=>{f.cancelled.push(oid);f.client.getOrderStatus=async()=>({order:{status:'canceled',order:{oid:777,cloid:f.placed[0][0].cloid,coin:'#300',side:'B'}}})};
  await f.service.tick(f.client);
  assert.equal(f.service.get(id).status,'stopped');assert.deepEqual(f.cancelled,[777,777]);
  assert.equal(f.placed.length,1);
}finally{f.close()}});
test('exposure timestamp requires successful fills and balances reconciliation',async()=>{const f=fixture();try{
  const id=await approved(f);assert.equal(f.service.get(id).exposure.observedAt,undefined);
  await f.service.tick(f.client);assert.equal(f.service.get(id).exposure.observedAt,t);
  f.setTime(t+1000);f.client.getUserFillsByTime=async()=>{throw Error('unavailable')};
  await f.service.tick(f.client);
  assert.equal(f.service.get(id).exposure.observedAt,t);
  assert.equal(f.service.get(id).status,'recovery_required');
}finally{f.close()}});
