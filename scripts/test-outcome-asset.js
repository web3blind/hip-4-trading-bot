import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const W = process.stderr.write.bind(process.stderr);
const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');

// Override asset resolution to use outcome asset ID
const coin = '#90';
const encoding = 90; // 10 * outcomeId(9) + side(0)
const outcomeAssetId = 100_000_000 + encoding;

W(`Testing outcome asset ID: ${outcomeAssetId}\n`);
W(`Coin: ${coin}\n`);

// Check orderbook
const book = await client.getOrderbook(coin);
const [bids, asks] = book?.levels || [[], []];
W(`Asks: ${asks.slice(0,3).map(a=>`${a.px}x${a.sz}`).join(', ')}\n`);
W(`Bids: ${bids.slice(0,3).map(b=>`${b.px}x${b.sz}`).join(', ')}\n`);

if (!asks.length) { W('No asks\n'); process.exit(0); }

const bestAsk = Number(asks[0].px);
W(`bestAsk: ${bestAsk}\n`);

// Place buy at bestAsk with outcome asset ID  
const size = 20; // enough for $10+ at 0.5 price
W(`\nPlacing buy: asset=${outcomeAssetId} price=${bestAsk} size=${size}\n`);

// Override resolve
const origResolve = client._resolveSpotAssetIndex.bind(client);
client._resolveSpotAssetIndex = async () => outcomeAssetId;

try {
  const result = await client.placeOrder(coin, true, bestAsk, size, 'Limit');
  const s = result?.response?.data?.statuses?.[0];
  W(`\nResult: ${JSON.stringify(s)}\n`);
  if (s?.filled) {
    W(`FILLED! ${s.filled.totalSz} @ ${s.filled.avgPx}\n`);
  } else if (s?.resting) {
    W(`RESTING: oid=${s.resting.oid}\n`);
  }
} catch (e) {
  W(`Error: ${e.message}\n`);
}

// Cleanup
client._resolveSpotAssetIndex = origResolve;
client._resolveSpotAssetIndex = async () => outcomeAssetId;
await client.cancelAllOrders();
W('Cleaned up.\n');

process.exit(0);
