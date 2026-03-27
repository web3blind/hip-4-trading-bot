import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const W = process.stderr.write.bind(process.stderr);

const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');

// Test different coin formats for l2Book
W(`\n=== Testing orderbook with different coin formats ===\n`);

for (const coin of ['#90', '@90', '#90/USDC', '@90/USDC']) {
  try {
    const book = await client._infoRequest({ type: 'l2Book', coin });
    const [bids, asks] = book?.levels || [[], []];
    W(`${coin}: asks=${asks.length > 0 ? asks[0].px + 'x' + asks[0].sz : 'none'}, bids=${bids.length > 0 ? bids[0].px + 'x' + bids[0].sz : 'none'}\n`);
  } catch (e) {
    W(`${coin}: ERROR ${e.message}\n`);
  }
}

// Check open orders from others — who owns the asks?
W(`\n=== Checking our open orders ===\n`);
const ours = await client.getOpenOrders();
W(`Our orders: ${JSON.stringify(ours?.filter(o => o.coin?.includes('90')))}\n`);

// Check allMids to see what mid price is
const mids = await client._infoRequest({ type: 'allMids' });
W(`\nMid for @90: ${mids?.['@90']}\n`);

// Try a different market that should have real liquidity
W(`\n=== Trying different markets ===\n`);
for (const testCoin of ['#100', '#110', '#120']) {
  const book2 = await client.getOrderbook(testCoin);
  const [b2, a2] = book2?.levels || [[], []];
  W(`${testCoin}: asks=${a2.length > 0 ? a2[0].px + 'x' + a2[0].sz + '(n=' + a2[0].n + ')' : 'none'}, bids=${b2.length > 0 ? b2[0].px + 'x' + b2[0].sz + '(n=' + b2[0].n + ')' : 'none'}\n`);
}

// Check the outcomeMeta to understand the market structure
const ometa = await client.getOutcomeMeta();
const o90 = ometa?.outcomes?.find(o => o.outcome === 90);
W(`\nOutcome #90: ${JSON.stringify(o90)}\n`);

process.exit(0);
