import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const W = process.stderr.write.bind(process.stderr);
const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');

const meta = await client.getOutcomeMeta();
const mids = await client.getAllMids();

W('=== Testing market buy on ALL outcomes ===\n\n');

for (const o of meta.outcomes) {
  for (let side = 0; side <= 1; side++) {
    const coin = '#' + (10 * o.outcome + side);
    const sideName = side === 0 ? o.sideSpecs[0]?.name : o.sideSpecs[1]?.name;
    const mid = mids[coin];
    
    W(`${coin} "${o.name}" ${sideName} mid=${mid || 'none'}\n`);
    
    try {
      const book = await client.getOrderbook(coin);
      const [bids, asks] = book?.levels || [[], []];
      
      if (!asks || asks.length === 0) {
        W(`  SKIP: no asks\n\n`);
        continue;
      }
      
      const bestAsk = Number(asks[0].px);
      const shares = 11 / bestAsk; // slightly above $10 min
      const rounded = await client._roundSize(coin, shares);
      
      if (rounded <= 0) {
        W(`  SKIP: rounded size = 0\n\n`);
        continue;
      }
      
      W(`  bestAsk=${bestAsk} shares=${rounded} value=${(rounded * bestAsk).toFixed(2)}\n`);
      
      const result = await client.placeMarketOrder(coin, true, rounded);
      const statuses = result?.response?.data?.statuses || [];
      const s = statuses[0];
      if (s?.filled) W(`  FILLED: ${s.filled.totalSz} @ ${s.filled.avgPx}\n`);
      else if (s?.resting) W(`  RESTING: oid=${s.resting.oid}\n`);
      else W(`  RESULT: ${JSON.stringify(s)}\n`);
    } catch (e) {
      W(`  ERROR: ${e.message}\n`);
    }
    W('\n');
  }
}

// Cleanup
W('=== Cancelling all orders ===\n');
try {
  const r = await client.cancelAllOrders();
  W(`${JSON.stringify(r)}\n`);
} catch (e) {
  W(`cancel error: ${e.message}\n`);
}

process.exit(0);
