import {createHash} from 'node:crypto';
import {market, bookQuote, feeEvidence} from './market.js';
import {liquidityName,liquiditySideName} from './labels.js';
export function spendableSpotUsdc(data) {
  if(!Array.isArray(data?.balances)) throw Error('Spot USDC unavailable');
  const rows=data.balances.filter(b=>b.coin==='USDC');
  if(rows.length!==1) throw Error('Spot USDC unavailable or ambiguous');
  const {total,hold}=rows[0];
  if(total==null || hold==null || !Number.isFinite(Number(total)) || !Number.isFinite(Number(hold)) || Number(hold)<0 || Number(total)<Number(hold)) throw Error('Invalid Spot USDC');
  return Number(total)-Number(hold);
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const label = value => String(value || '').replace(/[<>\x00-\x1f]/g,'').slice(0,120);

/** Resolve the complete source membership, not the filtered display catalog. */
export function resolveLiquidityEvent(meta,event) {
  if (!event || !['question','standalone'].includes(event.type) || !Number.isSafeInteger(event.id) || event.id<0 || Object.keys(event).length!==2) throw Error('Invalid liquidity event');
  if (!Array.isArray(meta?.outcomes) || !Array.isArray(meta?.questions)) throw Error('Event metadata unavailable');
  const q=event.type==='question' ? meta.questions.filter(q=>q.question===event.id) : [];
  if (event.type==='question' && q.length!==1) throw Error('Event missing or duplicated');
  const question=q[0];
  const ids=question ? [...(question.namedOutcomes || []),question.fallbackOutcome] : [event.id];
  if (!ids.length || ids.some(id=>!Number.isSafeInteger(id)||id<0) || new Set(ids).size!==ids.length || question && (!Array.isArray(question.namedOutcomes) || !question.namedOutcomes.length || !Array.isArray(question.settledNamedOutcomes))) throw Error('Invalid, duplicate or settled event membership');
  if(question && ids.some(id=>question.settledNamedOutcomes.includes(id)))throw Object.assign(Error('Settled event member'),{code:'market_unsuitable'});
  if (!question && meta.questions.some(q=>q.namedOutcomes?.includes(event.id)||q.settledNamedOutcomes?.includes(event.id)||q.fallbackOutcome===event.id)) throw Error('Grouped member is not a standalone event');
  const specs=ids.map(id=>{
    const matches=meta.outcomes.filter(o=>o.outcome===id);
    if(matches.length!==1) throw Error('Missing or duplicate event outcome');
    if(matches[0].settled || matches[0].isSettled)throw Object.assign(Error('Settled event outcome'),{code:'market_unsuitable'});
    return matches[0];
  });
  const legs=specs.flatMap(o=>[0,1].map(side=>({coin:'#'+(o.outcome*10+side),outcomeId:o.outcome,side,
    name:label(liquidityName(o,question,question?.fallbackOutcome===o.outcome)),sideName:label(liquiditySideName(o,side,question)),
    fallback:question?.fallbackOutcome===o.outcome})));
  if(legs.some(l=>!Number.isSafeInteger(Number(l.coin.slice(1))))) throw Error('Invalid outcome encoding');
  return {event:{...event},label:label(liquidityName(question || specs[0])),legs,
    members:ids,fingerprint:hash({question,specs})};
}

// Bounded public reads/preparation; never use this helper for exchange writes.
async function mapReads(items, fn) {
  const results=new Array(items.length);let index=0;
  await Promise.all(Array.from({length:Math.min(6,items.length)},async()=>{
    while(index<items.length){const i=index++;results[i]=await fn(items[i],i);}
  }));
  return results;
}
const dataCodes=new Set(['membership_unavailable','fees_unavailable','capital_unavailable','inventory_unavailable','leg_unavailable','book_data_unavailable','stale_event_snapshot']);
export async function assessLiquidityEvent(client,policy,now=Date.now) {
  const meta=await client.getOutcomeMeta();let resolved;
  try {resolved=resolveLiquidityEvent(meta,policy.event);} catch(error) {
    const q=meta?.questions?.find(q=>q.question===policy.event?.id),ids=policy.event?.type==='question'?[...(Array.isArray(q?.namedOutcomes)?q.namedOutcomes:[]),q?.fallbackOutcome]:[policy.event?.id];
    const sourceLegs=ids.flatMap(id=>[0,1].map(side=>({coin:Number.isSafeInteger(id)?'#'+(10*id+side):null,outcomeId:id,side,name:id==null?'Fallback missing':meta?.outcomes?.find(o=>o.outcome===id)?.name || `Outcome ${id}`,sideName:side===0?'YES':'NO',fallback:id===q?.fallbackOutcome,unavailable:true})));
    const legs=sourceLegs.map(l=>{const o=meta?.outcomes?.find(o=>o.outcome===l.outcomeId);return {...l,name:l.outcomeId==null?'Fallback missing':liquidityName(o || {outcome:l.outcomeId},q,l.fallback),sideName:liquiditySideName(o,l.side,q)};});
    return {event:policy.event,label:label(liquidityName(q || meta?.outcomes?.find(o=>o.outcome===policy.event?.id) || {outcome:policy.event?.id})),legs,members:ids,fingerprint:hash({q,ids,legs:sourceLegs}),observedAt:now(),suitability:error.code==='market_unsuitable'?'unsuitable':'unavailable',minimumBudgetUsdc:null,requiredBudgetUsdc:null,reasons:[{code:error.code || 'membership_unavailable',detail:error.message}]};
  }
  const reasons=[],legs=[];let fees,available,balances;
  try {fees=await client.getUserFees();} catch {reasons.push({code:'fees_unavailable'});}
  try {balances=await client.getUserBalances(policy.account);available=spendableSpotUsdc(balances);if(!Number.isFinite(available)||available<0) throw Error();} catch {available=null;reasons.push({code:'capital_unavailable'});}
  if(policy.mode==='live') {
    if(!Array.isArray(balances?.balances)) reasons.push({code:'inventory_unavailable'});
    else for(const leg of resolved.legs) {
      const rows=balances.balances.filter(b=>b.coin===leg.coin || b.coin==='+'+leg.coin.slice(1));
      if(rows.length>1 || rows.some(b=>b.total==null || !Number.isFinite(Number(b.total)) || Number(b.total)!==0)) reasons.push({coin:leg.coin,code:'existing_inventory'});
    }
    try {const orders=await client.getOpenOrders(policy.account);if(!Array.isArray(orders)) throw Error();for(const leg of resolved.legs) if(orders.some(o=>o.coin===leg.coin || o.coin==='+'+leg.coin.slice(1))) reasons.push({coin:leg.coin,code:'existing_orders'});} catch {reasons.push({code:'inventory_unavailable'});}
  }
  const candidates=await mapReads(resolved.legs,async leg=>{
    try {
      const m=market(meta,leg.coin,now(),policy.mode==='live');
      const q=bookQuote(await client.getOrderbook(leg.coin),now(),{...policy,minSpread:0,minPrice:0,maxPrice:1});
      const rate=feeEvidence(fees,m.feeScale);
      const spec=meta.outcomes.find(o=>o.outcome===leg.outcomeId);
      const precision=spec.sideSpecs?.[leg.side]?.szDecimals ?? spec.szDecimals;
      if(precision!=null && (!Number.isInteger(precision)||precision<0||precision>8))throw Error('Invalid outcome precision');
      const decimals=precision ?? 0;
      const unit=10**decimals,minimumShares=Math.ceil((10/q.bid-1e-10)*unit)/unit;
      const size=Math.max(policy.orderSizeShares,minimumShares);
      if(typeof client.prepareMakerOrder!=='function') throw Error('Maker preparation unavailable');
      const prepared=await client.prepareMakerOrder({coin:leg.coin,isBuy:true,price:q.bid,size});
      const sell=await client.prepareMakerOrder({coin:leg.coin,isBuy:false,price:q.ask,size});
      const minimum=await client.prepareMakerOrder({coin:leg.coin,isBuy:true,price:q.bid,size:minimumShares});
      if(prepared.orderType!=='PostOnly'||sell.orderType!=='PostOnly'||prepared.coin!==leg.coin||sell.coin!==leg.coin||prepared.size!==sell.size||prepared.size<size-1e-7||prepared.price*prepared.size<10-1e-7||sell.price*sell.size<10-1e-7||prepared.price<policy.minPrice||sell.price>policy.maxPrice||sell.price<=prepared.price) throw Object.assign(Error('Rounded maker legs fail minimum or corridor'),{code:'rounded_legs_unsuitable'});
      if(!Number.isFinite(prepared.maxSpend)||prepared.maxSpend<prepared.price*prepared.size*(1+rate)-1e-7||!Number.isFinite(minimum.maxSpend)) throw Error('Maker reserve unavailable');
      return {leg,m,rate,minimumShares,prepared,sell,minimum};
    } catch(error) {return {leg,error};}
  });
  // Refresh AFTER all preparation: slow metadata/rounding must not age earlier legs.
  const refreshed=await mapReads(candidates,async candidate=>{
    if(candidate.error)return candidate;
    try {return {...candidate,book:await client.getOrderbook(candidate.leg.coin)};}
    catch(error){return {...candidate,error};}
  });
  const snapshotAt=now();
  for(const candidate of refreshed) {
    const {leg,m,rate,minimumShares,prepared,sell,minimum,book}=candidate;
    try {
      if(candidate.error)throw candidate.error;
      market(meta,leg.coin,snapshotAt,policy.mode==='live');
      const fresh=bookQuote(book,snapshotAt,{...policy,minSpread:0,minPrice:0,maxPrice:1});
      if(fresh.ask-fresh.bid<policy.minSpread)reasons.push({coin:leg.coin,code:'spread_below_policy'});
      if(fresh.bid<policy.minPrice||fresh.ask>policy.maxPrice)reasons.push({coin:leg.coin,code:'price_outside_policy'});
      if(prepared.price!==fresh.bid||sell.price!==fresh.ask)throw Error('Book changed during assessment');
      const bidDepth=Number(book.levels[0][0].sz),askDepth=Number(book.levels[1][0].sz);
      if(!Number.isFinite(bidDepth)||!Number.isFinite(askDepth)||bidDepth<=0||askDepth<=0) throw Error('Depth unavailable');
      const netRoundTripSpread=fresh.ask-fresh.bid-rate*(fresh.ask+fresh.bid);
      if(netRoundTripSpread<=0) reasons.push({code:'no_net_spread',coin:leg.coin});
      if(Math.min(bidDepth,askDepth)<prepared.size) reasons.push({code:'insufficient_depth',coin:leg.coin});
      if(Math.max(bidDepth,askDepth)/Math.min(bidDepth,askDepth)>4) reasons.push({code:'book_imbalance',coin:leg.coin});
      legs.push({...leg,...fresh,expiry:m.expiry,timing:m.timing,feeRate:rate,minimumShares,size:prepared.size,
        minReserve:minimum.maxSpend,
        reserve:prepared.maxSpend,bidDepth,askDepth,netRoundTripSpread});
    } catch(error) {const code=['book_data_unavailable','book_unsuitable','no_two_sided_book','market_unsuitable','fee_exceeds_reserve','rounded_legs_unsuitable'].includes(error.code)?error.code:'leg_unavailable';reasons.push({code,coin:leg.coin,detail:error.message,...(error.subreason==='live_price_unsupported'?{subreason:error.subreason}:{})});legs.push({...leg,unavailable:true});}
  }
  const valid=legs.every(l=>!l.unavailable);
  const minimumBudgetUsdc=valid?legs.reduce((n,l)=>n+l.minReserve,0):null;
  const requiredBudgetUsdc=valid?legs.reduce((n,l)=>n+l.reserve,0):null;
  if(valid && requiredBudgetUsdc>policy.budgetUsdc+1e-7) reasons.push({code:'insufficient_shared_budget'});
  if(valid && available!==null && requiredBudgetUsdc>available+1e-7) reasons.push({code:'insufficient_spendable_usdc'});
  if(valid && legs.reduce((n,l)=>n+l.size,0)>policy.maxInventoryShares) reasons.push({code:'insufficient_inventory_cap'});
  if(policy.maxActions<legs.length) reasons.push({code:'insufficient_action_cap'});
  // Complementary YES/NO views share one book: no summed depth or doubled edge.
  const pairs=resolved.members.map(id=>{
    const yes=legs.find(l=>l.outcomeId===id&&l.side===0),no=legs.find(l=>l.outcomeId===id&&l.side===1);
    if(yes.unavailable||no.unavailable) return {outcomeId:id,unavailable:true};
    if(Math.abs(yes.bid+no.ask-1)>0.00002||Math.abs(yes.ask+no.bid-1)>0.00002) reasons.push({coin:yes.coin,code:'merged_book_mismatch'});
    return {outcomeId:id,grossMatchedEdgePerShare:yes.ask-yes.bid,netMatchedEdgePerShare:yes.ask-yes.bid-yes.feeRate*yes.bid-no.feeRate*no.bid,depthCountedOnce:true};
  });
  if(legs.some(l=>!l.unavailable && (now()-l.time>5000 || l.time>now()+1000))) reasons.push({code:'stale_event_snapshot'});
  const blocked=reasons.length>0;
  reasons.push({code:'imbalance_and_adverse_selection'});
  return {...resolved,legs,pairs,observedAt:now(),minimumBudgetUsdc,requiredBudgetUsdc,availableUsdc:available,
    suitability:reasons.some(r=>dataCodes.has(r.code))?'unavailable':blocked?'unsuitable':'conditional',reasons};
}
