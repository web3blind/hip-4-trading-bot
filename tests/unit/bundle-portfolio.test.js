import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {initDatabase,closeDatabase,createCompleteSetAttempt,updateCompleteSetAttempt,getBundleAttempts,getBundleCloseRequest,createBundleCloseRequest,getBundleFillEvidence,getBundleSnapshot} from '../../src/modules/database.js';
import {evaluateBundle,bundleFillHistory,loadBundlePortfolio,monitorBundlePortfolio,quoteBundleClose,reconcileBundleCloseRequests,verifyBundleOrigin,bundleCoveredCoins} from '../../src/modules/bundle-portfolio.js';

const account='0x'+'a'.repeat(40),coins=['#44830','#44840','#44850'];
const at=Date.parse('2026-09-23T17:58:20Z');
const prices=[.28273,.26401,.44442];
function fixture() {
 const id=randomUUID();
 const legs=coins.map((coin,i)=>({coin,size:39,filledSize:39,oid:String(900+i),price:prices[i],cloid:'0x'+String(i+1).repeat(32)}));
 const attempt={id,question_id:325,created_at:at,coins,legs,state:'filled'};
 const buys=coins.map((coin,i)=>({coin,oid:String(900+i),tid:i+1,time:at,side:'B',dir:'Buy',sz:'39',px:String(prices[i]),fee:'0',feeToken:'USDC',startPosition:'0'}));
 const exits=coins.map((coin,i)=>({coin,oid:String(920+i),tid:i+4,time:at+3*86400000,side:'A',dir:'Settlement',sz:'39',px:i===2?'1':'0',fee:i===2?'.0497952':'0',feeToken:'USDC',startPosition:'39'}));
 return {attempt,buys,exits,balances:{balances:[]}};
}

test('historical settlement with zero-price legs, duplicate identities and real fee',()=>{
 const {attempt,buys,exits,balances}=fixture();
 const r=evaluateBundle(attempt,[attempt],[...buys,...exits],balances,{});
 assert.equal(r.status,'closed');assert.ok(Math.abs(r.cost-38.65524)<1e-8);assert.ok(Math.abs(r.net-.2949648)<1e-8);
 const missing=evaluateBundle(attempt,[attempt],[...buys,...exits.map((f,i)=>i===2?{...f,fee:null}:f)],balances,{});
 assert.equal(missing.net,null);
 assert.equal(evaluateBundle(attempt,[attempt],[...buys,exits[0]],balances,{}).status,'unknown');
});

test('manual partial exit, overlap and unrelated buys block ownership',()=>{
 const {attempt,buys,exits}=fixture();
 const balances={balances:coins.map((coin,i)=>({coin,total:i===0?'19':'39',hold:'0'}))};
 const r=evaluateBundle(attempt,[attempt],[...buys,{...exits[0],sz:'20',dir:'Sell'}],balances,Object.fromEntries(coins.map(c=>[c,'.5'])));
 assert.equal(r.status,'active');assert.equal(r.remaining[0].size,19);
 assert.equal(r.ownershipCertain,true);
 assert.equal(evaluateBundle(attempt,[attempt],[...buys,{...buys[0],oid:'77',tid:77,time:at+1}],balances,{}).ownershipCertain,false);
 const other={...attempt,id:randomUUID(),created_at:at+1};
 assert.equal(evaluateBundle(attempt,[attempt,other],buys,balances,{}).ownershipCertain,false);
});

test('range coverage fails closed on full API page and deduplicates overlapping trade IDs',async()=>{
 const client={address:account,getUserFillsByTime:async()=>Array(2000).fill({time:0,tid:1})};
 await assert.rejects(bundleFillHistory(client,0,0),/Incomplete/);
 client.getUserFillsByTime=async()=>[{time:0,tid:1}];
 assert.equal((await bundleFillHistory(client,0,0)).length,1);
});

test('history accepts newest-first pages and sorts before inventory reconciliation',async()=>{
 const f=fixture();
 const client={address:account,getUserFillsByTime:async(from,to)=>[...f.exits,...f.buys].filter(v=>v.time>=from && v.time<=to)};
 const history=await bundleFillHistory(client,at,at+3*86400000);
 assert.deepEqual(history.map(v=>v.time),[at,at,at,at+3*86400000,at+3*86400000,at+3*86400000]);
 assert.equal(evaluateBundle(f.attempt,[f.attempt],history,f.balances,{}).status,'closed');
 const reversed={address:account,getUserFillsByTime:async()=>[{time:2,tid:2},{time:1,tid:1}]};
 assert.deepEqual((await bundleFillHistory(reversed,0,2)).map(f=>f.tid),[1,2]);
});

test('persistent attempt snapshot, one-use close and failed notification retry',async()=>{
 initDatabase({accountAddress:account,network:'mainnet'});
 try {
  const f=fixture(),id=f.attempt.id;
  createCompleteSetAttempt({id,questionId:325,budget:40,shares:39,coins,account,network:'mainnet',ruleDigest:'a'.repeat(64),feeDigest:'b'.repeat(64),legs:f.attempt.legs});
  updateCompleteSetAttempt(id,'filled',f.attempt.legs);
  assert.equal(getBundleAttempts(account,'mainnet').length,1);
  const client={address:account,network:'mainnet'};
  let calls=0;
  const load=async()=>[{...evaluateBundle(f.attempt,[f.attempt],[...f.buys,...f.exits],f.balances,{}),id}];
  await monitorBundlePortfolio(client,async()=>{calls++;return false;},{load});
  await monitorBundlePortfolio(client,async()=>{calls++;return true;},{load});
  await monitorBundlePortfolio(client,async()=>{calls++;return true;},{load});
  assert.equal(calls,2);
  createBundleCloseRequest({id:randomUUID(),attemptId:id,account,network:'mainnet',legs:[]});
  assert.ok(getBundleCloseRequest(id));
  assert.throws(()=>createBundleCloseRequest({id:randomUUID(),attemptId:id,account,network:'mainnet',legs:[]}));
 } finally {closeDatabase();}
});

test('close quote blocks mixed shares, holds, thin books, and uses IOC',async()=>{
 const f=fixture(),s=evaluateBundle(f.attempt,[f.attempt],f.buys,{balances:coins.map(coin=>({coin,total:'39',hold:'0'}))},Object.fromEntries(coins.map(c=>[c,'.5'])));
 const client={address:account,network:'mainnet',getUserFees:async()=>({userSpotCrossRate:'.001',feeSchedule:{spotCross:'.0015'}}),getOutcomeMeta:async()=>({outcomes:coins.map(c=>({outcome:Number(c.slice(1))/10,deployerFeeScale:1}))}),getOrderbook:async()=>({levels:[[{px:'.5',sz:'39'}],[]]}),prepareOrder:async o=>o};
 const q=await quoteBundleClose(client,s);assert.equal(q.orders.length,3);assert.equal(q.orders[0].orderType,'Market');
 assert.equal(q.feeRate,.006);assert.ok(Math.abs(q.expected-58.149)<1e-8);
 await assert.rejects(quoteBundleClose(client,{...s,remaining:s.remaining.map(l=>({...l,live:40}))}),/uniquely/);
 await assert.rejects(quoteBundleClose({...client,getOrderbook:async()=>({levels:[[],[]]})},s),/depth/);
});

test('close reconciliation blocks unknown timeout and unlocks terminal partial fill only',async()=>{
 const cloid='0x'+'a'.repeat(32),id=randomUUID();
 const request={id,created_at:at,legs:[{coin:coins[0],cloid,size:39,status:'unknown',filledSize:0}]};
 let state=null,last;
 const repo={list:()=>[request],update:(_id,s,legs)=>{state=s;last=legs}};
 const client={address:account,network:'mainnet',getOrderStatus:async()=>({status:'unknownOid'})};
 await reconcileBundleCloseRequests(client,{...repo,history:async()=>[]});assert.equal(state,'unknown');
 client.getOrderStatus=async()=>({order:{status:'canceled',order:{oid:910}}});
 await reconcileBundleCloseRequests(client,{...repo,history:async()=>[{oid:910,coin:coins[0],side:'A',tid:111,sz:'20',px:'.5',fee:'.01',feeToken:'USDC'}]});
 assert.equal(state,'reconciled');assert.equal(last[0].filledSize,20);
});

test('origin is validated from matched buy position without epoch requests',async()=>{
 const f=fixture();let calls=0;
 const client={getUserFillsByTime:async()=>{calls++;throw Error('must not scan epoch')}};
 await verifyBundleOrigin(client,evaluateBundle(f.attempt,[f.attempt],f.buys,{balances:coins.map(c=>({coin:c,total:'39',hold:'0'}))},Object.fromEntries(coins.map(c=>[c,'.5']))));
 assert.equal(calls,0);
 await assert.rejects(verifyBundleOrigin(client,{status:'unknown',ownershipCertain:false}),/unverified/);
});

test('multiple original order fills chain; missing start, gap, fee and balance loss fail closed',()=>{
 const f=fixture(),b=f.buys[0];
 const split=[{...b,sz:'20'}, {...b,tid:100,time:at+1,sz:'19',startPosition:'20'}];
 const balances={balances:coins.map(coin=>({coin,total:'39',hold:'0'}))};
 const mids=Object.fromEntries(coins.map(c=>[c,'.5']));
 const run=(replacement,bal=balances)=>evaluateBundle(f.attempt,[f.attempt],[...replacement,...f.buys.slice(1)],bal,mids);
 assert.equal(run(split).status,'active');
 assert.equal(run(split.map((x,i)=>i?{...x,startPosition:'19'}:x)).status,'unknown');
 assert.equal(run([{...b,startPosition:null}]).status,'unknown');
 assert.equal(run([{...b,fee:null}]).cost,null);
 assert.equal(run([b],{balances:coins.map((coin,i)=>({coin,total:i?'39':'0',hold:'0'}))}).status,'unknown');
 assert.equal(run([b,{...b,tid:101,time:at+3,oid:'999',startPosition:'39'}]).status,'unknown');
});

test('rejected zero-fill outcome is omitted from a partial bundle and remaining leg closes',()=>{
 const f=fixture(),attempt={...f.attempt,state:'partial',legs:f.attempt.legs.map((l,i)=>i===1?{...l,oid:null,status:'rejected',filledSize:0}:l)};
 const fills=[f.buys[0],f.buys[2],f.exits[0],f.exits[2]];
 const result=evaluateBundle(attempt,[attempt],fills,f.balances,{});
 assert.equal(result.status,'closed');assert.equal(result.remaining.length,2);
});

test('persisted fill cursor retains evidence and bounds subsequent queries',async()=>{
 initDatabase({accountAddress:account,network:'mainnet'});
 try {
  const f=fixture(),id=f.attempt.id;
  createCompleteSetAttempt({id,questionId:325,budget:40,shares:39,coins,account,network:'mainnet',ruleDigest:'a'.repeat(64),feeDigest:'b'.repeat(64),legs:f.attempt.legs});
  updateCompleteSetAttempt(id,'filled',f.attempt.legs);
  const ranges=[],client={address:account,network:'mainnet',getUserBalances:async()=>({balances:coins.map(c=>({coin:c,total:'39',hold:'0'}))}),getAllMids:async()=>Object.fromEntries(coins.map(c=>[c,'.5']))};
  const history=async(_client,start,end)=>{ranges.push([start,end]);return ranges.length===1?f.buys:[]};
  const first=await loadBundlePortfolio(client,{history});assert.equal(first[0].status,'active');
  assert.equal(getBundleFillEvidence(id).fills.length,3);
  const second=await loadBundlePortfolio(client,{history});assert.equal(second[0].status,'active');
  assert(ranges[1][0]>ranges[0][0]);
 } finally {closeDatabase();}
});

test('coverage sums active bundles and excludes closed snapshots',()=>{
 const leg={coin:coins[0],size:7};
 assert.equal(bundleCoveredCoins([{status:'active',ownershipCertain:true,remaining:[leg]},{status:'active',ownershipCertain:true,remaining:[{...leg,size:3}]},{status:'closed',ownershipCertain:true,remaining:[leg]}]).get(coins[0]),10);
});

test('standalone repurchase after verified full exits does not erase historical result',()=>{
 const f=fixture(),repurchase={...f.buys[0],tid:9000,oid:'55555',time:at+4*86400000,sz:'4',startPosition:'0'};
 const result=evaluateBundle(f.attempt,[f.attempt],[...f.buys,...f.exits,repurchase],{balances:[{coin:coins[0],total:'4',hold:'0'}]},{});
 assert.equal(result.status,'closed');assert.ok(Math.abs(result.net-.2949648)<1e-8);
});

test('active alert retries failed delivery then persists repeat/cooldown state',async()=>{
 initDatabase({accountAddress:account,network:'mainnet'});
 try {
  const f=fixture(),id=f.attempt.id;
  const load=async()=>[evaluateBundle(f.attempt,[f.attempt],f.buys,{balances:coins.map(c=>({coin:c,total:'39',hold:'0'}))},Object.fromEntries(coins.map(c=>[c,'.8'])))];
  let calls=0;
  const notify=async()=>++calls>1,client={address:account,network:'mainnet'};
  await monitorBundlePortfolio(client,notify,{load,threshold:10,repeatStep:2,cooldownMs:1000,now:()=>5000});
  assert.equal(calls,1);
  await monitorBundlePortfolio(client,notify,{load,threshold:10,repeatStep:2,cooldownMs:1000,now:()=>5000});
  assert.equal(calls,2);
  assert.equal(getBundleSnapshot(id).alert_at,5000);
  await monitorBundlePortfolio(client,notify,{load,threshold:10,repeatStep:2,cooldownMs:1000,now:()=>7000});
  assert.equal(calls,2);
 } finally {closeDatabase();}
});
