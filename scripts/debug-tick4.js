import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');

// Cancel any leftover orders
await client.cancelAllOrders();

// Now test specific decimal precision prices for #90
console.log('Testing tick sizes for #90:');
const testCases = [
  { px: '0.999', expect: 'ok' },
  { px: '0.9999', expect: '?' },
  { px: '0.99999', expect: '?' },
  { px: '0.999999', expect: '?' },
  { px: '0.9995', expect: '?' },
  { px: '0.9991', expect: '?' },
];

for (const tc of testCases) {
  try {
    const result = await client.placeOrder('#90', true, tc.px, 12, 'Limit');
    const statuses = result?.response?.data?.statuses || [];
    const oid = statuses[0]?.resting?.oid;
    console.log(`  #90 @ ${tc.px}: OK`);
    if (oid) await client.cancelOrder('#90', oid);
  } catch (e) {
    console.log(`  #90 @ ${tc.px}: ERROR - ${e.message}`);
  }
}

// Test #100 (Akami YES) - asks at 0.25758
console.log('\nTesting tick sizes for #100:');
const testCases100 = [
  { px: '0.26' },
  { px: '0.258' },
  { px: '0.2576' },
  { px: '0.25758' },
  { px: '0.257' },
  { px: '0.2575' },
  { px: '0.2580' },
  { px: '0.26162' },
];

for (const tc of testCases100) {
  try {
    const result = await client.placeOrder('#100', true, tc.px, 50, 'Limit');
    const statuses = result?.response?.data?.statuses || [];
    const oid = statuses[0]?.resting?.oid || statuses[0]?.filled?.oid;
    console.log(`  #100 @ ${tc.px}: OK - ${JSON.stringify(statuses)}`);
    if (oid) await client.cancelOrder('#100', oid);
  } catch (e) {
    console.log(`  #100 @ ${tc.px}: ERROR - ${e.message}`);
  }
}

// Also test #111
console.log('\nTesting tick sizes for #111:');
const testCases111 = [
  { px: '0.51' },
  { px: '0.515' },
  { px: '0.5149' },
  { px: '0.51486' },
  { px: '0.5148' },
  { px: '0.525' },
  { px: '0.52' },
];

for (const tc of testCases111) {
  try {
    const result = await client.placeOrder('#111', true, tc.px, 25, 'Limit');
    const statuses = result?.response?.data?.statuses || [];
    const oid = statuses[0]?.resting?.oid || statuses[0]?.filled?.oid;
    console.log(`  #111 @ ${tc.px}: OK - ${JSON.stringify(statuses)}`);
    if (oid) await client.cancelOrder('#111', oid);
  } catch (e) {
    console.log(`  #111 @ ${tc.px}: ERROR - ${e.message}`);
  }
}

await client.cancelAllOrders();
process.exit(0);
