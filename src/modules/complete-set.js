import { toCoin, SIDES } from './hl-encoding.js';
import { completeSetQuestions } from './complete-set-rules.js';
import { feeEvidenceValid } from './complete-set-fees.js';
export { completeSetQuestions };

const MIN_NOTIONAL=10, MAX_SHARES=5000;
function asksFromBook(book) {
  const asks=book?.levels?.[1];if (!Array.isArray(asks) || !asks.length) return null;
  let last=0;const result=[];
  for (const level of asks) {
    const price=Number(level?.px),size=Number(level?.sz);
    if (!Number.isFinite(price) || price<=0 || price>=1 || !Number.isFinite(size) || size<=0 || price<last) return null;
    result.push({price,size});last=price;
  }
  return result;
}
function depthCost(levels,shares) {
  let remaining=shares,cost=0,limitPrice=0;
  for (const level of levels) {
    const take=Math.min(remaining,level.size);
    cost+=take*level.price;remaining-=take;
    if (take>0) limitPrice=level.price;
    if (remaining<=0) return {cost,limitPrice};
  }
  return null;
}
/** Read-only verified rules+fees+depth quote. A positive gross gap alone is ineligible. */
export async function quoteCompleteSet(client, question, budget, {now=Date.now(),feeEvidence,minNetMargin=0.005,minNetProfit=0.10,shares:fixedShares=null}={}) {
  const legCount=question?.outcomes?.length;
  if (!Number.isSafeInteger(legCount) || legCount<2 || legCount>8 ||
      !Number.isSafeInteger(question?.question) || !/^[0-9a-f]{64}$/.test(question?.ruleDigest||'') ||
      question.coveredIds?.length!==legCount || !feeEvidenceValid(feeEvidence,client,now) ||
      Number(client.builder?.f??0)!==0 ||
      !Number.isFinite(budget) || budget<legCount*MIN_NOTIONAL || budget>100_000 ||
      !Number.isFinite(minNetMargin) || minNetMargin<=0 || minNetMargin>=0.1 ||
      !Number.isFinite(minNetProfit) || minNetProfit<=0 || minNetProfit>100 ||
      (fixedShares!==null && (!Number.isSafeInteger(fixedShares) || fixedShares<1 || fixedShares>MAX_SHARES))) return null;
  const coins=question.outcomes.map(o=>toCoin(o.outcome,SIDES.YES));
  const levels=await Promise.all(coins.map(async coin=>asksFromBook(await client.getOrderbook(coin))));
  if (levels.some(l=>!l)) return null;
  const maxShares=Math.min(MAX_SHARES,...levels.map(l=>Math.floor(l.reduce((n,x)=>n+x.size,0))));
  let best=null;
  for (let shares=fixedShares??1;shares<=(fixedShares??maxShares);shares++) {
    const legs=levels.map(l=>depthCost(l,shares));
    if (legs.some(l=>!l || l.cost+1e-8<MIN_NOTIONAL)) continue;
    const worstCost=legs.reduce((n,l)=>n+l.limitPrice*shares,0);
    const net=shares-worstCost-shares*feeEvidence.rate;
    if (net<Math.max(minNetProfit,shares*minNetMargin)-1e-8 || worstCost*1.01>budget+1e-8) continue;
    if (!best || net>best.net) best={shares,legs,net,expectedCost:legs.reduce((n,l)=>n+l.cost,0)};
  }
  if (!best) return null;
  const orders=await Promise.all(coins.map((coin,i)=>client.prepareOrder({coin,isBuy:true,price:best.legs[i].limitPrice,size:best.shares,orderType:'Market'})));
  if (orders.some(o=>o.size!==best.shares || !Number.isFinite(o.price) || o.price*o.size<MIN_NOTIONAL || !Number.isFinite(o.maxSpend))) return null;
  const maxSpend=orders.reduce((n,o)=>n+o.maxSpend,0),worstCost=orders.reduce((n,o)=>n+o.price*o.size,0);
  const feeMax=best.shares*feeEvidence.rate,netLowerBound=best.shares-worstCost-feeMax;
  if (maxSpend>budget+1e-8 || netLowerBound<Math.max(minNetProfit,best.shares*minNetMargin)-1e-8) return null;
  return {questionId:question.question,ids:question.coveredIds,name:question.description,coverage:question.coverage,
    ruleDigest:question.ruleDigest,feeEvidence,shares:best.shares,cost:best.expectedCost,gross:best.shares-best.expectedCost,
    worstGross:best.shares-worstCost,netLowerBound,feeMax,maxSpend,worstCost,orders,estimatedAt:now};
}
