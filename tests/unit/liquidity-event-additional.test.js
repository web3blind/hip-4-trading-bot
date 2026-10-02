import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {eventHarness} from './liquidity-event-harness.js';
import {assessLiquidityEvent,resolveLiquidityEvent} from '../../src/modules/liquidity/event.js';
import {market} from '../../src/modules/liquidity/market.js';
import {createLiquidityStore} from '../../src/modules/liquidity/store.js';
import {createLiquidityService} from '../../src/modules/liquidity/engine.js';

for(const change of ['foreign order','outside cancel','partial fill'])test(`final real signing gate blocks new transmission after ${change} on another event side`,async()=>{
 const f=eventHarness();try{
  const s=await f.propose();await f.approve(s.id);await f.c.tick();
  const first=[...f.orders.keys()][0],sign=f.client.wallet._signTypedData.bind(f.client.wallet);let changed=false;
  f.client.wallet._signTypedData=async(...args)=>{const signature=await sign(...args);if(!changed){changed=true;
   if(change==='foreign order')f.orders.set(999,{status:'open',order:{oid:999,coin:'#321',side:'B',cloid:'0x'+'f'.repeat(32)},remaining:1,px:.4});
   if(change==='outside cancel')f.orders.get(first).status='canceled';
   if(change==='partial fill')f.fill(first,10);
  }return signature;};
  await f.c.tick();assert(changed);assert.equal(f.actions.filter(a=>a.type==='order').length,1);
  const end=await f.c.get(s.id);assert.notEqual(end.status,'active');assert.equal(end.orders.at(-1).state,'aborted');
  assert(![...f.orders.values()].some(o=>o.order.oid!==999&&o.status==='open'));
  assert(f.actions.filter(a=>a.type==='cancel').flatMap(a=>a.cancels).every(c=>c.o===first));
  if(change==='foreign order')assert.equal(f.orders.get(999).status,'open');
  await f.c.tick();assert.equal(f.actions.filter(a=>a.type==='order').length,1);
 }finally{await f.close();}
});
for(const stage of ['preparation','post-sign'])test(`shared Spot covers every existing unheld buffer at ${stage}`,async()=>{
 const f=eventHarness();try{
  const s=await f.propose();await f.approve(s.id);for(let i=0;i<5;i++)await f.c.tick();
  if(stage==='preparation')f.setSpot(72.2);
  else{const sign=f.client.wallet._signTypedData.bind(f.client.wallet);let changed=false;f.client.wallet._signTypedData=async(...args)=>{const result=await sign(...args);if(!changed){changed=true;f.setSpot(72.2);}return result;};}
  await f.c.tick();await f.c.tick();assert.equal(f.actions.filter(a=>a.type==='order').length,5);
  assert.notEqual((await f.c.get(s.id)).status,'active');
  assert(![...f.orders.values()].some(o=>o.status==='open'));
 }finally{await f.close();}
});
test('shared Spot held notional is not charged twice when all six fee-buffered legs fit',async()=>{
 const f=eventHarness();try{
  const s=await f.propose();await f.approve(s.id);f.setSpot(73);
  for(let i=0;i<7;i++)await f.c.tick();
  const end=await f.c.get(s.id);assert.equal(end.status,'active');assert.equal(f.actions.filter(a=>a.type==='order').length,6);
  assert(end.exposure.reservations<=73);assert.equal(f.actions.filter(a=>a.type==='cancel').length,0);
 }finally{await f.close();}
});

for(const kind of ['existing inventory','foreign orders','Spot hold'])test(`pre-launch ${kind} is unsuitable, not an approval-time surprise`,async()=>{
 const f=eventHarness();try{
  if(kind==='existing inventory')f.holdings.set('#320',1);
  if(kind==='foreign orders')f.orders.set(999,{status:'open',order:{oid:999,coin:'#320',side:'B'},remaining:1,px:.4});
  if(kind==='Spot hold')f.client.getUserBalances=async()=>({balances:[{coin:'USDC',total:'100',hold:'99'}]});
  const s=await f.propose();assert.equal(s.assessment.suitability,'unsuitable');
  assert(!f.messages.at(-1).extra.reply_markup.inline_keyboard.flat().some(b=>b.callback_data.startsWith('confirm_liquidity')));
  await assert.rejects(f.c.approve(s.id,{ownerId:f.owner}));assert.equal(f.actions.length,0);
 }finally{await f.close();}
});

test('actual public Q289 metadata and all eight captured books preserve empty O3599 fallback as unsuitable',async()=>{
 const f=eventHarness();try{
  const a=JSON.parse(readFileSync(new URL('./fixtures/liquidity-public-meta.json',import.meta.url)));
  const time=Math.min(...Object.values(a.books).map(b=>b.time));
  const resolved=resolveLiquidityEvent(a.meta,{type:'question',id:289});assert.equal(resolved.legs.length,8);
  assert(resolved.legs.filter(l=>l.fallback).every(l=>l.outcomeId===3599));
  const q=market(a.meta,'#35990',time,true);assert(q.timing.decisionDeadline);assert.equal(q.timing.resolutionDeadline,null);
  const assessment=await assessLiquidityEvent(Object.assign(Object.create(f.client),{getOutcomeMeta:async()=>a.meta,getOrderbook:async coin=>({...a.books[coin],time})}),{...f.policy,event:{type:'question',id:289}},()=>time);
  assert.equal(assessment.suitability,'unsuitable');
  assert(assessment.legs.filter(l=>l.fallback).every(l=>l.unavailable));
  assert(assessment.reasons.some(r=>r.coin==='#35990'&&r.code==='no_two_sided_book'));
  assert(!JSON.stringify(assessment).match(/reward|campaign|payout/i));
 }finally{await f.close();}
});

test('legacy persisted single-coin order recovers/cancels; public coordinator cannot create or approve another',async()=>{
 const f=eventHarness({standalone:true});let store;try{
  store=createLiquidityStore({dataDir:f.dir,account:f.client.address,network:'testnet'});
  const service=createLiquidityService({store,ownerId:String(f.owner),now:()=>f.time});
  const p={...f.policy,coin:'#300'};delete p.event;
  f.client.getAvailableUsdc=async()=>100;
  const s=service.propose(p,{requestId:'legacy_request_001'});await service.approve(s.id,{ownerId:String(f.owner),client:f.client});await service.tick(f.client);
  assert.equal(f.actions.filter(a=>a.type==='order').length,1);
  await f.c.tick();assert.equal((await f.c.get(s.id)).status,'stopped');
  assert.equal(f.actions.filter(a=>a.type==='cancel').length,1);
  await assert.rejects(f.c.propose(p,{requestId:'new_legacy_request'}),/Event selection/);
  const draft=service.propose(p,{requestId:'legacy_draft_001'});
  await assert.rejects(f.c.approve(draft.id,{ownerId:f.owner}),/Legacy/);
  await f.ui.session(f.ctx,draft.id);assert(!f.messages.at(-1).extra.reply_markup.inline_keyboard.flat().some(b=>b.callback_data.startsWith('liq:review:')));
 }finally{store?.close();await f.close();}
});

test('long event reviews deliver all side composition in Telegram-sized chunks before exposing approval',async()=>{
 const f=eventHarness();try{
  const example={...f.meta.outcomes[0]};const ids=Array.from({length:20},(_,i)=>100+i);
  f.meta.outcomes=[...ids.map(outcome=>({...example,outcome,name:`Readable contender ${outcome}`})),f.meta.outcomes.find(o=>o.outcome===32)];f.meta.questions[0].namedOutcomes=ids;
  const s=await f.propose({budgetUsdc:1000,maxInventoryShares:5000,maxActions:60});
  // Insufficient available capital deliberately blocks approval, but all legs still need visible review.
  const text=f.messages.map(m=>m.text).join('\n');for(const id of [...ids,32])for(const side of [0,1])assert(text.includes('#'+(id*10+side)));
  assert(f.messages.length>1);assert(f.messages.every(m=>m.text.length<=4096));assert.equal(s.assessment.legs.length,42);assert.equal(f.actions.length,0);
 }finally{await f.close();}
});

test('durable Stop in the post-validation microtask gap is checked synchronously before exchange dispatch',async()=>{
 const f=eventHarness();let store;try{
  const s=await f.propose();await f.approve(s.id);store=createLiquidityStore({dataDir:f.dir,account:f.client.address,network:'testnet'});
  const place=f.client.placeMakerOrders.bind(f.client);let calls=0;
  f.client.placeMakerOrders=(requests,options)=>place(requests,{...options,beforeSubmit:async()=>{await options.beforeSubmit();if(++calls===2)queueMicrotask(()=>store.requestStop(s.id,'owner_stop'));}});
  await f.c.tick();assert.equal(f.actions.length,0);assert.equal((await f.c.get(s.id)).orders[0].state,'aborted');assert.equal((await f.c.get(s.id)).status,'stopped');
 }finally{store?.close();await f.close();}
});

test('cancel signing binding change suppresses financial transmission and leaves original orders unresolved until safe retry',async()=>{
 const f=eventHarness();try{
  const s=await f.propose();await f.approve(s.id);await f.c.tick();
  const sign=f.client.wallet._signTypedData.bind(f.client.wallet);let changed=false;
  f.client.wallet._signTypedData=async(...args)=>{const result=await sign(...args);if(!changed){changed=true;f.client.network='mainnet';}return result;};
  await f.c.stop(s.id,{ownerId:f.owner});assert.equal(f.actions.filter(a=>a.type==='cancel').length,0);
  f.client.network='testnet';f.client.wallet._signTypedData=sign;
  await f.c.tick();assert.equal((await f.c.get(s.id)).status,'stopped');assert.equal(f.actions.filter(a=>a.type==='order').length,1);
 }finally{f.client.network='testnet';await f.close();}
});
