import { ethers } from 'ethers';
import { HL_API } from './constants.js';

export const OUTCOME_BUILDER = '0xab5dbc057628bc18523c4cdfc0e1e2ebdbecb704';

const result = (status) => ({
  enabled: status === 'approved',
  status,
  builder: OUTCOME_BUILDER,
  fee: 0,
});

async function info(fetchImpl, body, timeoutMs) {
  const response = await fetchImpl(HL_API.MAINNET_INFO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('Builder approval info unavailable');
  return response.json();
}

/**
 * Read-only Outcome builder verification. A zero maxBuilderFee alone is not
 * proof of approval: Hyperliquid can also return zero for an unapproved pair.
 */
export async function verifyOutcomeBuilderApproval({ accountAddress, network, fetchImpl = fetch, timeoutMs = 15000 }) {
  if (!['mainnet', 'testnet'].includes(network)) throw new Error('Invalid network');
  if (!ethers.utils.isAddress(accountAddress) || accountAddress.toLowerCase() === ethers.constants.AddressZero) {
    throw new Error('Invalid owner account');
  }
  if (network !== 'mainnet') return result('mainnet_only');

  try {
    const user = ethers.utils.getAddress(accountAddress);
    const [maxFee, builders] = await Promise.all([
      info(fetchImpl, { type: 'maxBuilderFee', user, builder: OUTCOME_BUILDER }, timeoutMs),
      info(fetchImpl, { type: 'approvedBuilders', user }, timeoutMs),
    ]);
    if (typeof maxFee !== 'number' || !Number.isFinite(maxFee) || maxFee < 0) return result('unavailable');
    if (!Array.isArray(builders) || builders.some(address => typeof address !== 'string' || !ethers.utils.isAddress(address))) {
      return result('unavailable');
    }
    const listed = builders.some(address => address.toLowerCase() === OUTCOME_BUILDER);
    if (!listed) return result('not_approved');
    // The approval is a *maximum*, not the fee this bot charges. A higher
    // ceiling still permits an order whose explicit builder fee is zero.
    return result('approved');
  } catch {
    return result('unavailable');
  }
}

export function outcomeBuilderStatusKey(status) {
  return ({
    approved: 'outcome_builder_approved',
    not_approved: 'outcome_builder_not_approved',
    unavailable: 'outcome_builder_unavailable',
    mainnet_only: 'outcome_builder_mainnet_only',
  })[status] || 'outcome_builder_unavailable';
}
