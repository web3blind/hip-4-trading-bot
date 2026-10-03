// Public MAINNET info only. No config, wallet, account or exchange writes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {HLClient} from '../src/modules/hyperliquid.js';
import {liquidityCatalogue,catalogueEventAdmission} from '../src/modules/liquidity/catalog.js';
import {resolveLiquidityEvent} from '../src/modules/liquidity/event.js';
const client=new HLClient(null,'mainnet');
assert.equal(client.wallet,null);
// Catalogue admission is account-specific. This public transport smoke requires
// explicitly supplied representative fee evidence; it is NOT actual user fees.
const feePath=process.argv[process.argv.indexOf('--fees-fixture')+1];
assert(process.argv.includes('--fees-fixture')&&feePath,'Supply --fees-fixture <representative-fees.json>; no default/user fee lookup');
const fees=JSON.parse(readFileSync(feePath));
let feeReads=0;
client.getUserFees=async()=>{feeReads++;return structuredClone(fees);};
let metadata,active=0,peak=0,metadataReads=0;const reads=new Map(),books=new Map();
const request=client._infoRequest.bind(client);
client._infoRequest=async(body,options)=>{
  assert(['outcomeMeta','l2Book'].includes(body.type));
  assert(!('user' in body));
  if(body.type==='outcomeMeta')metadataReads++;
  else reads.set(body.coin,(reads.get(body.coin)||0)+1);
  active++;peak=Math.max(peak,active);
  try {const result=await request(body,options);if(body.type==='outcomeMeta')metadata=result;else books.set(body.coin,result);return result;}
  finally{active--;}
};
const start=performance.now();
try {
  const result=await liquidityCatalogue(client),at=Date.now();
  assert(peak<=6);assert([...reads.values()].every(n=>n<=2));
  assert([...reads.values()].reduce((a,b)=>a+b,0)<=reads.size+24);
  assert(feeReads>=1&&feeReads<=2);assert(at<=result.validUntil);
  const published=[];
  for(const e of result){
    const r=resolveLiquidityEvent(metadata,{type:e.type,id:e.questionId??e.outcomeId});
    const ages=r.legs.map(l=>at-books.get(l.coin).time);
    assert(ages.every(age=>age>=-1000&&age<=5000));
    assert((await catalogueEventAdmission(metadata,r,books,fees,at)).eligible);
    published.push({type:e.type,id:e.questionId??e.outcomeId,legs:r.legs.length,oldestMs:Math.max(...ages)});
  }
  console.log(JSON.stringify({source:'live public mainnet with explicit representative fee fixture (not actual account fees)',at:new Date(at).toISOString(),elapsedMs:Math.round(performance.now()-start),feeReads,metadataReads,metadataOutcomes:metadata.outcomes.length,metadataQuestions:metadata.questions.length,bookReads:[...reads.values()].reduce((a,b)=>a+b,0),uniqueBooks:reads.size,maxReadsPerBook:Math.max(...reads.values()),peak,summary:result.summary,published},null,2));
} catch(error) {
  console.log(JSON.stringify({source:'live public mainnet with explicit representative fee fixture (not actual account fees)',elapsedMs:Math.round(performance.now()-start),code:error.code||({'Catalogue deadline exceeded':'catalogue_deadline','Catalogue freshness unavailable':'catalogue_unknown'}[error.message]||'catalogue_api'),stage:error.stage||'legacy_uninstrumented',feeReads,metadataReads,bookReads:[...reads.values()].reduce((a,b)=>a+b,0),uniqueBooks:reads.size,peak},null,2));process.exitCode=1;
}
