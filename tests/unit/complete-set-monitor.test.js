import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reconcileCompleteSetAttempts} from '../../src/modules/complete-set-monitor.js';
import {account} from '../fixtures/complete-set.js';
test('unknown batch recovers by cloid after restart without re-order, then marks complete',async()=>{
 const ids=['0x'+'a'.repeat(32),'0x'+'b'.repeat(32),'0x'+'c'.repeat(32)];
 let row={id:'attempt',account,network:'mainnet',question_id:730,shares:40,state:'submitted_unknown',notified_state:'',
  legs:ids.map((cloid,i)=>({coin:`#${i+1}0`,cloid,size:40,price:.33,status:'prepared'}))};
 const writes=[],notified=[];let calls=0,fillCount=1;
 const client={address:account,network:'mainnet',getOrderStatus:async cloid=>({status:'order',order:{status:'filled',order:{oid:100+ids.indexOf(cloid)}}}),
  getUserFills:async()=>ids.slice(0,fillCount).map((_,i)=>({oid:100+i,tid:i+1,sz:'40',px:'.33',fee:'0.01'})),
  placeOrders:()=>{throw Error('never call')},};
 const repo={list:()=>[row],update:(id,state,legs)=>{writes.push(state);row={...row,state,legs}},markNotified:(id,state)=>{row.notified_state=state;return true}};
 const notify=async value=>{calls++;notified.push(value.state);return true};
 assert.equal(await reconcileCompleteSetAttempts(client,notify,repo),1);
 assert.equal(row.state,'partial');assert.deepEqual(notified,['partial']);assert.equal(row.legs[0].filledSize,40);
 fillCount=3;assert.equal(await reconcileCompleteSetAttempts(client,notify,repo),1);
 assert.equal(row.state,'filled');assert.deepEqual(notified,['partial','filled']);
 assert.equal(await reconcileCompleteSetAttempts(client,notify,repo),0);assert.equal(calls,2);
});
test('all rejected is terminal without fabricated exposure, all unknown stays unknown',async()=>{
 let row={id:'x',account,network:'mainnet',question_id:1,state:'submitted_unknown',notified_state:'',
  legs:['a','b'].map((c,i)=>({coin:`#${i+1}0`,cloid:'0x'+c.repeat(32),size:40,status:'prepared'}))};
 const seen=[],repo={list:()=>[row],update:(id,state,legs)=>{row={...row,state,legs}},markNotified:(id,state)=>{row.notified_state=state}};
 const client={address:account,network:'mainnet',getUserFills:async()=>[],getOrderStatus:async cloid=>({status:'order',order:{status:'rejected',order:{oid:cloid.includes('a')?111:222}}})};
 await reconcileCompleteSetAttempts(client,async x=>{seen.push(x.state);return true},repo);
 assert.equal(row.state,'rejected');assert.deepEqual(seen,['rejected']);assert(row.legs.every(x=>!x.filledSize));
});
test('distinct API fill windows merge by trade identity; actual cost never shrinks',async()=>{
 const ids=['0x'+'a'.repeat(32),'0x'+'b'.repeat(32)];
 let row={id:'x',account,network:'mainnet',question_id:1,state:'submitted_unknown',notified_state:'',
  legs:ids.map((cloid,i)=>({coin:`#${i+1}0`,cloid,size:40,status:'prepared'}))};
 let window=[{oid:100,tid:1,sz:'20',px:'.2',fee:'0.01',feeToken:'USDC'}];
 const client={address:account,network:'mainnet',getOrderStatus:async cloid=>({status:'order',order:{status:'filled',order:{oid:100+ids.indexOf(cloid)}}}),getUserFills:async()=>window};
 const repo={list:()=>[row],update:(id,state,legs)=>{row={...row,state,legs}},markNotified:()=>true};
 await reconcileCompleteSetAttempts(client,null,repo);
 assert.equal(row.legs[0].filledSize,20);assert.equal(row.legs[0].fillCost,4);
 window=[{oid:100,tid:2,sz:'20',px:'.3',fee:'0.02',feeToken:'USDC'},
         {oid:101,tid:3,sz:'40',px:'.4',fee:'0.03',feeToken:'USDC'}];
 await reconcileCompleteSetAttempts(client,null,repo);
 assert.equal(row.state,'filled');assert.equal(row.legs[0].filledSize,40);
 assert.equal(row.legs[0].fillCost,10);assert.equal(row.legs[0].actualFee,0.03);
 window=[];await reconcileCompleteSetAttempts(client,null,repo);
 assert.equal(row.legs[0].fillCost,10);assert.equal(row.legs[0].trades.length,2);
});
test('unknownOid and missing fills remain ambiguous, mismatched wallet cannot read',async()=>{
 let lookups=0;
 const row={id:'id',account,network:'mainnet',question_id:1,state:'submitted_unknown',notified_state:'',legs:[{cloid:'0x'+'a'.repeat(32),coin:'#10',size:40},{cloid:'0x'+'b'.repeat(32),coin:'#20',size:40}]};
 const client={address:account,network:'mainnet',getUserFills:async()=>[],getOrderStatus:async()=>{lookups++;return {status:'unknownOid'}}};
 const repo={list:()=>[row],update:()=>{throw Error('unexpected state change')},markNotified:()=>{throw Error('unexpected notify')}};
 assert.equal(await reconcileCompleteSetAttempts(client,()=>{throw Error('unexpected message')},repo),0);assert.equal(lookups,2);
 client.address='0x'+'2'.repeat(40);assert.equal(await reconcileCompleteSetAttempts(client,null,repo),0);assert.equal(lookups,2);
});
