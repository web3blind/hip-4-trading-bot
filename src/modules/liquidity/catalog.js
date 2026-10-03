import {HLClient} from '../hyperliquid.js';
import {resolveLiquidityEvent} from './event.js';
import {bookQuote,market,feeEvidence,automaticFeeSpreadThreshold} from './market.js';

const corridor={minSpread:0,minPrice:0,maxPrice:1};
const numeric=v=>(typeof v==='number'||typeof v==='string'&&/^\d+(?:\.\d+)?$/.test(v))&&Number.isFinite(Number(v))?Number(v):NaN;

/** Book quality only, not fee/capital/strategy admission. No summed mirrored depth. */
export async function catalogueEventQuality(meta,resolved,books,at=Date.now()) {
  // An isolated, unsigned client supplies EXACT existing order-wire rounding.
  // It reads only this fresh metadata snapshot: no per-leg metadata HTTP calls.
  const preparer=new HLClient(null,'testnet');
  preparer.getOutcomeMeta=async()=>meta;
  const legs=[];
  for(const leg of resolved.legs) {
    try {
      const book=books.get(leg.coin),q=bookQuote(book,at,corridor);
      if(!Array.isArray(book.levels)||book.levels.length!==2||!book.levels.every(l=>Array.isArray(l)&&l.every(x=>numeric(x.px)>0&&numeric(x.px)<1&&numeric(x.sz)>0)))throw Error('Invalid book levels');
      const spec=meta.outcomes.find(o=>o.outcome===leg.outcomeId);
      if(spec.quoteToken!=='USDC')throw Error('Unavailable USDC outcome');
      const decimals=spec.sideSpecs?.[leg.side]?.szDecimals ?? spec.szDecimals ?? 0;
      if(!Number.isInteger(decimals)||decimals<0||decimals>8)throw Error('Invalid precision');
      const wire=await preparer._buildOrderWire({coin:leg.coin,isBuy:true,price:q.bid,size:1,orderType:'PostOnly'});
      const unit=10**decimals;
      const minimum=Math.max(1,Math.ceil((10/Number(wire.p)-1e-10)*unit)/unit);
      const buy=await preparer.prepareMakerOrder({coin:leg.coin,isBuy:true,price:q.bid,size:minimum});
      const sell=await preparer.prepareMakerOrder({coin:leg.coin,isBuy:false,price:q.ask,size:minimum});
      const bidDepth=numeric(book.levels[0][0].sz),askDepth=numeric(book.levels[1][0].sz);
      const reasons=[];
      if(Math.min(bidDepth,askDepth)<buy.size)reasons.push('insufficient_depth');
      if(Math.max(bidDepth,askDepth)/Math.min(bidDepth,askDepth)>4)reasons.push('book_imbalance');
      if(sell.price<=buy.price||sell.size!==buy.size)reasons.push('invalid_rounded_book');
      legs.push({...leg,...q,minimumShares:buy.size,bidDepth,askDepth,reasons});
    } catch(error) {legs.push({...leg,reasons:[error.code||'invalid_book']});}
  }
  // Verify BOTH mandatory views but count neither depth nor edge twice.
  for(const id of resolved.members) {
    const yes=legs.find(l=>l.outcomeId===id&&l.side===0),no=legs.find(l=>l.outcomeId===id&&l.side===1);
    if(!yes.reasons.length&&!no.reasons.length&&(Math.abs(yes.bid+no.ask-1)>0.00002||Math.abs(yes.ask+no.bid-1)>0.00002))yes.reasons.push('merged_book_mismatch');
  }
  return {eligible:legs.every(l=>!l.reasons.length),legs};
}

/** Account fee admission on complete fresh books; no capital/profit guarantee. */
export async function catalogueEventAdmission(meta,resolved,books,fees,at=Date.now()) {
  const rates=new Map();let reserveExceeded=false;
  for(const leg of resolved.legs) {
    const spec=meta.outcomes.find(o=>o.outcome===leg.outcomeId);
    try {rates.set(leg.coin,feeEvidence(fees,numeric(spec?.deployerFeeScale)));}
    catch(error) {
      if(error.code==='fee_exceeds_reserve'){reserveExceeded=true;continue;}
      return null; // Missing/invalid fee evidence is UNKNOWN, never verified weak.
    }
  }
  if(reserveExceeded)return {eligible:false,legs:[],reasons:['fee_exceeds_reserve']};
  const quality=await catalogueEventQuality(meta,resolved,books,at);
  if(!quality.eligible)return quality;
  const legs=quality.legs.map(l=>({...l,feeRate:rates.get(l.coin)}));
  const minSpread=automaticFeeSpreadThreshold(legs);
  for(const l of legs) {
    if(l.ask-l.bid<minSpread)l.reasons.push('spread_below_policy');
    if(l.ask-l.bid-l.feeRate*(l.ask+l.bid)<=0)l.reasons.push('no_net_spread');
  }
  // Same conservative matched-edge presentation as final assessment. Global
  // round-trip admission above already dominates a non-positive pair edge.
  const pairs=resolved.members.map(id=>{
    const yes=legs.find(l=>l.outcomeId===id&&l.side===0),no=legs.find(l=>l.outcomeId===id&&l.side===1);
    return {outcomeId:id,netMatchedEdgePerShare:yes.ask-yes.bid-yes.feeRate*yes.bid-no.feeRate*no.bid,depthCountedOnce:true};
  });
  return {eligible:legs.every(l=>!l.reasons.length),legs,pairs,minSpread};
}

/** Non-atomic account-specific scan; complete fresh fee-admitted events only. */
const catalogueError=(code,stage)=>Object.assign(Error(code==='catalogue_unknown'?'Catalogue freshness unavailable':code==='catalogue_deadline'?'Catalogue deadline exceeded':code==='catalogue_superseded'?'Catalogue refresh superseded':'Catalogue data unavailable'),{code,stage});
export async function liquidityCatalogue(client,{selected,isCurrent=()=>true,now=Date.now,timeoutMs=30000}={}) {
  const controller=new AbortController(),options={signal:controller.signal};
  let stopped=false,timer,poll,stage='metadata';
  const check=()=>{if(stopped||!isCurrent())throw catalogueError('catalogue_superseded',stage);};
  const work=(async()=>{
    check();const meta=await client.getOutcomeMeta(options);check();
    if(!Array.isArray(meta?.questions)||!Array.isArray(meta?.outcomes))throw Error('Metadata unavailable');
    let fees,feesObservedAt;
    const feesFresh=at=>Number.isSafeInteger(feesObservedAt)&&at>=feesObservedAt&&at-feesObservedAt<=5000;
    async function readFees() {
      stage='fees';
      try {fees=await client.getUserFees(options);}catch {check();throw catalogueError('catalogue_unknown',stage);}
      check();feesObservedAt=now(); // response observation, never a cached/invented source timestamp
    }
    await readFees();
    const grouped=new Set(meta.questions.flatMap(q=>[...(q.namedOutcomes||[]),...(q.settledNamedOutcomes||[]),q.fallbackOutcome]));
    const refs=selected?[selected]:[
      ...meta.questions.map(q=>({type:'question',id:q.question})),
      ...meta.outcomes.filter(o=>!grouped.has(o.outcome)).map(o=>({type:'standalone',id:o.outcome})),
    ];
    const events=[];let membershipUnknown=0;
    for(const ref of refs) {
      let resolved;
      try {resolved=resolveLiquidityEvent(meta,ref);}catch(error){if(error.code==='market_unsuitable')continue;membershipUnknown++;continue;}
      // Expiry/settlement here; unchanged final assessment still checks all live policy.
      try {for(const l of resolved.legs)market(meta,l.coin,now(),false);}catch(error){if(error.code==='market_unsuitable')continue;/* Unknown timing is checked in the unchanged final assessment, not book quality. */}
      events.push({resolved,books:new Map()});
    }
    const fresh=(book,at)=>{const time=numeric(book?.time);return Number.isSafeInteger(time)&&time<=at+1000&&at-time<=5000;};
    const allFresh=(e,at)=>e.resolved.legs.every(l=>fresh(e.books.get(l.coin),at));
    async function classify(e) {
      const at=now();
      // Book-only observations prioritize candidates. Initial fee rejection
      // must not discard an event that a current final fee snapshot could admit.
      e.quality=allFresh(e,at)?await catalogueEventQuality(meta,e.resolved,e.books,at):null;
      check();
      // Awaited rounding must not turn old evidence into a verified weak result.
      if(!allFresh(e,now()))e.quality=null;
    }
    async function read(jobs) {
      let index=0;const remaining=new Map();
      for(const {e} of jobs)remaining.set(e,(remaining.get(e)||0)+1);
      await Promise.all(Array.from({length:Math.min(6,jobs.length)},async()=>{
        while(index<jobs.length) {
          check();const {e,l}=jobs[index++];const book=await client.getOrderbook(l.coin,options);check();
          e.books.set(l.coin,book);remaining.set(e,remaining.get(e)-1);
          if(!remaining.get(e))await classify(e);
        }
      }));
    }
    stage='books';
    await read(events.flatMap(e=>e.resolved.legs.map(l=>({e,l}))));
    // Keep quality observed at each event's completion. Stale unrelated books
    // are UNKNOWN, not weak. Prioritize EARLY qualified candidates, with a hard
    // 24-book refresh budget (whole events, at most two reads/coin). Never chase
    // freshness across the entire universe a second time.
    stage='candidate_refresh';let budget=24;const refresh=[];
    const at=now();
    for(const e of [...events.filter(e=>e.quality?.eligible),...events.filter(e=>!e.quality)]) {
      if(allFresh(e,at)||e.resolved.legs.length>budget)continue;
      budget-=e.resolved.legs.length;
      refresh.push(...e.resolved.legs.map(l=>({e,l})));
    }
    await read(refresh);check();
    // At most one final fee refresh, inside the original deadline/signal. No
    // book chase follows it: slow fees make expired candidate books UNKNOWN.
    if(!feesFresh(now()))await readFees();
    stage='publication';
    for(const e of events) {
      const at=now();
      if(!feesFresh(at))throw catalogueError('catalogue_unknown',stage);
      if(allFresh(e,at)) {
        e.quality=await catalogueEventAdmission(meta,e.resolved,e.books,fees,at);
        check();
        if(!allFresh(e,now()))e.quality=null;
      } else if(e.quality?.eligible) e.quality=null;
      else if(e.quality) {
        // Preserve independently observed book weakness only with complete
        // current fee/scale evidence, never stale fee-based classification.
        for(const l of e.resolved.legs)try {feeEvidence(fees,numeric(meta.outcomes.find(o=>o.outcome===l.outcomeId)?.deployerFeeScale));}
        catch(error) {if(error.code!=='fee_exceeds_reserve'){e.quality=null;break;}}
      }
    }
    const finalAt=now(); // no awaits between publication freshness and return
    if(!feesFresh(finalAt))throw catalogueError('catalogue_unknown',stage);
    const published=events.filter(e=>e.quality?.eligible&&allFresh(e,finalAt));
    const weak=events.filter(e=>e.quality&&!e.quality.eligible).length;
    const unknown=membershipUnknown+events.length-published.length-weak;
    if(!published.length&&unknown)throw catalogueError('catalogue_unknown',stage);
    const result=published.map(({resolved:r})=>({type:r.event.type,
      ...(r.event.type==='question'?{questionId:r.event.id}:{outcomeId:r.event.id}),name:r.label}));
    // Keep the existing array/pagination API; publish counts, never account fee payloads.
    result.summary={total:membershipUnknown+events.length,qualified:published.length,weak,unknown,partial:unknown>0};
    result.validUntil=Math.min(feesObservedAt+5000,...published.flatMap(e=>e.resolved.legs.map(l=>numeric(e.books.get(l.coin).time)+5000)));
    return result;
  })();
  const interrupted=new Promise((_,reject)=>{
    timer=setTimeout(()=>{stopped=true;reject(catalogueError('catalogue_deadline',stage));},timeoutMs);
    poll=setInterval(()=>{if(!isCurrent()){stopped=true;reject(catalogueError('catalogue_superseded',stage));}},50);
  });
  try{return await Promise.race([work,interrupted]);}
  catch(error){throw /^catalogue_(unknown|deadline|superseded)$/.test(error?.code||'')?error:catalogueError('catalogue_api',stage);}
  finally{stopped=true;controller.abort();clearTimeout(timer);clearInterval(poll);}
}
