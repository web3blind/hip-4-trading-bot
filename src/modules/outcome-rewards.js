// Public payout history endpoint discovered from Outcome-xyz/hip4 SDK config/api.
const BASE = 'https://pd-liquidity-rewards-payouts.outcome-e91.workers.dev';
export async function getOutcomeRewards(address, { fetchImpl = fetch } = {}) {
 if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Invalid account address');
 const r = await fetchImpl(`${BASE}/v1/rewards/${address}`, {
  headers: { Accept:'application/json' }, signal: AbortSignal.timeout(15000), redirect:'error',
 });
 if (!r.ok) throw new Error('Outcome rewards unavailable');
 const data = await r.json();
 if (String(data?.wallet).toLowerCase() !== address.toLowerCase()) throw new Error('Reward account mismatch');
 for (const key of ['paid_usdc','pending_usdc','awarded_usdc']) {
  if (typeof data[key] !== 'string' || !/^\d+(?:\.\d+)?$/.test(data[key])) throw new Error('Invalid reward totals');
 }
 if (!Number.isSafeInteger(data.payments) || data.payments < 0) throw new Error('Invalid reward payments');
 return { paid:data.paid_usdc, pending:data.pending_usdc, awarded:data.awarded_usdc, payments:data.payments };
}
