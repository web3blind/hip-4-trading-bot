import test from 'node:test';
import assert from 'node:assert/strict';
import {eventHarness} from './liquidity-event-harness.js';
import {assessLiquidityEvent} from '../../src/modules/liquidity/event.js';
import {feeEvidence,bookQuote,market} from '../../src/modules/liquidity/market.js';
test('all 18 required legs survive slow real maker preparation without widening the five-second guard',async()=>{
 const f=eventHarness();try{
  f.setSpot(1000);
  f.meta.outcomes=Array.from({length:9},(_,i)=>({...f.meta.outcomes[0],outcome:30+i}));
  f.meta.questions[0].namedOutcomes=Array.from({length:8},(_,i)=>30+i);f.meta.questions[0].fallbackOutcome=38;
  const prepare=f.client.prepareMakerOrder.bind(f.client);let clock=f.time,count=0,pending=0,peak=0;
  f.client.prepareMakerOrder=async args=>{pending++;peak=Math.max(peak,pending);clock+=600;await Promise.resolve();try{return await prepare(args);}finally{pending--;count++;}};
  f.client.getOrderbook=async()=>{clock+=100;return {time:clock,levels:[[{px:'0.4',sz:'1000'}],[{px:'0.6',sz:'1000'}]]};};
  const a=await assessLiquidityEvent(f.client,{...f.policy,budgetUsdc:1000,maxInventoryShares:10000,maxActions:100},()=>clock);
  assert.equal(a.suitability,'conditional',JSON.stringify(a.reasons));assert.equal(a.legs.length,18);assert.equal(count,54);assert(peak<=6&&peak>1);assert(a.legs.every(l=>a.observedAt-l.time<=5000));assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
for(const input of [null,undefined,-1,11,'1'])test(`fee evidence refuses unverified scale ${input}`,()=>{
 assert.throws(()=>feeEvidence({userSpotCrossRate:'0.001',feeSchedule:{spotCross:'0.001'}},input));
});
test('fee ceiling unchanged: base/account maximum, conservative multiplier, no maker-rebate reduction',()=>{
 const fees={userSpotCrossRate:'0.0002',userSpotAddRate:'-0.0005',feeSchedule:{spotCross:'0.001',spotAdd:'-0.0005'}};
 assert.equal(feeEvidence(fees,1),0.004);assert.equal(feeEvidence(fees,0),0.002);
 assert.equal(feeEvidence({...fees,userSpotAddRate:'0.002'},1),0.008);
 assert.throws(()=>feeEvidence({...fees,userSpotCrossRate:null},1),/unknown/);
});
test('approval cannot admit unknown capital evidence even when fee/book/size digest is unchanged',async()=>{
 const f=eventHarness();try{
  const s=await f.propose();const balances=f.client.getUserBalances;let count=0;
  f.client.getUserBalances=async(...args)=>{if(++count===2)throw Object.assign(Error('Read timeout'),{code:'ETIMEDOUT'});return balances(...args);};
  await assert.rejects(f.approve(s.id),/Event/);assert.equal((await f.c.get(s.id)).status,'draft');assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
test('verified no quotes or invalid corridor is unsuitable; missing, malformed or stale evidence is unavailable',()=>{
 const p={minSpread:.01,minPrice:.1,maxPrice:.9},time=Date.now();
 for(const b of [{time,levels:[[],[]]},{time,levels:[[{px:'.4'}],[{px:'0.6'}]]},{time:time-5001,levels:[[{px:'0.4'}],[{px:'0.6'}]]},{time,levels:[[{px:'0.6'}],[{px:'0.4'}]]}]){
  assert.throws(()=>bookQuote(b,time,p),e=>e.code===(b.levels[0].length===0?'no_two_sided_book':b.levels[0][0].px==='0.6'?'book_unsuitable':'book_data_unavailable'));
 }
});
