import {completeSetQuestions,quoteCompleteSet} from './complete-set.js';
import {getCompleteSetFeeEvidence} from './complete-set-fees.js';
import {getCompleteSetAlertState,updateCompleteSetAlertState,getPendingCompleteSetQuestionIds} from './database.js';

const heldOutcomeIds = balances => {
  if (!Array.isArray(balances?.balances)) throw new Error('Invalid user balance response');
  const ids=new Set();
  for(const b of balances.balances) {
    const match=/^[#+](\d+)0$/.exec(String(b?.coin ?? ''));
    if (!match) continue;
    if (typeof b.total!=='string' || !/^\d+(?:\.\d+)?$/.test(b.total) || !Number.isFinite(Number(b.total)))
      throw new Error('Invalid outcome balance');
    if(Number(b.total)>0.0001) ids.add(Number(match[1]));
  }
  return ids;
};

/** Read-only scan; no duplicate quotes or proposals on already-held questions. */
export function createCompleteSetWatcher({onAlert,now=()=>Date.now(),cooldownMs=30*60_000,
  alerts={get:getCompleteSetAlertState,put:updateCompleteSetAlertState},
  pending=getPendingCompleteSetQuestionIds}={}) {
  return async function scan(client,{enabled=false,budget=100}={}) {
    if (!enabled || !client || typeof onAlert!=='function') return 0;
    if (!/^0x[0-9a-fA-F]{40}$/.test(client.address || '') ||
        !['mainnet','testnet'].includes(client.network) || typeof client.getUserBalances!=='function') return 0;
    // Failed or malformed live balances must never be interpreted as 'no holdings'.
    const [meta,templates,fees,balances]=await Promise.all([
      client.getOutcomeMeta(),client.getOutcomeTemplates(),client.getUserFees(),client.getUserBalances(client.address)]);
    const held=heldOutcomeIds(balances);
    const pendingQuestions=pending(client.address,client.network);
    if (!(pendingQuestions instanceof Set)) throw new Error('Invalid pending attempt response');
    const eligible=completeSetQuestions(meta,templates,now());
    let count=0;
    for(const q of eligible) {
      if (pendingQuestions.has(q.question) || [...q.namedOutcomes,q.fallbackOutcome].some(id=>held.has(id)))
        continue; // Don't reset dedup while the owner's question is active.
      let quote;
      try {
        const feeEvidence=await getCompleteSetFeeEvidence(client,q,now(),fees);
        quote=await quoteCompleteSet(client,q,budget,{now:now(),feeEvidence});
      } catch {continue;} // Network errors do not reset dedup.
      const state=alerts.get(q.question);
      if(!quote) {
        const misses=state.miss_count+1;
        alerts.put(q.question,state.last_alert_at,misses,misses<2?state.active:0,state.last_net_floor);
        continue;
      }
      if (now()-state.last_alert_at<cooldownMs) continue;
      const old=state.last_net_floor;
      if (state.active && (old===null || old===undefined ||
          quote.netLowerBound-old<Math.max(0.05,old*0.1)-1e-9)) {
        if(state.miss_count) alerts.put(q.question,state.last_alert_at,0,1,old);
        continue;
      }
      let delivered=false;
      try {delivered=await onAlert(q,quote);} catch {/* Retry later. */}
      if(delivered) {alerts.put(q.question,now(),0,1,quote.netLowerBound);count++;}
    }
    return count;
  };
}
