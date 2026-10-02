import {validateLiquidityPolicy} from './policy.js';
import {assessLiquidityEvent} from './event.js';

/** Telegram-only defaults; explicit MCP policies retain their existing contract. */
export async function automaticLiquidityPolicy(client, inputs, now=Date.now) {
  const policy=validateLiquidityPolicy({...inputs,orderSizeShares:1,minPrice:0.00001,
    maxPrice:0.99999,minSpread:0.00001,
    maxInventoryShares:Math.min(1_000_000,Math.max(1,Math.ceil(inputs.budgetUsdc/0.00001))),
    // Existing hard runaway guard, not a requested trading volume. Duration,
    // cumulative cash, loss and all-member checks remain independently binding.
    maxActions:1000});
  const evidence=await assessLiquidityEvent(client,policy,now);
  if(evidence.suitability==='unavailable' || !evidence.legs.length || evidence.legs.some(l=>l.unavailable) ||
      evidence.reasons.some(r=>r.code==='fees_unavailable' || r.code==='stale_event_snapshot')) {
    const error=new Error('Automatic liquidity evidence unavailable');
    error.assessment=evidence;
    throw error;
  }
  // Worst verified round-trip cost across ALL mandatory books, rounded upward
  // with one additional wire tick. This is a spread admission threshold, not a
  // return forecast. Engine rechecks fresh net spreads and fees before signing.
  const feeCost=Math.max(...evidence.legs.map(l=>l.feeRate*(l.bid+l.ask)));
  const minSpread=Math.max(0.00001,(Math.ceil(feeCost*100000)+1)/100000);
  return validateLiquidityPolicy({...policy,minSpread});
}
