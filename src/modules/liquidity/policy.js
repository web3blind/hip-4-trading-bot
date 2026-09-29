import { coinToOutcome } from '../hl-encoding.js';

const keys = ['mode','coin','account','network','durationMinutes','budgetUsdc','maxInventoryShares','orderSizeShares','minPrice','maxPrice','minSpread','maxLossUsdc','maxActions'];
const bounds = { durationMinutes:[1,1440], budgetUsdc:[10,100000], maxInventoryShares:[1,1000000], orderSizeShares:[1,1000000], minPrice:[0.00001,0.99998], maxPrice:[0.00002,0.99999], minSpread:[0.00001,0.5], maxLossUsdc:[0.01,100000], maxActions:[1,1000] };
export function validateLiquidityPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      Object.keys(value).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(value,k))) throw new Error('Invalid liquidity policy fields');
  if (!['observe','live'].includes(value.mode) || !/^#[0-9]+$/.test(value.coin)) throw new Error('Invalid mode or canonical coin');
  coinToOutcome(value.coin);
  if (!/^0x[0-9a-fA-F]{40}$/.test(value.account) || !['mainnet','testnet'].includes(value.network)) throw new Error('Invalid account/network');
  for (const [k,[lo,hi]] of Object.entries(bounds)) if (typeof value[k] !== 'number' || !Number.isFinite(value[k]) || value[k] < lo || value[k] > hi) throw new Error(`Invalid ${k}`);
  if (!Number.isInteger(value.durationMinutes) || !Number.isInteger(value.maxActions) || value.minPrice >= value.maxPrice || value.orderSizeShares > value.maxInventoryShares || value.maxLossUsdc > value.budgetUsdc) throw new Error('Inconsistent liquidity bounds');
  return Object.freeze({ ...value, account:value.account.toLowerCase() });
}
