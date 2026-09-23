import assert from 'node:assert/strict';
import {test} from 'node:test';
import {completeSetQuestions,quoteCompleteSet} from '../../src/modules/complete-set.js';
import {getCompleteSetFeeEvidence} from '../../src/modules/complete-set-fees.js';
import {meta,templates,q,outcomes,fees,account,fixedNow} from '../fixtures/complete-set.js';
const books={'#44830':[[{px:'.25',sz:'500'}],[{px:'.28258',sz:'24'},{px:'.283',sz:'1622'}]],'#44840':[[{px:'.25',sz:'500'}],[{px:'.26374',sz:'68'},{px:'.26411',sz:'992'}]],'#44850':[[{px:'.40',sz:'500'}],[{px:'.44457',sz:'135'},{px:'.44462',sz:'254'},{px:'.44591',sz:'1000'}]]};
function client(b=books){return {address:account,network:'mainnet',getUserFees:async()=>fees,getOrderbook:async coin=>({levels:b[coin]||[[],[]]}),prepareOrder:async o=>({...o,maxSpend:Math.ceil(o.price*o.size*1.01*1e6)/1e6})};}
const discovered=(m=meta,t=templates)=>completeSetQuestions(m,t,fixedNow);
test('official template proves exhaustive named outcomes for changing teams and IDs',()=>{
 const first=discovered();assert.equal(first.length,1);assert.equal(first[0].coverage,'named_exhaustive');
 const newer={...q,question:999,description:q.description.replaceAll('Czechia','Denmark').replace('20260926','20261026').replace('20260927','20261027'),namedOutcomes:[72,73,74],fallbackOutcome:71};
 const otherOutcomes=outcomes.map((o,i)=>({...o,outcome:[72,73,74,71][i],description:o.description.replace('Czechia','Denmark')}));
 assert.equal(discovered({questions:[newer],outcomes:otherOutcomes})[0].question,999);
 for(const change of [{namedOutcomes:null},{settledNamedOutcomes:[4483]},{fallbackOutcome:null}]) assert.equal(discovered({questions:[{...q,...change}],outcomes}).length,0);
 assert.equal(discovered({questions:[{...q,namedOutcomes:[4483,4484]}],outcomes})[0].coverage,'with_fallback');
 assert.equal(discovered(meta,templates.map(x=>x.id==='sportsContestResult'?{...x,description:x.description.replace('fallback resolve to No','fallback resolve to Yes')}:x))[0].coverage,'with_fallback');
});
test('unknown rules require including tradable fallback, never silently treating named as exhaustive',()=>{
 const unknown={...q,name:'template:newQuestion',namedOutcomes:[4483,4485]};
 const result=discovered({questions:[unknown],outcomes});assert.equal(result.length,1);assert.equal(result[0].coverage,'with_fallback');assert.deepEqual(result[0].coveredIds,[4483,4485,4482]);
});
test('depth, each-leg minimum, and worst net after conservative fee bound',async()=>{
 const cq=discovered()[0],c=client(),fee=await getCompleteSetFeeEvidence(c,cq,fixedNow);
 const quote=await quoteCompleteSet(c,cq,40,{now:fixedNow,feeEvidence:fee});assert(quote && quote.shares>0 && quote.netLowerBound>0);
 assert(quote.orders.every(o=>o.orderType==='Market' && o.price*o.size>=10));assert(quote.maxSpend<=40);
 assert.equal(await quoteCompleteSet(c,cq,20,{now:fixedNow,feeEvidence:fee}),null);
 assert.equal(await quoteCompleteSet(c,cq,40,{now:fixedNow}),null);
 assert.equal(await quoteCompleteSet(c,cq,40,{now:fixedNow,feeEvidence:{...fee,rate:0.02}}),null);
 assert.equal(await quoteCompleteSet(c,cq,40,{now:fixedNow+120_000,feeEvidence:fee}),null);
 assert.equal(await quoteCompleteSet(client({'#44830':[[],[]]}),cq,40,{now:fixedNow,feeEvidence:fee}),null);
});
