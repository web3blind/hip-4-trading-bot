import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const W = process.stderr.write.bind(process.stderr);
const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');
const addr = client.getAddress();

// Cancel any leftover orders
await client.cancelAllOrders();
await new Promise(r => setTimeout(r, 1000));

const coin = '#90'; // Hypurr YES
W(`\n=== Investigating why market buy on ${coin} rests instead of filling ===\n\n`);

// 1. Check orderbook
const book = await client.getOrderbook(coin);
const [bids, asks] = book?.levels || [[], []];
W(`Orderbook ${coin}:\n`);
W(`  Asks: ${asks.slice(0,5).map(a => `${a.px}x${a.sz}(n=${a.n})`).join(', ')}\n`);
W(`  Bids: ${bids.slice(0,5).map(b => `${b.px}x${b.sz}(n=${b.n})`).join(', ')}\n`);

if (!asks.length) { W('No asks!\n'); process.exit(0); }

const bestAsk = Number(asks[0].px);
W(`\nbestAsk = ${bestAsk}\n`);

// 2. Check our own open orders — maybe WE are the ask?
const openOrders = await client.getOpenOrders(addr);
W(`\nOur open orders: ${JSON.stringify(openOrders)}\n`);

// 3. Test: place IOC buy at bestAsk — does HL accept IOC at all?
W(`\n--- Test IOC at bestAsk ---\n`);
const szDec = await client._getSzDecimals(coin);
const size = Math.floor((11 / bestAsk) * Math.pow(10, szDec)) / Math.pow(10, szDec);

try {
  // Direct placeOrder with IOC tif
  const assetIndex = await client._resolveSpotAssetIndex(coin);
  W(`assetIndex=${assetIndex}, size=${size}, price=${bestAsk}\n`);
  
  const result = await client.placeOrder(coin, true, bestAsk, size, 'Market'); // Market = IOC
  const s = result?.response?.data?.statuses?.[0];
  W(`IOC result: ${JSON.stringify(s)}\n`);
} catch (e) {
  W(`IOC error: ${e.message}\n`);
}

// 4. Test: GTC at bestAsk — rests or fills?
W(`\n--- Test GTC at exact bestAsk ---\n`);
try {
  const result2 = await client.placeOrder(coin, true, bestAsk, size, 'Limit');
  const s2 = result2?.response?.data?.statuses?.[0];
  W(`GTC at bestAsk result: ${JSON.stringify(s2)}\n`);
  if (s2?.resting) {
    W(`RESTING — the ask is probably our own order or maker is same address\n`);
  }
  if (s2?.filled) {
    W(`FILLED! totalSz=${s2.filled.totalSz} avgPx=${s2.filled.avgPx}\n`);
  }
} catch (e) {
  W(`GTC error: ${e.message}\n`);
}

// 5. Check who the ask belongs to
W(`\n--- Checking if we own the asks ---\n`);
const orders2 = await client.getOpenOrders(addr);
const ourAsks = orders2?.filter(o => {
  const c = (o.coin || '').replace('@', '#');
  return c === coin && o.side === 'A';
});
W(`Our asks on ${coin}: ${JSON.stringify(ourAsks)}\n`);

// Cleanup
await client.cancelAllOrders();
W(`\nCleaned up.\n`);
process.exit(0);
