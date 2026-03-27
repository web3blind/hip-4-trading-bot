import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const W = process.stderr.write.bind(process.stderr);
const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');
const addr = client.getAddress();

// Cancel any old orders
await client.cancelAllOrders();

const coin = '#90'; // Hypurr YES
const assetId = await client._resolveSpotAssetIndex(coin);
W(`Asset ID for ${coin}: ${assetId}\n`);

const book = await client.getOrderbook(coin);
const [bids, asks] = book?.levels || [[], []];
W(`Asks: ${asks.slice(0,3).map(a=>`${a.px}x${a.sz}`).join(', ')}\n`);
W(`Bids: ${bids.slice(0,3).map(b=>`${b.px}x${b.sz}`).join(', ')}\n`);

const bestAsk = Number(asks[0]?.px);
W(`bestAsk: ${bestAsk}\n\n`);

// Test 1: Limit buy at bestAsk — should FILL now
W('=== Test 1: Limit buy at bestAsk ===\n');
try {
  const result = await client.placeOrder(coin, true, bestAsk, 20, 'Limit');
  const s = result?.response?.data?.statuses?.[0];
  if (s?.filled) W(`FILLED! ${s.filled.totalSz} @ ${s.filled.avgPx}\n`);
  else if (s?.resting) W(`RESTING: oid=${s.resting.oid}\n`);
  else W(`${JSON.stringify(s)}\n`);
} catch (e) {
  W(`Error: ${e.message}\n`);
}

// Test 2: Market buy via placeMarketOrder
W('\n=== Test 2: Market buy (placeMarketOrder) ===\n');
try {
  const result2 = await client.placeMarketOrder(coin, true, 20);
  const s2 = result2?.response?.data?.statuses?.[0];
  if (s2?.filled) W(`FILLED! ${s2.filled.totalSz} @ ${s2.filled.avgPx}\n`);
  else if (s2?.resting) W(`RESTING: oid=${s2.resting.oid}\n`);
  else W(`${JSON.stringify(s2)}\n`);
} catch (e) {
  W(`Error: ${e.message}\n`);
}

// Check positions
W('\n=== Balances after ===\n');
const bal = await client.getUserBalances(addr);
for (const b of (bal?.balances || [])) {
  W(`  ${b.coin}: ${b.total}\n`);
}

// Cleanup
await client.cancelAllOrders();
W('\nDone.\n');
process.exit(0);
