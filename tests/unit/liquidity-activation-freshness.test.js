import test from 'node:test';
import assert from 'node:assert/strict';
import {eventHarness} from './liquidity-event-harness.js';

for(const scenario of [
 {name:'six-second credential validation',bookOffset:0,delay:6000},
 {name:'one mandatory book expires while assessment remains fresh',bookOffset:-4000,delay:1001},
 {name:'assessment expires while all books remain fresh',bookOffset:1000,delay:5001},
 {name:'exact five-second boundary remains admissible',bookOffset:0,delay:5000,allowed:true},
])test(`connected owner activation: ${scenario.name}`,async()=>{
 let f,reads=0,finalChecks=0,approving=false;
 f=eventHarness({credentialCurrent:async credential=>{
  assert.equal(credential.id,f.credential.id);
  if(approving && reads===12){finalChecks++;await Promise.resolve();f.time+=scenario.delay;}
  return true;
 }});
 try{
  const draft=await f.propose();
  const policy=structuredClone(draft.policy),assessment=structuredClone(draft.assessment);
  const read=f.client.getOrderbook;
  f.client.getOrderbook=async coin=>{if(approving)reads++;return read(coin);};
  // The full six-leg assessment reads each mandatory book twice. Delay ONLY
  // the real coordinator's final credential validation after that snapshot.
  for(const [i,b] of Object.values(f.books).entries())b.time=f.time+(scenario.bookOffset<0&&i>0?0:scenario.bookOffset);
  approving=true;
  if(scenario.allowed){
   const active=await f.approve(draft.id);
   assert.equal(active.status,'active');assert.equal(active.assessment.observedAt+5000,f.time);
  }else{
   await assert.rejects(f.approve(draft.id),/Assessment expired; review again/);
   approving=false;
   const retained=await f.c.get(draft.id);
   assert.equal(retained.status,'draft');assert.equal(retained.startedAt,null);assert.equal(retained.expiresAt,null);
   assert.deepEqual(retained.policy,policy);assert.deepEqual(retained.assessment,assessment);
   await f.c.tick();assert.equal((await f.c.get(draft.id)).status,'draft');
   // Fresh evidence and an explicit new review/approval are required, never
   // an automatic activation or submission from the failed owner grant.
   approving=false;for(const b of Object.values(f.books))b.time=f.time;
   await f.c.assess(draft.id);assert.equal((await f.c.get(draft.id)).status,'draft');
   assert.equal((await f.approve(draft.id)).status,'active');
  }
  assert.equal(reads,12);assert.equal(finalChecks,1);assert.equal(f.actions.length,0);
 }finally{approving=false;await f.close();}
});
