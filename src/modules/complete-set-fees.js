import {createHash} from 'node:crypto';

/** Conservative settlement-fee ceiling for HIP-4 outcome tokens.
 * Hyperliquid: outcome positions pay fees on closing/settlement; deployer scale
 * multiplies the base outcome rate by scale+max(scale,1). Use twice the larger
 * of account spot-cross rate and published base spot-cross rate to leave room
 * for fee interpretation/rounding; never use a fee discount to increase edge.
 */
export async function getCompleteSetFeeEvidence(client, question, now=Date.now(), userFees=null) {
  if (typeof client?.getUserFees!=='function' || !Array.isArray(question?.outcomes) || !client.address) return null;
  const fees=userFees ?? await client.getUserFees();
  const accountRate=Number(fees?.userSpotCrossRate), baseRate=Number(fees?.feeSchedule?.spotCross);
  const scale=Number(question.outcomes[0]?.deployerFeeScale);
  if (!Number.isFinite(accountRate) || accountRate<0 || accountRate>0.02 ||
      !Number.isFinite(baseRate) || baseRate<0 || baseRate>0.02 ||
      !Number.isFinite(scale) || scale<0 || scale>10 ||
      !question.outcomes.every(o=>Number(o.deployerFeeScale)===scale)) return null;
  const rate=2 * Math.max(accountRate,baseRate) * (scale+Math.max(scale,1));
  if (!Number.isFinite(rate) || rate<0 || rate>=0.5) return null;
  const source='https://api.hyperliquid.xyz/info:userFees+outcomeMeta';
  const account=String(client.address).toLowerCase(),network=client.network;
  const digest=createHash('sha256')
    .update(JSON.stringify([source,account,network,accountRate,baseRate,scale,rate]))
    .digest('hex');
  return {rate,account,network,scale,digest,observedAt:now,expiresAt:now+30_000,
    source,assumption:'2x max(account spot cross, schedule spot cross) times deployer scale; settlement ceiling'};
}
export function feeEvidenceValid(evidence, client, now=Date.now()) {
  return evidence?.source==='https://api.hyperliquid.xyz/info:userFees+outcomeMeta' &&
    evidence.account===String(client?.address||'').toLowerCase() && evidence.network===client?.network &&
    /^[0-9a-f]{64}$/.test(evidence.digest||'') &&
    Number.isFinite(evidence.rate) && evidence.rate>=0 && evidence.rate<0.5 &&
    Number.isFinite(evidence.observedAt) && now>=evidence.observedAt && now<evidence.expiresAt;
}
