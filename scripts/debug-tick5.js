import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');

// Cancel any leftover orders
await client.cancelAllOrders();

// Focus on finding the exact tick size rules
// Let's test #90 with 5 vs 6 decimals
// For price 0.99: that's 2 digits. 
// 0.999: 3 digits. 0.9999: 4. 0.99999: 5. 0.999999: 6 -> FAIL

// Test #110 to understand what precision works there
console.log('Testing tick precision for #110 (szDecimals=2):');
const tests = [
  '0.66',      // 2 decimals
  '0.663',     // 3 decimals  (this worked before!)
  '0.6630',    // 3 decimals (trailing 0 removed)
  '0.6631',    // 4 decimals
  '0.66310',   // 5 decimals (trailing 0 removed = 4)
  '0.66312',   // 5 decimals
  '0.663120',  // 5 decimals (trailing 0)
  '0.663125',  // 6 decimals -> should this fail?
];

for (const px of tests) {
  try {
    const result = await client.placeOrder('#110', true, px, 20, 'Limit');
    const statuses = result?.response?.data?.statuses || [];
    const oid = statuses[0]?.resting?.oid || statuses[0]?.filled?.oid;
    console.log(`  #110 @ ${px}: OK`);
    if (oid) await client.cancelOrder('#110', oid);
  } catch (e) {
    console.log(`  #110 @ ${px}: ERROR - ${e.message}`);
  }
}

// And #100 in a valid price range (above the 80% threshold)
console.log('\nTesting tick precision for #100 (valid price range):');
const tests100 = [
  '0.26',      // 2 decimals
  '0.261',     // 3 decimals
  '0.2616',    // 4 decimals
  '0.26162',   // 5 decimals (this worked!)
  '0.261620',  // 5 after trailing 0 removal
  '0.261625',  // 6 decimals -> ?
  '0.262732',  // 6 decimals -> this was our failing price
];

for (const px of tests100) {
  try {
    const result = await client.placeOrder('#100', true, px, 50, 'Limit');
    const statuses = result?.response?.data?.statuses || [];
    const oid = statuses[0]?.resting?.oid || statuses[0]?.filled?.oid;
    console.log(`  #100 @ ${px}: OK`);
    if (oid) await client.cancelOrder('#100', oid);
  } catch (e) {
    console.log(`  #100 @ ${px}: ERROR - ${e.message}`);
  }
}

await client.cancelAllOrders();
process.exit(0);
