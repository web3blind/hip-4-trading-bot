import test from 'node:test';
import assert from 'node:assert/strict';
import {eventHarness} from './liquidity-event-harness.js';
import {resolveLiquidityEvent,assessLiquidityEvent,spendableSpotUsdc} from '../../src/modules/liquidity/event.js';
import {market,feeEvidence} from '../../src/modules/liquidity/engine.js';
import {createLiquidityStore} from '../../src/modules/liquidity/store.js';
import {createLiquidityService} from '../../src/modules/liquidity/engine.js';
import * as runtime from '../../src/modules/bot/runtime.js';

test('entire event resolves active named outcomes, fallback and complementary sides; malformed membership fails closed',async()=>{
 const f=eventHarness();try {
  assert.deepEqual(resolveLiquidityEvent(f.meta,f.policy.event).legs.map(l=>l.coin),['#300','#301','#310','#311','#320','#321']);
  f.meta.questions[0].settledNamedOutcomes=[29];assert.equal(resolveLiquidityEvent(f.meta,f.policy.event).legs.length,6);
  for(const mutate of [m=>m.questions[0].namedOutcomes.push(30),m=>delete m.questions[0].fallbackOutcome,m=>m.outcomes.pop(),m=>m.outcomes[2].settled=true,m=>m.questions[0].settledNamedOutcomes.push(31)]) {
   const m=structuredClone(f.meta);mutate(m);assert.throws(()=>resolveLiquidityEvent(m,f.policy.event));
   const a=await assessLiquidityEvent({...f.client,getOutcomeMeta:async()=>m},f.policy);const settled=m.outcomes.some(o=>o.settled)||m.questions[0].settledNamedOutcomes.includes(31);assert.equal(a.suitability,settled?'unsuitable':'unavailable');assert(a.reasons.some(r=>r.code===(settled?'market_unsuitable':'membership_unavailable')));assert(a.legs.some(l=>l.unavailable));
  }
  assert.throws(()=>resolveLiquidityEvent(f.meta,{type:'standalone',id:30}),/Grouped member/);
 }finally{await f.close();}
});
test('assessment uses real preparation, total-hold Spot and conservative fees; mirrored depth/edge never summed',async()=>{
 const f=eventHarness();try {
  const a=await assessLiquidityEvent(f.client,f.policy,()=>f.time);
  assert.equal(a.suitability,'conditional',JSON.stringify(a.reasons));assert.equal(a.legs.length,6);assert.equal(a.pairs.length,3);
  assert(a.minimumBudgetUsdc>60);assert(a.requiredBudgetUsdc>72);assert(a.pairs.every(p=>p.depthCountedOnce&&Math.abs(p.grossMatchedEdgePerShare-.2)<1e-9));
  assert(!JSON.stringify(a).match(/reward|campaign|payout/i));assert(a.reasons.some(r=>r.code==='imbalance_and_adverse_selection'));
  assert.equal(spendableSpotUsdc({balances:[{coin:'USDC',total:'50',hold:'20'}]}),30);
  assert.throws(()=>spendableSpotUsdc({balances:[]}),/unavailable/);
  const constrained=await assessLiquidityEvent(Object.assign(Object.create(f.client),{getUserBalances:async()=>({balances:[{coin:'USDC',total:'100',hold:'90'}]})}),f.policy,()=>f.time);
  assert.equal(constrained.suitability,'unsuitable');assert(constrained.reasons.some(r=>r.code==='insufficient_spendable_usdc'));
  const noRebate=feeEvidence({...f.fees,userSpotAddRate:'-0.01'},1);assert(noRebate>=0);
 }finally{await f.close();}
});
for(const problem of ['empty fallback','missing fee scale','missing fees','missing deadline','low price','insufficient budget','thin depth','imbalanced depth','unmerged book']) test(`whole event unsuitable, with concrete evidence: ${problem}`,async()=>{
 const f=eventHarness();try {
  if(problem==='empty fallback') f.books['#320']={time:f.time,levels:[[],[]]};
  if(problem==='missing fee scale') delete f.meta.outcomes[2].deployerFeeScale;
  if(problem==='missing fees') f.client.getUserFees=async()=>({});
  if(problem==='missing deadline') {delete f.meta.questions[0].decisionDeadline;for(const o of f.meta.outcomes)delete o.expiry;}
  if(problem==='low price') {f.policy.minPrice=.00001;f.policy.maxPrice=.99999;f.policy.minSpread=.00001;for(const [coin,b] of Object.entries(f.books)){b.levels=coin.endsWith('0')?[[{px:'0.001',sz:'100000'}],[{px:'0.002',sz:'100000'}]]:[[{px:'0.998',sz:'100000'}],[{px:'0.999',sz:'100000'}]];}}
  if(problem==='insufficient budget') f.policy.budgetUsdc=30;
  if(problem==='thin depth') f.books['#321'].levels[1][0].sz='1';
  if(problem==='imbalanced depth') f.books['#320'].levels[1][0].sz='10000';
  if(problem==='unmerged book') f.books['#321'].levels[0][0].px='0.3';
  const a=await assessLiquidityEvent(f.client,f.policy,()=>f.time);assert.equal(a.suitability,['missing fee scale','missing fees','missing deadline'].includes(problem)?'unavailable':'unsuitable');assert.equal(a.legs.length,6);
  if(problem==='low price') assert(a.legs.find(l=>l.coin==='#300').minimumShares>=10000);
  if(['empty fallback','missing fee scale'].includes(problem)) assert(a.reasons.some(r=>r.coin==='#320'));
  assert.equal(f.actions.length,0);
 }finally{await f.close();}
});
test('UTC semantic deadlines recognized; scheduled fields not substitute; malformed calendar and price model blocked',async()=>{
 const f=eventHarness();try {
  const o=f.meta.outcomes[0],q=f.meta.questions[0];delete o.expiry;delete q.decisionDeadline;
  const iso=new Date(f.time+86400000).toISOString(),stamp=iso.slice(0,10).replaceAll('-','')+'-'+iso.slice(11,16).replace(':','');
  q.description=`resolutionDeadline:${stamp}|scheduledStart:20270101-0000`;
  assert(market(f.meta,'#300',f.time,true).expiry>f.time+3600000);
  q.description=`decisionDeadline:${stamp}`;assert(market(f.meta,'#300',f.time,true).expiry>f.time+3600000);
  q.description='scheduledDecision:20270101-0000|scheduledStart:20270102-0000';assert.throws(()=>market(f.meta,'#300',f.time,true),/timing/);
  q.description='resolutionDeadline:20270230-0000';assert.throws(()=>market(f.meta,'#300',f.time,true),/timing/);
  o.description='class:priceBinary';o.expiry=f.time+86400000;assert.throws(()=>market(f.meta,'#300',f.time,true),/not supported/);
 }finally{await f.close();}
});
test('MCP → private one-use Telegram → SQLite → real HL signing covers all six legs fairly; owned cancellation only',async()=>{
 const f=eventHarness();try {
  await assert.rejects(f.mcp('liquidity_request_session',f.args(),{...f.credential,scope:'read'}),/Trade scope/);
  await assert.rejects(f.mcp('liquidity_request_session',{...f.args(),coin:'#300'},f.credential),/Invalid session/);
  const s=await f.propose();assert.equal((await f.c.get(s.id)).status,'draft');assert.equal(f.actions.length,0);
  const text=f.messages.map(m=>m.text).join('\n');assert.match(text,/Championship/);assert.match(text,/Fallback/);assert.match(text,/YES/);assert.match(text,/NO/);assert.match(text,/conditional/i);assert(!/reward|campaign|payout/i.test(text));
  const callback=f.messages.at(-1).extra.reply_markup.inline_keyboard.flat().find(b=>b.callback_data.startsWith('confirm_liquidity_session:')).callback_data;
  assert.equal(runtime.consumeConfirmation(f.owner,callback),'confirm_liquidity_session');await f.ui.confirm(f.ctx);await f.ui.confirm(f.ctx);
  assert.equal((await f.c.get(s.id)).status,'active');assert.equal(f.actions.length,0);
  for(let i=0;i<6;i++) await f.c.tick();
  assert.deepEqual((await f.c.get(s.id)).orders.map(o=>o.coin),['#300','#301','#310','#311','#320','#321']);
  assert.equal(new Set((await f.c.get(s.id)).orders.map(o=>o.cloid)).size,6);assert.equal(f.actions.filter(a=>a.type==='order').length,6);
  await f.c.tick();assert.equal(f.actions.filter(a=>a.type==='order').length,6);
  f.orders.set(999,{status:'open',order:{oid:999,coin:'#300',side:'B',cloid:'0x'+'f'.repeat(32)}});
  await f.ui.stop(f.ctx,s.id);assert.equal((await f.c.get(s.id)).status,'stopped');assert.equal(f.orders.get(999).status,'open');
  assert.equal(f.actions.filter(a=>a.type==='cancel').length,6);await f.c.tick();assert.equal(f.actions.length,12);
 }finally{await f.close();}
});
test('completed session buys can sell only their own shares, and sales never recycle spend caps',async()=>{
 const f=eventHarness();try {
  const s=await f.propose();await f.approve(s.id);for(let i=0;i<6;i++) await f.c.tick();
  for(const id of [...f.orders.keys()]) f.fill(id);
  for(let i=0;i<6;i++) await f.c.tick();assert.equal(f.actions.filter(a=>a.type==='order').length,12);
  assert([...f.orders.values()].filter(o=>o.order.side==='A').every(o=>o.order.size===30));
  for(const [id,o] of f.orders) if(o.order.side==='A')f.fill(id);
  for(let i=0;i<12;i++) await f.c.tick();
  const end=await f.c.get(s.id);assert(end.exposure.spend<=100);assert.equal(end.exposure.shares,0);assert.equal(f.actions.filter(a=>a.type==='order').length,12); // action ceiling
 }finally{await f.close();}
});
for(const problem of ['metadata','unknown','rejection','partial','outside inventory','foreign target order','credential']) test(`one leg ${problem} freezes entire event and leaves safe owned cleanup`,async()=>{
 const f=eventHarness();try {
  const s=await f.propose();await f.approve(s.id);await f.c.tick();
  if(problem==='metadata') f.meta.outcomes[1].description='metadata change';
  if(problem==='unknown') f.exchangeMode='unknown';
  if(problem==='rejection') f.exchangeMode='rejected';
  if(problem==='partial') f.fill([...f.orders.keys()][0],10);
  if(problem==='outside inventory') f.holdings.set('#321',1);
  if(problem==='foreign target order')f.orders.set(999,{status:'open',order:{oid:999,coin:'#321',side:'B',cloid:'0x'+'f'.repeat(32)}});
  if(problem==='credential') f.valid=false;
  await f.c.tick();const writes=f.actions.filter(a=>a.type==='order').length;await f.c.tick();
  const end=await f.c.get(s.id);assert.notEqual(end.status,'active');assert.equal(f.actions.filter(a=>a.type==='order').length,writes);
  if(problem==='unknown')assert(end.orders.some(o=>o.state==='unknown'));
  if(problem==='partial')assert.equal(end.exposure.shares,10);
  if(problem==='foreign target order')assert.equal(f.orders.get(999).status,'open');
 }finally{await f.close();}
});
for(const trigger of ['stop','duration','credential','metadata','loss']) test(`financial preparation/signing yield rechecks event ${trigger} before transmission`,async()=>{
 const f=eventHarness();try {
  if(trigger==='loss')f.policy.maxLossUsdc=1;
  const s=await f.propose();await f.approve(s.id);
  if(trigger==='loss') {await f.c.tick();f.fill([...f.orders.keys()][0]);}
  const original=f.client.wallet._signTypedData.bind(f.client.wallet);let entered=false;
  f.client.wallet._signTypedData=async(...args)=>{
   const sig=await original(...args);if(!entered){entered=true;
    if(trigger==='stop')await f.c.stop(s.id,{ownerId:f.owner});
    if(trigger==='duration')f.time+=31*60000;
    if(trigger==='credential')f.valid=false;
    if(trigger==='metadata')f.meta.questions[0].name='Changed';
    if(trigger==='loss'){for(const b of Object.values(f.books)){b.time=f.time;b.levels[0][0].px='.2';b.levels[1][0].px='.8';}}
   }return sig;
  };
  const before=f.actions.filter(a=>a.type==='order').length;await f.c.tick();assert(entered);assert.equal(f.actions.filter(a=>a.type==='order').length,before);
 }finally{await f.close();}
});
test('real SQLite reopen never resumes event quoting; all original owned legs reconciled and cancelled',async()=>{
 const f=eventHarness();let store;try {
  const s=await f.propose();await f.approve(s.id);for(let i=0;i<3;i++)await f.c.tick();
  store=createLiquidityStore({dataDir:f.dir,account:f.client.address,network:'testnet'});
  const recovery=createLiquidityService({store,ownerId:String(f.owner),now:()=>f.time});await recovery.recover(f.client);
  const end=recovery.get(s.id);assert.equal(end.status,'stopped');assert.equal(end.orders.filter(o=>o.state==='closed'&&o.cancelExpected).length,3);assert.equal(f.actions.filter(a=>a.type==='order').length,3);
  await recovery.tick(f.client);assert.equal(f.actions.filter(a=>a.type==='order').length,3);
 }finally{store?.close();await f.close();}
});
