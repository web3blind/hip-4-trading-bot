import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');

// Try spotDeployState for outcome info
try {
  const state = await client._infoRequest({ type: 'spotDeployState', user: '0x0000000000000000000000000000000000000000' });
  console.log('spotDeployState:', JSON.stringify(state, null, 2).slice(0, 2000));
} catch (e) {
  console.log('spotDeployState error:', e.message);
}

// Let's try various tick-size-related queries
// Try getting info about a specific asset
const meta = await client._infoRequest({ type: 'spotMeta' });
const universe = meta.universe || [];

// Look at the outcome-specific entries
for (const entry of universe) {
  if (['@9', '@10', '@11', '@12', '@13'].includes(entry.name)) {
    console.log(`\nEntry ${entry.name}:`, JSON.stringify(entry));
  }
}

// The key insight: let me try sending order at bestAsk price exactly (which must be valid)
// and also check what the valid tick sizes are by trial
console.log('\n\nTrying to determine tick size by trial orders...');

// For #90, bestAsk=0.99. Try various prices:
const testCoin = '#90';
const testPrices = ['0.99', '0.98', '0.9', '0.01', '0.001', '0.05', '0.5', '0.999', '0.990', '0.995'];

for (const px of testPrices) {
  try {
    const result = await client.placeOrder(testCoin, true, px, 12, 'Limit');
    const statuses = result?.response?.data?.statuses || [];
    console.log(`  ${testCoin} @ ${px}: OK - ${JSON.stringify(statuses)}`);
    // Cancel immediately
    const oid = statuses[0]?.resting?.oid;
    if (oid) {
      await client.cancelOrder(testCoin, oid);
    }
  } catch (e) {
    console.log(`  ${testCoin} @ ${px}: ERROR - ${e.message}`);
  }
}

process.exit(0);
