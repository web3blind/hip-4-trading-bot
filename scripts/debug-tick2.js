import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');

// Check orderbooks of all relevant coins to see price tick patterns
const coins = ['#90', '#91', '#100', '#101', '#110', '#111', '#120', '#121'];

for (const coin of coins) {
  const book = await client.getOrderbook(coin);
  const [bids, asks] = book?.levels || [[], []];
  console.log(`\n${coin}:`);
  console.log('  Asks:', asks.slice(0, 5).map(a => a.px));
  console.log('  Bids:', bids.slice(0, 5).map(b => b.px));
  
  // Try to deduce tick size from prices
  if (asks.length >= 2) {
    const prices = asks.map(a => Number(a.px));
    const diffs = [];
    for (let i = 1; i < Math.min(5, prices.length); i++) {
      diffs.push(Number((prices[i] - prices[i-1]).toFixed(8)));
    }
    console.log('  Ask diffs:', diffs);
  }
  if (bids.length >= 2) {
    const prices = bids.map(b => Number(b.px));
    const diffs = [];
    for (let i = 1; i < Math.min(5, prices.length); i++) {
      diffs.push(Number((prices[i] - prices[i-1]).toFixed(8)));
    }
    console.log('  Bid diffs:', diffs);
  }
}

// Also check: outcomeMeta for any tick info
const outcomeMeta = await client._infoRequest({ type: 'outcomeMeta' });
console.log('\nOutcome meta:', JSON.stringify(outcomeMeta, null, 2));

process.exit(0);
