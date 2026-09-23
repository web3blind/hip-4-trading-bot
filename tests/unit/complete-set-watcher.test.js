import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCompleteSetWatcher} from '../../src/modules/complete-set-watcher.js';
import {meta,templates,fees,account,fixedNow} from '../fixtures/complete-set.js';
test('disabled by default; successful delivery gates dedup, invalid quote re-arms',async()=>{
 let reads=0,sends=0,clock=fixedNow,fail=true,high=false;
 const client={address:account,network:'mainnet',getOutcomeMeta:async()=>{reads++;return meta},getOutcomeTemplates:async()=>templates,getUserFees:async()=>fees,
  getOrderbook:async coin=>({levels:[[],[{px:high?'0.5':{'#44830':'0.28','#44840':'0.26','#44850':'0.44'}[coin],sz:'500'}]]}),
  prepareOrder:async r=>({...r,maxSpend:r.price*r.size*1.01})};
 const states=new Map(),alerts={get:id=>states.get(id)||{last_alert_at:0,miss_count:0,active:0},put:(id,last_alert_at,miss_count,active)=>states.set(id,{last_alert_at,miss_count,active})};
 const watcher=createCompleteSetWatcher({now:()=>clock,onAlert:async()=>{sends++;return !fail},cooldownMs:10_000,alerts});
 assert.equal(await watcher(client),0);assert.equal(reads,0);
 assert.equal(await watcher(client,{enabled:true,budget:100}),0);assert.equal(sends,1);
 fail=false;assert.equal(await watcher(client,{enabled:true,budget:100}),1);assert.equal(sends,2);
 assert.equal(await watcher(client,{enabled:true,budget:100}),0);assert.equal(sends,2);
 high=true;assert.equal(await watcher(client,{enabled:true,budget:100}),0);
 assert.equal(await watcher(client,{enabled:true,budget:100}),0);
 high=false;assert.equal(await watcher(client,{enabled:true,budget:100}),1);assert.equal(sends,3);
});
