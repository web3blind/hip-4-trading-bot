import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');

await client.cancelAllOrders();

// Check if @23400 exists in spotUniverse
const meta = await client._infoRequest({ type: 'spotMeta' });
const universe = meta.universe || [];
const found = universe.filter(e => e.name && (e.name.includes('2340') || e.name.includes('2389')));
console.log('Found entries:', found);

// Also check: outcomeMeta outcome 2340 has encoding 10*2340+0 = 23400
// and 10*2340+1 = 23401
// And outcome 2389 has encoding 23890, 23891
// These @-numbers should be in spotUniverse if tradeable

// Let's see if @2340 exists instead of @23400
const found2 = universe.filter(e => e.name && ['@2340', '@2341', '@2389', '@2390'].includes(e.name));
console.log('Found @2340 etc:', found2);

// The encoding formula is different! Let me check the outcomeMeta more carefully
const outMeta = await client.getOutcomeMeta();
console.log('\nOutcomes:');
for (const o of outMeta.outcomes) {
  console.log(`  ID: ${o.outcome}, coins would be: #${10*o.outcome+0}, #${10*o.outcome+1}`);
  // Check if these exist in universe
  const coin0 = `@${10*o.outcome+0}`;
  const coin1 = `@${10*o.outcome+1}`;
  const e0 = universe.find(e => e.name === coin0);
  const e1 = universe.find(e => e.name === coin1);
  console.log(`    ${coin0}: ${e0 ? 'EXISTS' : 'NOT FOUND'}`);
  console.log(`    ${coin1}: ${e1 ? 'EXISTS' : 'NOT FOUND'}`);
}

process.exit(0);
