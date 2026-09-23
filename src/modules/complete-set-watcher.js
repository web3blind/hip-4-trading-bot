import {completeSetQuestions,quoteCompleteSet} from './complete-set.js';
import {getCompleteSetFeeEvidence} from './complete-set-fees.js';
import {getCompleteSetAlertState,updateCompleteSetAlertState} from './database.js';

/** Read-only scan; SQLite dedup survives restart. Two negative scans re-arm an alert. */
export function createCompleteSetWatcher({onAlert,now=()=>Date.now(),cooldownMs=30*60_000,
  alerts={get:getCompleteSetAlertState,put:updateCompleteSetAlertState}}={}) {
  return async function scan(client,{enabled=false,budget=100}={}) {
    if (!enabled || !client || typeof onAlert!=='function') return 0;
    const [meta,templates,fees]=await Promise.all([client.getOutcomeMeta(),client.getOutcomeTemplates(),client.getUserFees()]);
    const eligible=completeSetQuestions(meta,templates,now());
    let count=0;
    for(const q of eligible) {
      let quote;
      try {
        const feeEvidence=await getCompleteSetFeeEvidence(client,q,now(),fees);
        quote=await quoteCompleteSet(client,q,budget,{now:now(),feeEvidence});
      } catch {continue;} // Network errors do not reset dedup.
      const state=alerts.get(q.question);
      if(!quote) {
        const misses=state.miss_count+1;
        alerts.put(q.question,state.last_alert_at,misses,misses<2?state.active:0);
        continue;
      }
      if(state.active && now()-state.last_alert_at<cooldownMs) {
        if(state.miss_count)alerts.put(q.question,state.last_alert_at,0,1);
        continue;
      }
      let delivered=false;
      try {delivered=await onAlert(q,quote);} catch {/* Retry later. */}
      if(delivered) {alerts.put(q.question,now(),0,1);count++;}
    }
    return count;
  };
}
