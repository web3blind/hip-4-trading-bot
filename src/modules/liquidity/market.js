import {createHash} from 'node:crypto';
import {coinToOutcome} from '../hl-encoding.js';
import {FEE_RESERVE} from '../hyperliquid.js';
const num = v => (typeof v === 'number' || typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v)) && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function market(meta, coin, at, live) {
  const {outcomeId,side}=coinToOutcome(coin);
  const spec=meta?.outcomes?.find(x=>x.outcome===outcomeId);
  if (!spec || spec.quoteToken !== 'USDC') throw Object.assign(new Error('Unavailable USDC outcome'),{code:'market_unsuitable'});
  const feeScale=num(spec.deployerFeeScale);
  const question=meta?.questions?.find(q=>q.question===spec.question || q.namedOutcomes?.includes(outcomeId) || q.fallbackOutcome===outcomeId);
  const desc=`${spec.description||''}|${question?.description||''}`;
  if (live && /(?:priceBinary|binaryPrice|priceTouch|priceBucket|priceAbove|priceBelow|priceRange|targetPrice:|priceThresholds:)/i.test(`${spec.name||''}|${question?.name||''}|${desc}`)) throw Object.assign(new Error('Price-market template not supported live'),{code:'market_unsuitable',subreason:'live_price_unsupported'});
  // Template exclusion is authoritative even when fee evidence is unavailable.
  if(live && (feeScale===null || feeScale<0 || feeScale>10)) throw new Error('Outcome fee scale unavailable');
  const parse = value => {
    if(typeof value==='number' && Number.isSafeInteger(value) && value>1e12) return value;
    if(typeof value!=='string') return null;
    if(/^\d{8}-\d{4}$/.test(value)) {
      const iso=`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(9,11)}:${value.slice(11)}:00Z`;
      const ms=Date.parse(iso);
      return Number.isFinite(ms) && new Date(ms).toISOString().slice(0,16)===iso.slice(0,16)?ms:null;
    }
    if(!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value))return null;
    const [year,month,day]=value.slice(0,10).split('-').map(Number),date=new Date(Date.UTC(year,month-1,day));
    if(date.getUTCFullYear()!==year||date.getUTCMonth()+1!==month||date.getUTCDate()!==day)return null;
    return Date.parse(value);
  };
  const field = key => new RegExp(`(?:^|[|;\\s])${key}:([0-9]{8}-[0-9]{4})`).exec(desc)?.[1];
  const resolution=spec.resolutionDeadline ?? question?.resolutionDeadline ?? field('resolutionDeadline');
  const decision=spec.decisionDeadline ?? question?.decisionDeadline ?? field('decisionDeadline');
  const explicit=spec.expiry ?? spec.expiryTime ?? question?.expiry ?? question?.expiryTime ?? field('expiry');
  const final=explicit ?? resolution;
  const times=[final,resolution,decision].filter(v=>v!=null).map(parse);
  if(!times.length || times.some(t=>!Number.isSafeInteger(t))) throw new Error('Market timing unavailable');
  if(times.some(t=>t<=at+3600000)) throw Object.assign(new Error('Market inside safety buffer'),{code:'market_unsuitable'});
  // Scheduled start/decision are not authoritative resolution or admission cutoffs.
  const expiry=Math.min(...times);
  if (spec.settled || spec.isSettled || question?.settledNamedOutcomes?.includes(outcomeId)) throw Object.assign(new Error('Settled outcome'),{code:'market_unsuitable'});
  return {expiry,feeScale,timing:{quoteDeadline:expiry,decisionDeadline:decision==null?null:parse(decision),resolutionDeadline:resolution==null?null:parse(resolution),explicitExpiry:explicit==null?null:parse(explicit)},fingerprint:digest({spec,question,template:meta?.templates?.find(t=>t.id===question?.name),side})};
}
export function bookQuote(book,at,p) {
  const time=num(book?.time);
  const bid=num(book?.levels?.[0]?.[0]?.px), ask=num(book?.levels?.[1]?.[0]?.px);
  if(Number.isSafeInteger(time) && time<=at+1000 && at-time<=5000 && Array.isArray(book?.levels) && book.levels.length===2 && book.levels.every(Array.isArray) && book.levels.some(l=>l.length===0)) throw Object.assign(new Error('No two-sided book'),{code:'no_two_sided_book'});
  if (!Number.isSafeInteger(time) || time>at+1000 || at-time>5000 || bid===null || ask===null) throw Object.assign(new Error('Stale or malformed book'),{code:'book_data_unavailable'});
  if (bid<=0 || ask>=1 || bid>=ask || ask-bid<p.minSpread || bid<p.minPrice || ask>p.maxPrice) throw Object.assign(new Error('Crossed or out-of-corridor book'),{code:'book_unsuitable'});
  return {bid,ask,time};
}
// Shared, unchanged automatic admission arithmetic across all mandatory views.
export function automaticFeeSpreadThreshold(legs) {
  const feeCost=Math.max(...legs.map(l=>l.feeRate*(l.bid+l.ask)));
  return Math.max(0.00001,(Math.ceil(feeCost*100000)+1)/100000);
}
export function feeEvidence(fees,scale) {
  const accountRate=num(fees?.userSpotCrossRate),baseRate=num(fees?.feeSchedule?.spotCross);
  if(accountRate===null || baseRate===null || scale===null || accountRate<0 || baseRate<0 || accountRate>0.02 || baseRate>0.02) throw new Error('Fee rate unknown');
  const makerAccount=num(fees?.userSpotAddRate),makerBase=num(fees?.feeSchedule?.spotAdd);
  if(fees?.userSpotAddRate!=null&&makerAccount===null || fees?.feeSchedule?.spotAdd!=null&&makerBase===null || typeof scale!=='number'||!Number.isFinite(scale)||scale<0||scale>10) throw Error('Maker fee evidence unknown');
  // Outcomes never pay maker rebates: negative rates are clamped to zero cost.
  const rate=2*Math.max(0,accountRate,baseRate,makerAccount??0,makerBase??0)*(scale+Math.max(scale,1));
  if(rate>FEE_RESERVE) throw Object.assign(new Error('Outcome fee exceeds reserve'),{code:'fee_exceeds_reserve'});
  return rate;
}
