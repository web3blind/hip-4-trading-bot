import assert from 'node:assert/strict';
import {HLClient} from '../src/modules/hyperliquid.js';
import {assessLiquidityEvent,resolveLiquidityEvent} from '../src/modules/liquidity/event.js';
import {liquidityCatalogue,catalogueEventQuality} from '../src/modules/liquidity/catalog.js';
// Read-only public timings. No wallet, credentials, SQLite, config changes or exchange.
// Zero address fee/balance evidence is NOT evidence for any user's account.
const account='0x'+'0'.repeat(40);
const client=new HLClient(null,'mainnet',{accountAddress:account});
client._exchangeRequest=async()=>{throw Error('Public smoke forbids exchange writes');};
const calls=[];let pending=0,peak=0;
const info=client._infoRequest.bind(client);
const catalogueMode=process.argv.includes('--catalogue');
client._infoRequest=async (body,options)=>{if(catalogueMode)assert(['outcomeMeta','l2Book'].includes(body.type),'Catalogue smoke forbids private evidence reads');const start=performance.now();pending++;peak=Math.max(peak,pending);try{return await info(body,options);}finally{pending--;calls.push({type:body.type,coin:body.coin,ms:Math.round(performance.now()-start)});}};
if(catalogueMode){
 const start=performance.now(),selected=await liquidityCatalogue(client,{selected:{type:'question',id:289}}),selectedMs=Math.round(performance.now()-start);
 const meta=await client.getOutcomeMeta(),resolved=resolveLiquidityEvent(meta,{type:'question',id:289}),books=new Map();
 for(let i=0;i<resolved.legs.length;i+=6)await Promise.all(resolved.legs.slice(i,i+6).map(async l=>books.set(l.coin,await client.getOrderbook(l.coin))));
 const quality=await catalogueEventQuality(meta,resolved,books,Date.now());
 assert.equal(selected.length,0);assert.equal(quality.eligible,false);
 assert(quality.legs.some(l=>l.reasons.some(r=>['insufficient_depth','book_imbalance','no_two_sided_book'].includes(r))),'Q289 must be excluded on actual weak/empty public books');
 const fullStart=performance.now(),before=calls.length,events=await liquidityCatalogue(client);
 assert(!events.some(e=>e.questionId===289));assert(peak<=6);assert.equal(client.wallet,null);
 const count=xs=>xs.reduce((m,c)=>(m[c.type]=(m[c.type]||0)+1,m),{});
 console.log(JSON.stringify({at:new Date().toISOString(),network:'mainnet',readOnly:true,wallet:false,peakConcurrentInfoReads:peak,
   selected:{question:289,elapsedMs:selectedMs,quality},full:{elapsedMs:Math.round(performance.now()-fullStart),eventCount:events.length,callCounts:count(calls.slice(before)),question289Excluded:true},callCounts:count(calls)},null,2));
}else {
const results=[];
for(const id of [250,198,289]) {
 const start=performance.now(),before=calls.length;
 const assessment=await assessLiquidityEvent(client,{event:{type:'question',id},mode:'live',account,network:'mainnet',durationMinutes:30,budgetUsdc:1000,maxInventoryShares:1000000,orderSizeShares:1,minPrice:0.00001,maxPrice:0.99999,minSpread:0.00001,maxLossUsdc:10,maxActions:1000});
 const valid=assessment.legs.filter(l=>!l.unavailable);
 const stale=assessment.reasons.filter(r=>r.code==='stale_event_snapshot'||r.code==='book_data_unavailable'&&/Stale/.test(r.detail));
 assert.equal(assessment.legs.length,id===250?18:id===198?14:8,'All named + fallback YES/NO are mandatory');
 assert.equal(stale.length,0,JSON.stringify(stale));
 if(id===250){assert.equal(assessment.suitability,'unavailable');assert(assessment.reasons.some(r=>r.detail==='Outcome fee scale unavailable'),'Never invent an omitted fee scale');}
 else assert(valid.length>0,JSON.stringify({message:'At least one actual prepared+refreshed public leg required',assessment,calls}));
 const summary={question:id,label:assessment.label,elapsedMs:Math.round(performance.now()-start),legs:assessment.legs.length,preparedFreshLegs:valid.length,maxSnapshotAgeMs:valid.length?Math.max(...valid.map(l=>assessment.observedAt-l.time)):null,suitability:assessment.suitability,feeCeilings:[...new Set(valid.map(l=>l.feeRate))],reasons:assessment.reasons,callCounts:calls.slice(before).reduce((m,c)=>(m[c.type]=(m[c.type]||0)+1,m),{})};
 results.push(summary);
}
console.log(JSON.stringify({at:new Date().toISOString(),network:'mainnet',readOnly:true,wallet:false,accountEvidence:'Public zero address only; not a user viability/fee assertion',peakConcurrentInfoReads:peak,results,calls},null,2));
}
