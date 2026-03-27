import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const W = process.stderr.write.bind(process.stderr);
const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');
const addr = client.getAddress();

// Check all balance types
W('=== spotClearinghouseState ===\n');
const spotBal = await client._infoRequest({ type: 'spotClearinghouseState', user: addr });
W(JSON.stringify(spotBal, null, 2) + '\n');

W('\n=== clearinghouseState (perps) ===\n');
const perpBal = await client._infoRequest({ type: 'clearinghouseState', user: addr });
W(`marginSummary: ${JSON.stringify(perpBal?.marginSummary)}\n`);

// Try usdClassTransfer: move USDH from spot to perps, then maybe outcomes use perp balance?
W('\n=== Try usdClassTransfer spot->perp ===\n');
try {
  // The action format for usdClassTransfer
  const action = {
    type: 'usdClassTransfer',
    amount: '100',      // 100 USDH
    toPerp: true,       // spot -> perp
  };
  
  const nonce = Date.now();
  // Need to sign this — but it's a different action type than order
  // For now, try raw exchange request to see the format
  
  // Actually, let me check if maybe the issue is szDecimals
  // Let's try with size that's a round number and larger value
  W('\n=== Try order with size=100 (value $99 USDH) ===\n');
  const r = await client.placeOrder('#90', true, 0.5, 100, 'Limit');
  W(`Result: ${JSON.stringify(r?.response?.data?.statuses)}\n`);
} catch (e) {
  W(`Error: ${e.message}\n`);
}

// Maybe the issue is that szDecimals for outcome is 0 (integer only)?
W('\n=== Try with different sizes to find szDecimals ===\n');
for (const sz of [10, 11, 15, 20, 100]) {
  try {
    const r = await client.placeOrder('#90', true, 0.5, sz, 'Limit');
    const s = r?.response?.data?.statuses?.[0];
    W(`  size=${sz}: ${JSON.stringify(s)}\n`);
    if (s?.resting) await client.cancelAllOrders();
  } catch (e) {
    W(`  size=${sz}: ${e.message}\n`);
  }
}

process.exit(0);
