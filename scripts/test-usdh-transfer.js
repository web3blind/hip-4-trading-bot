import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const amount = Number(process.argv[2] || '10');
const direction = String(process.argv[3] || 'toPerp');
const toPerp = direction !== 'toSpot';

if (!Number.isFinite(amount) || amount <= 0) {
  throw new Error('Usage: node scripts/test-usdh-transfer.js <amount> [toPerp|toSpot]');
}

const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');
const addr = client.getAddress();

console.error(`Address: ${addr}`);
console.error(`Direction: ${toPerp ? 'spot -> perp' : 'perp -> spot'}`);
console.error(`Amount: ${amount}`);

const beforeSpot = await client.getUserBalances(addr);
const beforePerp = await client._infoRequest({ type: 'clearinghouseState', user: addr });
console.error('Before spot:', JSON.stringify(beforeSpot, null, 2));
console.error('Before perp:', JSON.stringify(beforePerp, null, 2));

const result = await client.transferUsdClass(amount, toPerp);
console.error('Transfer result:', JSON.stringify(result, null, 2));

const afterSpot = await client.getUserBalances(addr);
const afterPerp = await client._infoRequest({ type: 'clearinghouseState', user: addr });
console.error('After spot:', JSON.stringify(afterSpot, null, 2));
console.error('After perp:', JSON.stringify(afterPerp, null, 2));
