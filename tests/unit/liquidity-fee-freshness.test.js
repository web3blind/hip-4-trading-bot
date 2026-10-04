import test from 'node:test';
import assert from 'node:assert/strict';
import {eventHarness} from './liquidity-event-harness.js';
import {liquidityCatalogue} from '../../src/modules/liquidity/catalog.js';
import {createLiquidityFeature} from '../../src/modules/bot/features/liquidity.js';
import {HLClient} from '../../src/modules/hyperliquid.js';
import {getTranslator} from '../../src/modules/i18n.js';
import * as runtime from '../../src/modules/bot/runtime.js';
test('selected fee validity survives only through the last awaited prompt translation',async()=>{
 const f=eventHarness({standalone:true}),clone=globalThis.structuredClone;try{
  let time=f.time,armed=false;
  const ui=createLiquidityFeature({now:()=>time});
  await ui.start(f.ctx,'live');const pick=buttons(f).find(b=>b.text==='Runner 30');assert(pick);
  f.client.getUserFees=async()=>{armed=true;return f.fees;};
  globalThis.structuredClone=value=>{
   if(armed&&value?.language){armed=false;time+=6000;}
   return clone(value);
  };
  await ui.choose(f.ctx,pick.callback_data);
  assert.notEqual(runtime.userStates.get(f.owner)?.state,'LIQUIDITY_INPUT');
  const t=await getTranslator('en');assert(f.messages.at(-1).text.includes(t('liq_catalog_terminal_unknown')));assert(!buttons(f).some(b=>b.text===t('liq_retry')));assert.equal(f.actions.length,0);
 }finally{globalThis.structuredClone=clone;await f.close();}
});
const buttons=f=>f.messages.at(-1).extra.reply_markup.inline_keyboard.flat();
test('6000ms fee evidence with unavailable bounded refresh is UNKNOWN not verified weak',async()=>{
 const f=eventHarness({standalone:true});try{
  let time=f.time,calls=0;
  f.client.getUserFees=async()=>{if(++calls===2)throw Error('private');return f.fees;};
  f.client.getOrderbook=async coin=>{time=f.time+6000;return {...structuredClone(f.books[coin]),time};};
  await assert.rejects(liquidityCatalogue(f.client,{now:()=>time}),e=>e.code==='catalogue_unknown'&&e.stage==='fees');
  assert.equal(calls,2);
 }finally{await f.close();}
});
test('fees expiring during final awaited rounding cannot publish even newer books',async()=>{
 const f=eventHarness({standalone:true}),prepare=HLClient.prototype.prepareMakerOrder;try{
  let time=f.time,preparations=0,fees=0;
  f.client.getUserFees=async()=>{fees++;return f.fees;};
  f.client.getOrderbook=async coin=>({...structuredClone(f.books[coin]),time:f.time+1000});
  HLClient.prototype.prepareMakerOrder=async function(...args){
   const result=await prepare.apply(this,args);
   if(++preparations===8)time=f.time+6000;
   return result;
  };
  await assert.rejects(liquidityCatalogue(f.client,{now:()=>time}),e=>e.code==='catalogue_unknown'&&e.stage==='publication');
  assert.equal(fees,1,'No fee retry loop after final evaluation');
 }finally{HLClient.prototype.prepareMakerOrder=prepare;await f.close();}
});
for(const phase of ['initial','final'])for(const navigation of ['cancel','back'])for(const late of ['success','failure'])test(`${navigation} aborts ${phase} fee transport; late ${late} cannot restore pick`,{timeout:10000},async()=>{
 const f=eventHarness({standalone:true}),fetch=globalThis.fetch;let release,pending;try{
  let time=f.time;
  const ui=createLiquidityFeature({now:()=>time});await ui.start(f.ctx,'live');
  const visible=buttons(f),pick=visible.find(b=>b.text==='Runner 30'),t=await getTranslator('en');
  const nav=visible.find(b=>b.text===t(navigation)).callback_data;
  let entered,calls=0,aborted=0;
  const reached=new Promise(r=>entered=r),held=new Promise(r=>release=r);
  f.client.getOrderbook=async coin=>{if(phase==='final')time=f.time+6000;return {...structuredClone(f.books[coin]),time};};
  f.client.getUserFees=HLClient.prototype.getUserFees.bind(f.client);
  f.client._infoRequest=HLClient.prototype._infoRequest.bind(f.client);
  globalThis.fetch=async(url,{body,signal})=>{
   assert.equal(JSON.parse(body).type,'userFees');calls++;
   if(phase==='final'&&calls===1)return {ok:true,json:async()=>structuredClone(f.fees)};
   entered();return new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>{aborted++;reject(Error('Aborted'));},{once:true});
    held.then(()=>late==='failure'?reject(Error('PRIVATE_LATE_FAILURE')):resolve({ok:true,json:async()=>structuredClone(f.fees)}));
   });
  };
  pending=ui.choose(f.ctx,pick.callback_data);
  let timer;try{await Promise.race([reached,pending.then(()=>{throw Error('Ended before transport');}),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Entry timeout')),5000))]);}finally{clearTimeout(timer);}
  await ui.choose(f.ctx,nav);const count=f.messages.length;await pending;
  assert.equal(aborted,1);assert.equal(calls,phase==='final'?2:1);
  release();await new Promise(r=>setImmediate(r));
  assert.equal(f.messages.length,count);assert.equal(runtime.userStates.has(f.owner),false);
  assert.equal(f.actions.length,0);assert.equal((await f.c.list()).length,0);
 }finally{release?.();await pending;globalThis.fetch=fetch;await f.close();}
});
for(const age of [5000,6000])test(`fee observation ${age}ms old: inclusive boundary or bounded refresh`,async()=>{
 const f=eventHarness({standalone:true});try{
  let time=f.time,calls=0;
  f.client.getUserFees=async()=>{calls++;return structuredClone(f.fees);};
  f.client.getOrderbook=async coin=>{time=f.time+age;return {...structuredClone(f.books[coin]),time};};
  const result=await liquidityCatalogue(f.client,{now:()=>time});
  assert.equal(result.length,1);assert.equal(calls,age===5000?1:2);
  assert.equal(result.validUntil,f.time+(age===5000?5000:11000));
 }finally{await f.close();}
});
test('expired initial fees cannot publish narrow-spread event after authoritative fee increase',async()=>{
 const f=eventHarness({standalone:true});try{
  let time=f.time,calls=0;
  f.client.getUserFees=async()=>{calls++;return {...structuredClone(f.fees),userSpotCrossRate:calls===1?'0.001':'0.002'};};
  f.client.getOrderbook=async()=>{time=f.time+6000;return {time,levels:[[{px:'0.497',sz:'1000000'}],[{px:'0.503',sz:'1000000'}]]};};
  const result=await liquidityCatalogue(f.client,{now:()=>time});
  assert.equal(result.length,0);assert.equal(calls,2);assert.equal(result.summary.weak,1);
 }finally{await f.close();}
});
test('24-second catalogue keeps early book-strong candidate even when initial fees would reject',async()=>{
 const f=eventHarness({standalone:true});try{
  f.meta.outcomes=Array.from({length:72},(_,i)=>({...f.meta.outcomes[0],outcome:30+i}));
  let time=f.time,calls=0,reads=new Map();
  f.client.getUserFees=async options=>{assert(options.signal instanceof AbortSignal);calls++;return {...structuredClone(f.fees),userSpotCrossRate:calls===1?'0.002':'0.001'};};
  f.client.getOrderbook=async coin=>{
   reads.set(coin,(reads.get(coin)||0)+1);await new Promise(r=>setImmediate(r));
   time+=Math.floor(24000/144);
   return {time,levels:[[{px:'0.497',sz:'1000000'}],[{px:'0.503',sz:'1000000'}]]};
  };
  const result=await liquidityCatalogue(f.client,{now:()=>time});
  assert(result.some(e=>e.outcomeId===30));assert.equal(calls,2);
  assert.equal([...reads.values()].reduce((a,b)=>a+b,0),144+24);
  assert([...reads.values()].every(n=>n<=2));assert(time<=result.validUntil);
  assert.equal(result.summary.total,72);assert.equal(result.summary.total,result.summary.qualified+result.summary.weak+result.summary.unknown);
 }finally{await f.close();}
});
test('selected reads ageing fees and increasing current rate never enter monetary inputs',async()=>{
 const f=eventHarness({standalone:true});try{
  let time=f.time,calls=0;
  const ui=createLiquidityFeature({now:()=>time});
  for(const b of Object.values(f.books))b.levels=[[{px:'0.497',sz:'1000000'}],[{px:'0.503',sz:'1000000'}]];
  await ui.start(f.ctx,'live');const pick=buttons(f).find(b=>b.text==='Runner 30');assert(pick);
  f.client.getUserFees=async()=>{calls++;return {...structuredClone(f.fees),userSpotCrossRate:calls===1?'0.001':'0.002'};};
  f.client.getOrderbook=async coin=>{time=f.time+6000;return {...structuredClone(f.books[coin]),time};};
  await ui.choose(f.ctx,pick.callback_data);
  assert.notEqual(runtime.userStates.get(f.owner)?.state,'LIQUIDITY_INPUT');assert.equal(calls,2);
  assert.equal(f.actions.length,0);assert.equal((await f.c.list()).length,0);
 }finally{await f.close();}
});
