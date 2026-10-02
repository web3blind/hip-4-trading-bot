import assert from 'node:assert/strict';
import {HLClient} from '../src/modules/hyperliquid.js';
import {assessLiquidityEvent} from '../src/modules/liquidity/event.js';
// Read-only public timings. No wallet, credentials, SQLite, config changes or exchange.
// Zero address fee/balance evidence is NOT evidence for any user's account.
const account='0x'+'0'.repeat(40);
const client=new HLClient(null,'mainnet',{accountAddress:account});
client._exchangeRequest=async()=>{throw Error('Public smoke forbids exchange writes');};
const calls=[];let pending=0,peak=0;
const info=client._infoRequest.bind(client);
client._infoRequest=async body=>{const start=performance.now();pending++;peak=Math.max(peak,pending);try{return await info(body);}finally{pending--;calls.push({type:body.type,coin:body.coin,ms:Math.round(performance.now()-start)});}};
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
