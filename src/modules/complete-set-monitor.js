import { MAX_COMPLETE_SET_LEGS } from './constants.js';
import {getCompleteSetAttempts,updateCompleteSetAttempt,markCompleteSetAttemptNotified} from './database.js';

const validId = v => v != null && /^\d+$/.test(String(v)) ? String(v) : null;
const positive = v => Number.isFinite(Number(v)) && Number(v)>0 ? Number(v) : 0;
const tradeKey = f => f.tid != null ? `tid:${f.tid}` : f.hash && Number.isFinite(Number(f.time)) ? `hash:${f.hash}:${f.time}:${f.sz}` : null;

/** Read-only reconciliation: no retries, no hedges, no exchange writes. */
export async function reconcileCompleteSetAttempts(client, notify, repo={
  list:getCompleteSetAttempts,update:updateCompleteSetAttempt,markNotified:markCompleteSetAttemptNotified,
}) {
  if (!client?.address || typeof client.getOrderStatus!=='function' || typeof client.getUserFills!=='function') return 0;
  // The DB prioritizes active attempts; notified terminal rows never occupy this page.
  const attempts=repo.list(['submitted_unknown','submitting','partial','rejected','filled'],{limit:30,unnotifiedFilled:true});
  if (!attempts.length) return 0;
  const fills=await client.getUserFills(client.address);
  if (!Array.isArray(fills)) throw new Error('Invalid fill response');
  let changed=0;
  for(const attempt of attempts) {
    if (attempt.account?.toLowerCase()!==client.address.toLowerCase() || attempt.network!==client.network ||
        !Array.isArray(attempt.legs) || attempt.legs.length<2 || attempt.legs.length>MAX_COMPLETE_SET_LEGS) continue;
    const legs=[];
    for(const leg of attempt.legs) {
      if(!/^0x[0-9a-f]{32}$/.test(leg.cloid||'')) {legs.push(leg);continue;}
      let exchange;
      try {exchange=await client.getOrderStatus(leg.cloid,attempt.account);} catch {legs.push(leg);continue;}
      if(exchange?.status==='unknownOid' && !leg.oid) {legs.push(leg);continue;}
      const oid=validId(exchange?.order?.order?.oid ?? leg.oid);
      const stored=Array.isArray(leg.trades)?leg.trades:[];
      const trades=new Map(stored.filter(t=>typeof t?.key==='string').map(t=>[t.key,t]));
      for(const f of fills) {
        if (!oid || validId(f.oid ?? f.orderId)!==oid) continue;
        const key=tradeKey(f),sz=positive(f.sz),px=positive(f.px);
        if(!key || !sz || !px || px>=1 || trades.size>=256 && !trades.has(key)) continue;
        trades.set(key,{key,sz,px,fee:Number.isFinite(Number(f.fee))?Number(f.fee):null,feeToken:f.feeToken||null});
      }
      const tradeList=[...trades.values()];
      const recordedSize=tradeList.reduce((n,t)=>n+positive(t.sz),0);
      const filledSize=Math.max(positive(leg.filledSize),recordedSize);
      const economicsComplete=recordedSize+1e-9>=filledSize && filledSize>0;
      const fillCost=economicsComplete?tradeList.reduce((n,t)=>n+t.sz*t.px,0):null;
      const actualFee=economicsComplete && tradeList.every(t=>Number.isFinite(t.fee) && t.feeToken==='USDC')
        ? tradeList.reduce((n,t)=>n+t.fee,0):null;
      const exchangeStatus=exchange?.order?.status;
      legs.push({...leg,oid:oid||leg.oid||null,
        status:filledSize>=Number(leg.size)?'filled':filledSize>0?'partial':
          /cancel|reject|expired/i.test(exchangeStatus||'')?'rejected':exchangeStatus==='open'?'resting':leg.status==='filled'?'filled':'unknown',
        filledSize,fillCost,actualFee,trades:tradeList});
    }
    let state=legs.every(l=>l.status==='filled' && positive(l.filledSize)>=Number(l.size))?'filled':
      legs.some(l=>positive(l.filledSize)>0)?'partial':
      legs.every(l=>l.status==='rejected')?'rejected':'submitted_unknown';
    if(attempt.state==='filled') state='filled';
    if(state!==attempt.state || JSON.stringify(legs)!==JSON.stringify(attempt.legs)) {repo.update(attempt.id,state,legs);changed++;}
    if(typeof notify==='function' && ['partial','filled','rejected'].includes(state) && attempt.notified_state!==state) {
      const delivered=await notify({id:attempt.id,questionId:attempt.question_id,state,legs});
      if(delivered) repo.markNotified(attempt.id,state);
    }
  }
  return changed;
}
