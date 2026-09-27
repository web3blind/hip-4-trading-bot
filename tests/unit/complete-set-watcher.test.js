import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCompleteSetWatcher} from '../../src/modules/complete-set-watcher.js';
import {meta,templates,fees,account,fixedNow} from '../fixtures/complete-set.js';

const emptyBalances={balances:[]};

test('only new or materially improved opportunities alert; repeats, worse quotes and legacy alert rows stay silent',async()=>{
 let reads=0,sends=0,clock=fixedNow,fail=true,px=.28;
 const client={address:account,network:'mainnet',getOutcomeMeta:async()=>{reads++;return meta},
  getOutcomeTemplates:async()=>templates,getUserFees:async()=>fees,getUserBalances:async()=>emptyBalances,
  getOrderbook:async coin=>({levels:[[],[{px:coin==='#44830'?px:coin==='#44840'?.26:.44,sz:'500'}]]}),
  prepareOrder:async r=>({...r,maxSpend:r.price*r.size*1.01})};
 const states=new Map(),alerts={get:id=>states.get(id)||{last_alert_at:0,miss_count:0,active:0,last_net_floor:null},
  put:(id,last_alert_at,miss_count,active,last_net_floor)=>states.set(id,{last_alert_at,miss_count,active,last_net_floor})};
 const watcher=createCompleteSetWatcher({now:()=>clock,onAlert:async()=>{sends++;return !fail},cooldownMs:10_000,alerts,pending:()=>new Set()});
 assert.equal(await watcher(client),0);assert.equal(reads,0);
 assert.equal(await watcher(client,{enabled:true,budget:100}),0);assert.equal(sends,1);
 fail=false;assert.equal(await watcher(client,{enabled:true,budget:100}),1);assert.equal(sends,2);
 clock+=60_000;
 assert.equal(await watcher(client,{enabled:true,budget:100}),0);assert.equal(sends,2);
 px=.285;assert.equal(await watcher(client,{enabled:true,budget:100}),0);assert.equal(sends,2);
 px=.2799;assert.equal(await watcher(client,{enabled:true,budget:100}),0);assert.equal(sends,2);
 px=.26;assert.equal(await watcher(client,{enabled:true,budget:100}),1);assert.equal(sends,3);
 clock+=60_000;assert.equal(await watcher(client,{enabled:true,budget:100}),0);assert.equal(sends,3);
 states.set(325,{last_alert_at:clock-30_000,miss_count:0,active:1,last_net_floor:null});
 assert.equal(await watcher(client,{enabled:true,budget:100}),0);assert.equal(sends,3);
 px=.5;await watcher(client,{enabled:true,budget:100});await watcher(client,{enabled:true,budget:100});
 px=.28;assert.equal(await watcher(client,{enabled:true,budget:100}),1);assert.equal(sends,4);
});

test('held leg or pending attempt suppresses question without clearing dedup; malformed/failed balance fetch fails closed',async()=>{
 let sends=0,books=0,clock=fixedNow,balances={balances:[{coin:'+44830',total:'39'}]},pending=new Set();
 const state={last_alert_at:clock-100_000,miss_count:0,active:1,last_net_floor:.1};
 const alerts={get:()=>state,put:(_id,last_alert_at,miss_count,active,last_net_floor)=>Object.assign(state,{last_alert_at,miss_count,active,last_net_floor})};
 const client={address:account,network:'mainnet',getOutcomeMeta:async()=>meta,getOutcomeTemplates:async()=>templates,
  getUserFees:async()=>fees,getUserBalances:async()=>balances,
  getOrderbook:async coin=>{books++;return {levels:[[],[{px:{'#44830':'.26','#44840':'.24','#44850':'.42'}[coin],sz:'500'}]]}},
  prepareOrder:async r=>({...r,maxSpend:r.price*r.size*1.01})};
 const watcher=createCompleteSetWatcher({now:()=>clock,onAlert:async()=>{sends++;return true},cooldownMs:10_000,alerts,pending:()=>pending});
 assert.equal(await watcher(client,{enabled:true,budget:100}),0);assert.equal(books,0);assert.equal(state.active,1);
 balances=emptyBalances;pending=new Set([325]);
 assert.equal(await watcher(client,{enabled:true,budget:100}),0);assert.equal(books,0);
 pending.clear();balances={balances:[{coin:'#44830',total:'unknown'}]};
 await assert.rejects(watcher(client,{enabled:true,budget:100}),/Invalid outcome balance/);
 balances=emptyBalances;client.getUserBalances=async()=>{throw new Error('balances offline')};
 await assert.rejects(watcher(client,{enabled:true,budget:100}),/balances offline/);
 assert.equal(state.active,1);assert.equal(state.miss_count,0);assert.equal(sends,0);
 client.getUserBalances=async()=>emptyBalances;
 client.getUserFees=async()=>({});assert.equal(await watcher(client,{enabled:true,budget:100}),0);
 assert.equal(state.active,1);assert.equal(state.miss_count,0);
 client.getUserFees=async()=>fees;client.getOrderbook=async()=>({levels:[[],[]]});
 assert.equal(await watcher(client,{enabled:true,budget:100}),0);
 assert.equal(state.active,1);assert.equal(state.miss_count,0);
 client.getOrderbook=async coin=>({levels:[[],[{px:{'#44830':'.26','#44840':'.24','#44850':'.42'}[coin],sz:'500'}]]});
 assert.equal(await watcher(client,{enabled:true,budget:100}),1);assert.equal(sends,1);
});
