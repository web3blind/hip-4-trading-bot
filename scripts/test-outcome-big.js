import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const W = process.stderr.write.bind(process.stderr);
const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');

const coin = '#90';
const outcomeAssetId = 100_000_090;

// Try various sizes
const bestAsk = 0.99;

for (const size of [20, 50, 100, 11]) {
  W(`\nTrying size=${size} price=${bestAsk} value=${(size*bestAsk).toFixed(2)} USDH\n`);
  client._resolveSpotAssetIndex = async () => outcomeAssetId;
  try {
    const result = await client.placeOrder(coin, true, bestAsk, size, 'Limit');
    const s = result?.response?.data?.statuses?.[0];
    W(`  Result: ${JSON.stringify(s)}\n`);
    if (s?.resting || s?.filled) {
      await client.cancelAllOrders();
      W(`  (cancelled)\n`);
    }
  } catch (e) {
    W(`  Error: ${e.message}\n`);
  }
}

// Try with mid price instead of bestAsk
W(`\n--- Try at mid price 0.5 with big size ---\n`);
client._resolveSpotAssetIndex = async () => outcomeAssetId;
try {
  const result = await client.placeOrder(coin, true, 0.5, 25, 'Limit');
  const s = result?.response?.data?.statuses?.[0];
  W(`  Result: ${JSON.stringify(s)}\n`);
  if (s?.resting || s?.filled) {
    await client.cancelAllOrders();
  }
} catch (e) {
  W(`  Error: ${e.message}\n`);
}

// Also try szDecimals = 0 (whole numbers only?)
W(`\n--- Try integer size ---\n`);
client._resolveSpotAssetIndex = async () => outcomeAssetId;
try {
  const result = await client.placeOrder(coin, true, 0.5, 100, 'Limit');
  const s = result?.response?.data?.statuses?.[0];
  W(`  Result: ${JSON.stringify(s)}\n`);
  if (s?.resting || s?.filled) {
    await client.cancelAllOrders();
  }
} catch (e) {
  W(`  Error: ${e.message}\n`);
}

process.exit(0);
