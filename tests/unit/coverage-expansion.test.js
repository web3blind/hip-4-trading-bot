import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {completeSetQuestions,quoteCompleteSet} from '../../src/modules/complete-set.js';
import {getCompleteSetFeeEvidence} from '../../src/modules/complete-set-fees.js';
import {reconcileCompleteSetAttempts} from '../../src/modules/complete-set-monitor.js';
import {createCompleteSetWatcher} from '../../src/modules/complete-set-watcher.js';
import {createCompleteSetFeature} from '../../src/modules/bot/features/complete-set.js';
import {HLClient} from '../../src/modules/hyperliquid.js';
import * as db from '../../src/modules/database.js';
import * as runtime from '../../src/modules/bot/runtime.js';
import {setSessionConfig} from '../../src/modules/config.js';
import {account,fees} from '../fixtures/complete-set.js';
const recorded=JSON.parse(readFileSync(new URL('../fixtures/coverage-markets.json',import.meta.url)));
const now=Date.parse('2026-09-29T04:45:00Z');
const discover=(m=recorded,t=m.templates,time=now)=>completeSetQuestions(m,t,time);

test('recorded FOMC questions use decisionDeadline and proven three-way rules; MLB retains ninth fallback',()=>{
 const found=discover();
 for(const id of [289,331]) {
  const q=found.find(q=>q.question===id);assert(q);
  assert.equal(q.coverage,'named_exhaustive');assert.deepEqual(q.coveredIds,q.namedOutcomes);
 }
 const mlb=found.find(q=>q.question===250);assert(mlb);assert.equal(mlb.coverage,'with_fallback');
 assert.equal(mlb.outcomes.length,9);assert(mlb.coveredIds.includes(mlb.fallbackOutcome));
 const afterDecision=discover(recorded,recorded.templates,Date.parse('2026-10-29T00:00:00Z'));
 assert(afterDecision.some(q=>q.question===289));
 assert(!discover(recorded,recorded.templates,Date.parse('2026-12-09T23:00:00Z')).some(q=>q.question===289));
});

test('FOMC proof fails closed to including fallback when parent or child semantics/shape change',()=>{
 for(const id of ['policyRateDecision','policyRateNoChange','policyRateDecrease','policyRateIncrease']) {
  const m=structuredClone(recorded);m.templates.find(t=>t.id===id).description+=' Except when all outcomes resolve to No.';
  const q=discover(m).find(q=>q.question===289);assert(q);assert.equal(q.coverage,'with_fallback');assert.equal(q.outcomes.length,4);
 }
 for(const mutate of [
  m=>{m.templates.find(t=>t.id==='policyRateDecrease').role.questionOutcome.parent='other';},
  m=>{m.outcomes.find(o=>o.outcome===3601).description='unexpected:value';},
  m=>{m.outcomes.find(o=>o.outcome===3601).name='template:policyRateNoChange';},
  m=>{m.questions.find(q=>q.question===289).description+='|extra:unknown';},
 ]) {const m=structuredClone(recorded);mutate(m);assert.equal(discover(m).find(q=>q.question===289).coverage,'with_fallback');}
 const missing=structuredClone(recorded);missing.outcomes=missing.outcomes.filter(o=>o.outcome!==3599);
 assert(!discover(missing).some(q=>q.question===289));
});

test('nine-leg expansion requires reviewed tournament parent, child and fallback semantics',()=>{
 for(const id of ['sportsTournamentWinner','sportsTournamentParticipant']) {
  const m=structuredClone(recorded);m.templates.find(t=>t.id===id).description+=' Except when every outcome resolves to No.';
  assert(!discover(m).some(q=>q.question===250));
 }
 for(const mutate of [
  m=>{m.templates.find(t=>t.id==='sportsTournamentParticipant').role.questionOutcome.parent='other';},
  m=>{m.outcomes.find(o=>o.outcome===2550).description='participant:Los Angeles Dodgers|extra:value';},
  m=>{m.outcomes.find(o=>o.outcome===2550).description=m.outcomes.find(o=>o.outcome===2551).description;},
  m=>{m.outcomes.find(o=>o.outcome===2549).name='unknown fallback';},
  m=>{m.questions.find(q=>q.question===250).name='template:unknown';},
 ]) {const m=structuredClone(recorded);mutate(m);assert(!discover(m).some(q=>q.question===250));}
 const future=structuredClone(recorded);future.questions.find(q=>q.question===250).question=99999;
 future.outcomes.find(o=>o.outcome===2550).description='participant:Another Team';
 assert.equal(discover(future).find(q=>q.question===99999).outcomes.length,9);
});

test('dynamic IDs, expired/malformed deadlines, settled outcomes and ten-leg bound remain guarded',()=>{
 const m=structuredClone(recorded);const q=m.questions.find(q=>q.question===289);q.question=98765;
 assert(discover(m).some(q=>q.question===98765));
 for(const description of ['decisionDeadline:broken','decisionDeadline:20000101-0000','decisionDeadline:20260230-0000']) {
  const x=structuredClone(recorded);x.questions.find(q=>q.question===289).description=description;
  assert(!discover(x).some(q=>q.question===289));
 }
 for(const change of [{settledNamedOutcomes:[2550]},{settledFallbackOutcome:2549}]) {
  const x=structuredClone(recorded);Object.assign(x.questions.find(q=>q.question===250),change);assert(!discover(x).some(q=>q.question===250));
 }
 const extra=structuredClone(recorded),mlb=extra.questions.find(q=>q.question===250);
 mlb.namedOutcomes.push(9999);extra.outcomes.push({...extra.outcomes.find(o=>o.outcome===2550),outcome:9999});
 assert(!discover(extra).some(q=>q.question===250));
});

// Execution scenarios explicitly provide fee metadata absent on recorded legacy markets.
// The untouched recorded snapshot is separately tested to remain blocked on missing fees.
function executableMetadata() {
 const m=structuredClone(recorded);
 for(const o of m.outcomes) if(o.deployerFeeScale===undefined) o.deployerFeeScale='1.0';
 return m;
}
function clientFor(id){
 const original=recorded.questions.find(q=>q.question===id),ids=id===250?[...original.namedOutcomes,original.fallbackOutcome]:original.namedOutcomes;
 const px=id===250?'.10':'.30';const submitted=[];
 const client={network:'mainnet',address:account,getOutcomeMeta:async()=>executableMetadata(),getOutcomeTemplates:async()=>recorded.templates,
  getUserFees:async()=>fees,getAvailableUsdc:async()=>500,getUserBalances:async()=>({balances:[]}),
  getOrderbook:async coin=>({levels:[[],ids.some(id=>coin===`#${id}0`)?[{px,sz:'500'}]:[]]}),
  _getSzDecimals:async()=>0,_resolveSpotAssetIndex:async coin=>100_000_000+Number(coin.slice(1)),
  prepareOrder:HLClient.prototype.prepareOrder,
  placeOrders:async orders=>{submitted.push(orders);const pending=db.getCompleteSetAttempts(['submitting']);
   assert.equal(pending.length,1);assert.equal(pending[0].legs.length,ids.length);
   return {status:'ok',response:{type:'order',data:{statuses:orders.map((o,i)=>({filled:{oid:100+i,totalSz:o.size,avgPx:o.price}}))}}};}
 };
 Object.setPrototypeOf(client,HLClient.prototype);
 return {client,submitted,ids};
}

test('nine-leg quotes require every book, per-leg minimum, fees and sufficient total budget',async()=>{
 const q=discover(executableMetadata()).find(q=>q.question===250);assert(q);const {client}=clientFor(250);
 const feeEvidence=await getCompleteSetFeeEvidence(client,q,now);
 const opts={now,feeEvidence};
 const quote=await quoteCompleteSet(client,q,100,opts);assert(quote);assert.equal(quote.orders.length,9);
 assert(quote.orders.every(o=>o.size===quote.shares && o.price*o.size>=10));assert(quote.maxSpend<=100);assert(quote.netLowerBound>0);
 assert.equal(await quoteCompleteSet(client,q,89,opts),null);
 assert.equal(await quoteCompleteSet(client,q,100,{now}),null);
 const getBook=client.getOrderbook;client.getOrderbook=coin=>coin===`#${q.fallbackOutcome}0`?{levels:[[],[]]}:getBook(coin);
 await assert.rejects(quoteCompleteSet(client,q,100,opts),/order book/);
 const ten={...q,outcomes:[...q.outcomes,q.outcomes[0]],coveredIds:[...q.coveredIds,q.coveredIds[0]]};
 assert.equal(await quoteCompleteSet(client,ten,500,opts),null);
});

test('recorded missing fee scales block quotes and watcher alerts without invented defaults',async()=>{
 for(const id of [250,331]) {
  const {client,submitted}=clientFor(id);client.getOutcomeMeta=async()=>({...recorded,questions:recorded.questions.filter(q=>q.question===id)});
  const q=discover().find(q=>q.question===id);assert(q);
  assert.equal(await getCompleteSetFeeEvidence(client,q,now),null);
  let alerts=0;const scan=createCompleteSetWatcher({now:()=>now,pending:()=>new Set(),onAlert:async()=>{alerts++;return true;}});
  assert.equal(await scan(client,{enabled:true,budget:100}),0);assert.equal(alerts,0);assert.equal(submitted.length,0);
 }
});

test('watcher discovers newly supported FOMC and MLB and alerts without exchange writes',async()=>{
 for(const id of [250,289,331]) {
  const {client,submitted}=clientFor(id);client.getOutcomeMeta=async()=>({...executableMetadata(),questions:recorded.questions.filter(q=>q.question===id)});
  const seen=[];const scan=createCompleteSetWatcher({now:()=>now,pending:()=>new Set(),
   alerts:{get:()=>({last_alert_at:0,miss_count:0,active:0}),put:()=>{}},onAlert:async(q,quote)=>{seen.push([q,quote]);return true;}});
  assert.equal(await scan(client,{enabled:true,budget:100}),1);assert.equal(seen[0][0].question,id);assert.equal(submitted.length,0);
 }
});

for(const id of [250,289]) test(`connected ${id}: menu, low budget, confirmation, real scoped SQLite and reconciliation`,async()=>{
 db.initDatabase({network:'mainnet',accountAddress:account});setSessionConfig({language:'en',hlNetwork:'mainnet',notifications:{}});
 const {client,submitted,ids}=clientFor(id);runtime.setHLClient(client);
 const messages=[],ctx={chat:{id},editMessageText:async(text,opts)=>messages.push({text,opts}),reply:async(text,opts)=>messages.push({text,opts})};
 const feature=createCompleteSetFeature({client,now:()=>now});
 try {
  await feature.open(ctx,String(id));assert.equal(runtime.userStates.get(id)?.state,'AWAITING_SET_AMOUNT');
  await feature.inputAmount(ctx,runtime.userStates.get(id),'20');assert.equal(runtime.userStates.get(id).state,'AWAITING_SET_AMOUNT');assert.equal(submitted.length,0);
  await feature.inputAmount(ctx,runtime.userStates.get(id),'100');assert.equal(runtime.userStates.get(id).state,'CONFIRMING_SET_BUY');
  assert.equal(submitted.length,0);const callback=messages.at(-1).opts.reply_markup.inline_keyboard[0][0].callback_data;
  assert.equal(runtime.consumeConfirmation(id,callback),'confirm_set_buy');await feature.confirm(ctx);
  assert.equal(submitted.length,1);assert.equal(submitted[0].length,ids.length);assert.equal(runtime.consumeConfirmation(id,callback),null);
  const row=db.getCompleteSetAttempts(['filled']).find(x=>x.question_id===id);assert(row);assert.equal(row.legs.length,ids.length);
  db.closeDatabase();db.initDatabase({network:'mainnet',accountAddress:account});
  assert.equal(db.getCompleteSetAttempts(['filled']).find(x=>x.id===row.id).legs.length,ids.length);
  db.updateCompleteSetAttempt(row.id,'submitted_unknown',row.legs.map(l=>({...l,status:'unknown',filledSize:null})));
  client.getUserFills=async()=>row.legs.map((l,i)=>({oid:l.oid,tid:i+1,sz:String(l.size),px:String(l.price),fee:'0',feeToken:'USDC'}));
  client.getOrderStatus=async cloid=>({order:{status:'filled',order:{oid:row.legs.find(l=>l.cloid===cloid).oid}}});
  const notices=[];assert.equal(await reconcileCompleteSetAttempts(client,async x=>{notices.push(x);return true;}),1);
  assert(notices.some(x=>x.id===row.id && x.state==='filled' && x.legs.length===ids.length));
  assert.equal(db.getCompleteSetAttempts(['filled']).find(x=>x.id===row.id).notified_state,'filled');
  const tenLegs=Array.from({length:10},(_,i)=>({coin:`#${i+9000}0`,cloid:`0x${i.toString(16).padStart(32,'0')}`,size:100,price:.1}));
  assert.throws(()=>db.createCompleteSetAttempt({id:randomUUID(),questionId:999,budget:200,shares:100,coins:tenLegs.map(l=>l.coin),legs:tenLegs,account,network:'mainnet',ruleDigest:'a'.repeat(64),feeDigest:'b'.repeat(64)}),/Invalid complete set/);
 }finally{db.closeDatabase();runtime.userStates.delete(id);runtime.setHLClient(null);setSessionConfig(null);}
});
