import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const W = process.stderr.write.bind(process.stderr);
const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');

const coin = '#110';
const book = await client.getOrderbook(coin);
const [bids, asks] = book?.levels || [[], []];
const bestAsk = Number(asks[0].px);
const bestAskSz = Number(asks[0].sz);

W(`bestAsk: ${bestAsk} x ${bestAskSz}\n`);

// Test 1: buy at EXACT bestAsk price — should fill immediately
W(`\n--- Test 1: buy at exact bestAsk ${bestAsk} ---\n`);
try {
  const size = await client._roundSize(coin, 11 / bestAsk);
  const r1 = await client.placeOrder(coin, true, bestAsk, size, 'Limit');
  const s1 = r1?.response?.data?.statuses?.[0];
  W(`Result: ${JSON.stringify(s1)}\n`);
} catch (e) {
  W(`Error: ${e.message}\n`);
}

// Test 2: buy at bestAsk + 2% — current market order behavior
W(`\n--- Test 2: buy at bestAsk+2% = ${(bestAsk * 1.02).toFixed(5)} ---\n`);
try {
  const price2 = parseFloat((bestAsk * 1.02).toFixed(5));
  const size2 = await client._roundSize(coin, 11 / bestAsk);
  const r2 = await client.placeOrder(coin, true, price2, size2, 'Limit');
  const s2 = r2?.response?.data?.statuses?.[0];
  W(`Result: ${JSON.stringify(s2)}\n`);
} catch (e) {
  W(`Error: ${e.message}\n`);
}

// Cleanup
W(`\n--- Cleanup ---\n`);
const cr = await client.cancelAllOrders();
W(`cancelAll: ${JSON.stringify(cr?.response?.data)}\n`);

process.exit(0);
