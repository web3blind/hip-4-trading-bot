import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const W = process.stderr.write.bind(process.stderr);
const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');

// Cancel everything first
W('Cancelling all existing orders...\n');
await client.cancelAllOrders();

// Wait a sec
await new Promise(r => setTimeout(r, 2000));

const coin = '#100'; // Akami YES — different market, less likely we polluted it
const book = await client.getOrderbook(coin);
const [bids, asks] = book?.levels || [[], []];
W(`\n${coin} orderbook:\n`);
W(`  Asks: ${asks.slice(0, 3).map(a => `${a.px}x${a.sz}`).join(', ')}\n`);
W(`  Bids: ${bids.slice(0, 3).map(b => `${b.px}x${b.sz}`).join(', ')}\n`);

if (!asks.length) { W('No asks — cannot test\n'); process.exit(0); }

const bestAsk = Number(asks[0].px);
const szDec = await client._getSzDecimals(coin);
const size = Math.floor((11 / bestAsk) * Math.pow(10, szDec)) / Math.pow(10, szDec);

W(`\nBuy at exact bestAsk=${bestAsk}, size=${size}\n`);
try {
  const r = await client.placeOrder(coin, true, bestAsk, size, 'Limit');
  const s = r?.response?.data?.statuses?.[0];
  if (s?.filled) {
    W(`FILLED! totalSz=${s.filled.totalSz} avgPx=${s.filled.avgPx}\n`);
  } else if (s?.resting) {
    W(`RESTING: oid=${s.resting.oid} — order did NOT fill immediately\n`);
  } else {
    W(`Other: ${JSON.stringify(s)}\n`);
  }
} catch (e) {
  W(`Error: ${e.message}\n`);
}

// Cleanup
await client.cancelAllOrders();
process.exit(0);
