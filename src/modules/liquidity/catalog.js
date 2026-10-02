import {HLClient} from '../hyperliquid.js';
import {resolveLiquidityEvent} from './event.js';
import {bookQuote,market} from './market.js';

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

/** Fresh public scan, six reads maximum, no authoritative partial API result. */
export async function liquidityCatalogue(client,{selected,isCurrent=()=>true,now=Date.now,timeoutMs=30000}={}) {
  const controller=new AbortController(),options={signal:controller.signal};
  let stopped=false,timer,poll;
  const check=()=>{if(stopped||!isCurrent())throw Error('Catalogue refresh superseded');};
  const work=(async()=>{
    check();const meta=await client.getOutcomeMeta(options);check();
    if(!Array.isArray(meta?.questions)||!Array.isArray(meta?.outcomes))throw Error('Metadata unavailable');
    const grouped=new Set(meta.questions.flatMap(q=>[...(q.namedOutcomes||[]),...(q.settledNamedOutcomes||[]),q.fallbackOutcome]));
    const refs=selected?[selected]:[
      ...meta.questions.map(q=>({type:'question',id:q.question})),
      ...meta.outcomes.filter(o=>!grouped.has(o.outcome)).map(o=>({type:'standalone',id:o.outcome})),
    ];
    const events=[];
    for(const ref of refs) {
      let resolved;
      try {resolved=resolveLiquidityEvent(meta,ref);}catch(error){if(error.code==='market_unsuitable')continue;throw error;}
      // Public expiry/settlement only; never require account fees or live policy.
      try {for(const l of resolved.legs)market(meta,l.coin,now(),false);}catch(error){if(error.code==='market_unsuitable')continue;/* Unknown timing is checked in the unchanged final assessment, not book quality. */}
      events.push({resolved,books:new Map()});
    }
    const fresh=(book,at)=>{const time=numeric(book?.time);return Number.isSafeInteger(time)&&time<=at+1000&&at-time<=5000;};
    async function read(jobs) {
      let index=0;
      await Promise.all(Array.from({length:Math.min(6,jobs.length)},async()=>{
        while(index<jobs.length) {
          check();const {e,l}=jobs[index++];const book=await client.getOrderbook(l.coin,options);check();
          e.books.set(l.coin,book);
        }
      }));
    }
    await read(events.flatMap(e=>e.resolved.legs.map(l=>({e,l}))));
    // One bounded refresh sweep, only for expired/unknown timestamps. Do not
    // repeatedly chase freshness across a slow catalogue or claim UNKNOWN weak.
    const at=now();
    await read(events.flatMap(e=>e.resolved.legs.filter(l=>!fresh(e.books.get(l.coin),at)).map(l=>({e,l}))));
    check();
    const qualityAt=now();
    await Promise.all(events.map(async e=>{e.quality=await catalogueEventQuality(meta,e.resolved,e.books,qualityAt);}));
    check();
    const finalAt=now(); // no awaits between this all-book gate and returning
    if(events.some(e=>e.resolved.legs.some(l=>!fresh(e.books.get(l.coin),finalAt))))throw Error('Catalogue freshness unavailable');
    return events.filter(e=>e.quality?.eligible).map(({resolved:r})=>({type:r.event.type,
      ...(r.event.type==='question'?{questionId:r.event.id}:{outcomeId:r.event.id}),name:r.label}));
  })();
  const interrupted=new Promise((_,reject)=>{
    timer=setTimeout(()=>{stopped=true;reject(Error('Catalogue deadline exceeded'));},timeoutMs);
    poll=setInterval(()=>{if(!isCurrent()){stopped=true;reject(Error('Catalogue refresh superseded'));}},50);
  });
  try{return await Promise.race([work,interrupted]);}
  finally{stopped=true;controller.abort();clearTimeout(timer);clearInterval(poll);}
}
