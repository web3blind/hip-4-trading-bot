import {createHash,randomUUID} from 'node:crypto';
import {HLClient} from '../hyperliquid.js';
import {resolveLiquidityEvent} from './event.js';
import {bookQuote,market,feeEvidence,automaticFeeSpreadThreshold} from './market.js';

const corridor={minSpread:0,minPrice:0,maxPrice:1};
const clientBindings=new WeakMap(); // identity only; no books/fees/eligibility cache
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
export async function liquidityCatalogue(client,{selected,candidates,onQualified,mode='live',isCurrent=()=>true,now=Date.now,timeoutMs,page,pageSize=5,progressive=false,automatic=false,discoveryBudgetMs=8000,maxDiscoveryBooks,cursor}={}) {
  timeoutMs ??= automatic&&!selected?90000:30000;
  maxDiscoveryBooks ??= automatic?1200:200;
  if(automatic){timeoutMs=Math.min(timeoutMs,selected?30000:90000);progressive=true;discoveryBudgetMs=timeoutMs;maxDiscoveryBooks=Math.min(maxDiscoveryBooks,1200);if(!selected)page??=1;}
  const controller=new AbortController(),options={signal:controller.signal};
  const discoveryStarted=now(),wallStarted=performance.now();
  let stopped=false,timer,poll,stage='metadata';
  const check=()=>{if(stopped||!isCurrent())throw catalogueError('catalogue_superseded',stage);};
  async function pause(ms) {
    check();if(ms<=0)return;
    await new Promise((resolve,reject)=>{
      const abort=()=>{clearTimeout(wait);reject(catalogueError('catalogue_superseded',stage));};
      const wait=setTimeout(()=>{controller.signal.removeEventListener('abort',abort);resolve();},ms);
      controller.signal.addEventListener('abort',abort,{once:true});
    });check();
  }
  // Request-lifetime retries only. No detached jobs, cached eligibility or signing.
  const retry=async read=>{for(let attempt=0;;attempt++){check();try{return await read();}catch(error){check();if(!automatic||attempt>=1)throw error;await pause(100);}}};
  const work=(async()=>{
    check();const meta=await retry(()=>client.getOutcomeMeta(options));check();
    if(!Array.isArray(meta?.questions)||!Array.isArray(meta?.outcomes))throw Error('Metadata unavailable');
    if(!clientBindings.has(client))clientBindings.set(client,randomUUID());
    const fingerprint=createHash('sha256').update(JSON.stringify([meta,mode,client.network,String(client.address).toLowerCase(),clientBindings.get(client)])).digest('hex');
    // A continuation is an expiring discovery position, NEVER eligibility proof.
    // Reordering/membership, account/network or mode drift starts fresh discovery.
    const bindingReset=!!cursor&&(cursor.fingerprint!==fingerprint||now()>=cursor.expiresAt);
    if(bindingReset&&candidates){const reset=[];reset.discovery={bindingReset:true,automatic,bookReads:0};return reset;}
    if(bindingReset){page=1;candidates=undefined;}
    let fees,feesObservedAt;
    const feesFresh=at=>Number.isSafeInteger(feesObservedAt)&&at>=feesObservedAt&&at-feesObservedAt<=5000;
    async function readFees() {
      stage='fees';
      try {fees=await retry(async()=>{
        const response=await client.getUserFees(options);
        if(automatic)try {feeEvidence(response,1);}catch(error){if(error.code!=='fee_exceeds_reserve')throw error;}
        return response;
      });}catch {check();throw catalogueError('catalogue_unknown',stage);}
      check();feesObservedAt=now(); // response observation, never a cached/invented source timestamp
    }
    await readFees();
    const grouped=new Set(meta.questions.flatMap(q=>[...(q.namedOutcomes||[]),...(q.settledNamedOutcomes||[]),q.fallbackOutcome]));
    const refs=selected?[selected]:candidates||[
      ...meta.questions.map(q=>({type:'question',id:q.question})),
      ...meta.outcomes.filter(o=>!grouped.has(o.outcome)).map(o=>({type:'standalone',id:o.outcome})),
    ];
    let events=[];let membershipUnknown=0,livePriceUnsupported=0;
    for(const ref of refs) {
      let resolved;
      try {resolved=resolveLiquidityEvent(meta,ref);}catch(error){if(error.code==='market_unsuitable')continue;membershipUnknown++;continue;}
      // Reuse final market guards for the selected mode; only explicit observation bypasses live restrictions.
      try {for(const l of resolved.legs)market(meta,l.coin,now(),mode!=='observe');}catch(error){if(error.code==='market_unsuitable'){if(error.subreason==='live_price_unsupported')livePriceUnsupported++;continue;}/* Unknown timing is checked in the unchanged final assessment, not book quality. */}
      events.push({resolved,books:new Map()});
    }
    // Page windows are discovery only, rebuilt from THIS metadata and mode on
    // every request. No cached books, fees, eligibility, or account binding.
    // Count candidate windows, not an invented number of qualified-result pages.
    const totalCandidates=events.length;
    let pagination,unscanned=0,windows;
    let scanned=0,skippedWeak=0,skippedUnknown=0,bookReads=0,transportErrors=0;
    const attempts=new Map(),qualifiedIndex=[];let firstPublished=false,nextReadAt=performance.now();
    if(!selected&&page!==undefined) {
      if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>5)throw Error('Invalid candidate page');
      windows=[];let window=[],books=0;
      for(const e of events) {
        if(window.length&&(window.length>=pageSize||books+e.resolved.legs.length>24)){windows.push(window);window=[];books=0;}
        window.push(e);books+=e.resolved.legs.length;
      }
      if(window.length)windows.push(window);
      if(candidates)windows=[events]; // actual qualified-result page, never a discovery window
      const pages=Math.max(1,windows.length),currentPage=Math.min(page,pages);
      events=windows[currentPage-1]||[];unscanned=totalCandidates-events.length;
      pagination={page:currentPage,pages,candidateWindows:true};
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
      const workers=await Promise.allSettled(Array.from({length:Math.min(6,jobs.length)},async()=>{
        while(index<jobs.length) {
          check();const {e,l}=jobs[index++];let book;
          const fetchBook=async()=>{
            check();if(automatic&&(bookReads>=maxDiscoveryBooks||(attempts.get(l.coin)||0)>=2))return undefined;
            bookReads++;attempts.set(l.coin,(attempts.get(l.coin)||0)+1);
            if(automatic){const scheduled=Math.max(performance.now(),nextReadAt);nextReadAt=scheduled+20;await pause(scheduled-performance.now());}
            return client.getOrderbook(l.coin,options);
          };
          try {book=await retry(fetchBook);}catch(error){check();if(!automatic)throw error;transportErrors++;}
          check();
          e.books.set(l.coin,book);remaining.set(e,remaining.get(e)-1);
          if(!remaining.get(e))await classify(e);
        }
      }));
      const failed=workers.find(w=>w.status==='rejected');if(failed)throw failed.reason;
    }
    for(;;) {
    stage='books';
    // Legacy direct scans retain their per-window cap. Automatic discovery and
    // result-page refresh always verify the whole event within the total bound.
    await read(events.filter(e=>!pagination||automatic||e.resolved.legs.length<=48).flatMap(e=>e.resolved.legs.map(l=>({e,l}))));
    // Keep quality observed at each event's completion. Stale unrelated books
    // are UNKNOWN, not weak. Prioritize EARLY qualified candidates, with a hard
    // 24-book refresh budget (whole events, at most two reads/coin). Never chase
    // freshness across the entire universe a second time.
    stage='candidate_refresh';let budget=automatic?Math.max(0,maxDiscoveryBooks-bookReads):progressive&&pagination?Math.min(24,Math.max(0,maxDiscoveryBooks-bookReads)):24;const refresh=[];
    const at=now();
    for(const e of [...events.filter(e=>e.quality?.eligible),...events.filter(e=>!e.quality)]) {
      if(allFresh(e,at)||e.resolved.legs.length>budget||automatic&&e.resolved.legs.some(l=>(attempts.get(l.coin)||0)>=2))continue;
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
    const verification=events.filter(e=>!automatic&&pagination&&e.resolved.legs.length>48).map(({resolved:r})=>({type:r.event.type,id:r.event.id,name:r.label,books:r.legs.length}));
    if(progressive&&pagination) {
      scanned+=events.length;
      unscanned=totalCandidates-scanned;
      const next=windows[pagination.page];
      const cost=next?.reduce((n,e)=>n+e.resolved.legs.length,0)||0;
      // Internal legacy continuation is retained for diagnostics. Telegram uses
      // onQualified: publish the first useful page, then automatically cover the
      // remaining source within one deadline. UNKNOWN never becomes weak.
      if(!onQualified&&!published.length&&(!unknown||automatic)&&next&&bookReads+cost<=maxDiscoveryBooks&&
        Math.max(now()-discoveryStarted,performance.now()-wallStarted)<discoveryBudgetMs) {
        skippedWeak+=weak;skippedUnknown+=unknown-membershipUnknown;pagination.page++;events=next;continue;
      }
      pagination.nextPage=next?pagination.page+1:null;
      pagination.scannedWindows=skippedWeak?pagination.page-Math.min(page,pagination.pages)+1:1;
    }
    if(!automatic&&!published.length&&unknown&&!verification.length&&(!pagination||!unscanned))throw catalogueError('catalogue_unknown',stage);
    const result=published.map(({resolved:r})=>({type:r.event.type,
      ...(r.event.type==='question'?{questionId:r.event.id}:{outcomeId:r.event.id}),name:r.label}));
    // Keep the existing array/pagination API; publish counts, never account fee payloads.
    result.summary={total:membershipUnknown+totalCandidates,qualified:published.length,weak:weak+skippedWeak,unknown:unknown+skippedUnknown,...(pagination?{unscanned}:{}),partial:unknown+skippedUnknown>0||unscanned>0};
    if(automatic)result.summary.livePriceUnsupported=livePriceUnsupported;
    result.discovery={bookReads,transportErrors,bindingReset,automatic,terminal:!published.length};
    if(verification.length)result.verification=verification;
    if(pagination)result.pagination=pagination;
    if(pagination)result.cursor={fingerprint,expiresAt:now()+60000};
    result.validUntil=Math.min(feesObservedAt+5000,...published.flatMap(e=>e.resolved.legs.map(l=>numeric(e.books.get(l.coin).time)+5000)));
    if(automatic&&onQualified){
      qualifiedIndex.push(...published.map(({resolved:r})=>({...r.event})));
      result.discovery.index=qualifiedIndex;
      if(published.length&&!firstPublished){
        firstPublished=true;result.discovery.inProgress=true;
        await onQualified(result);check();
      }
      const next=windows?.[pagination.page],cost=next?.reduce((n,e)=>n+e.resolved.legs.length,0)||0;
      if(next&&bookReads+cost<=maxDiscoveryBooks&&Math.max(now()-discoveryStarted,performance.now()-wallStarted)<discoveryBudgetMs){
        skippedWeak+=weak;skippedUnknown+=unknown-membershipUnknown;pagination.page++;events=next;continue;
      }
      result.discovery.inProgress=false;
      result.summary.qualified=qualifiedIndex.length;
      result.discovery.terminal=!qualifiedIndex.length;
    }
    return result;
    }
  })();
  const interrupted=new Promise((_,reject)=>{
    timer=setTimeout(()=>{stopped=true;reject(catalogueError('catalogue_deadline',stage));},timeoutMs);
    poll=setInterval(()=>{if(!isCurrent()){stopped=true;reject(catalogueError('catalogue_superseded',stage));}},50);
  });
  try{return await Promise.race([work,interrupted]);}
  catch(error){throw /^catalogue_(unknown|deadline|superseded)$/.test(error?.code||'')?error:catalogueError('catalogue_api',stage);}
  finally{
    stopped=true;controller.abort();clearTimeout(timer);clearInterval(poll);
    // A raced interruption is not worker completion. In particular onQualified
    // may already be publishing to Telegram: drain it before navigation replaces
    // that message. The native publication has its own bounded transport signal.
    await work.catch(()=>{});
  }
}
