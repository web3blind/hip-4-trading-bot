import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {HLClient} from '../src/modules/hyperliquid.js';
const source=process.argv[2],feePath=process.argv[3];
assert(source&&feePath,'Usage: node scripts/liquidity-catalog-latency-smoke.js <catalog-module-path> <explicit-fees-fixture> [--pages]');
const {liquidityCatalogue}=await import(pathToFileURL(source));
const client=new HLClient(null,'mainnet',{accountAddress:'0x'+'0'.repeat(40)});
client._exchangeRequest=async()=>{throw Error('Writes forbidden');};
const fixture=JSON.parse(readFileSync(feePath));let fees=0;
client.getUserFees=async()=>{fees++;return structuredClone(fixture);};
const info=client._infoRequest.bind(client);let calls=[],pending=0,peak=0;
client._infoRequest=async(body,options)=>{assert(['outcomeMeta','l2Book'].includes(body.type));pending++;peak=Math.max(peak,pending);calls.push({type:body.type,coin:body.coin});try{return await info(body,options);}finally{pending--;}};
const results=[],qualified=process.argv.includes('--qualified'),progressive=process.argv.includes('--progressive');
const usefulStart=performance.now();let nextPage=1,firstQualifiedMs=null,discoveryClicks=0;
for(const requestedPage of qualified?Array.from({length:30},()=>1):process.argv.includes('--pages')?[1,2,1]:[null]){
 const page=qualified?nextPage:requestedPage;
 const before=calls.length,feeBefore=fees,start=performance.now();
 try{const events=await liquidityCatalogue(client,page?{page,pageSize:5,progressive,cursor:qualified?results.at(-1)?.cursor:undefined}:{});results.push({page,elapsedMs:Math.round(performance.now()-start),events,summary:events.summary,pagination:events.pagination,cursor:events.cursor,verification:events.verification,remainingFreshMs:events.validUntil-Date.now()});if(events.length)firstQualifiedMs=Math.round(performance.now()-usefulStart);}
 catch(error){results.push({page,elapsedMs:Math.round(performance.now()-start),error:{code:error.code,stage:error.stage}});}
 const result=results.at(-1);result.callCounts=calls.slice(before).reduce((m,c)=>(m[c.type]=(m[c.type]||0)+1,m),{});result.feeFixtureReads=fees-feeBefore;
 if(qualified){if(firstQualifiedMs!==null||result.error||!result.pagination||result.pagination.page>=result.pagination.pages||performance.now()-usefulStart>=90000)break;nextPage=result.pagination.nextPage||result.pagination.page+1;discoveryClicks++;}
}
assert.equal(client.wallet,null);assert(peak<=6);
console.log(JSON.stringify({source,at:new Date().toISOString(),network:'mainnet',readOnly:true,wallet:false,accountEvidence:'EXPLICIT REPRESENTATIVE FEE FIXTURE; NOT actual user fees or eligibility proof',firstQualifiedMs,discoveryClicks,elapsedTotalMs:Math.round(performance.now()-usefulStart),peakConcurrentInfoReads:peak,results},null,2));
