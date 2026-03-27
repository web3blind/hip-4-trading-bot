/**
 * Automated test script — runs through all functions non-interactively.
 */
import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';
import { initDatabase } from '../src/modules/database.js';

initDatabase();
const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');
const address = client.getAddress();

console.log('Wallet:', address);
console.log('Network:', config.hlNetwork || 'testnet');

// 1. Markets
console.log('\n========== 1. MARKETS ==========');
const meta = await client.getOutcomeMeta();
const mids = await client.getAllMids();
for (const o of meta.outcomes) {
  const c0 = '#' + (10 * o.outcome + 0);
  const c1 = '#' + (10 * o.outcome + 1);
  console.log(`  #${o.outcome} "${o.name}" ${c0}=${mids[c0]||'-'} ${c1}=${mids[c1]||'-'}`);
}

// 2. Balance
console.log('\n========== 2. BALANCE ==========');
const balData = await client.getUserBalances(address);
console.log('Balances:', JSON.stringify(balData?.balances || [], null, 2));

// 3. Orderbook for #110 (Canned Tuna YES)
console.log('\n========== 3. ORDERBOOK #110 ==========');
const book = await client.getOrderbook('#110');
const [bids, asks] = book?.levels || [[], []];
console.log('Asks:', asks.slice(0, 3));
console.log('Bids:', bids.slice(0, 3));

const bestAsk = asks?.[0]?.px ? Number(asks[0].px) : null;
const bestBid = bids?.[0]?.px ? Number(bids[0].px) : null;
console.log('bestAsk:', bestAsk, 'bestBid:', bestBid);

// 4. Check szDecimals
console.log('\n========== 4. szDecimals #110 ==========');
const szDec = await client._getSzDecimals('#110');
console.log('szDecimals:', szDec);

// 5. Resolve asset index
console.log('\n========== 5. ASSET INDEX #110 ==========');
const idx = await client._resolveSpotAssetIndex('#110');
console.log('assetIndex:', idx);

// 6. Try limit buy — small order, low price (should succeed or give clear error)
console.log('\n========== 6. LIMIT BUY #110 @ 0.01 x 1.00 ==========');
try {
  const r1 = await client.placeOrder('#110', true, 0.01, 1.0, 'Limit');
  console.log('Result:', JSON.stringify(r1, null, 2));
} catch (e) {
  console.log('Error:', e.message);
}

// 7. Check orders
console.log('\n========== 7. OPEN ORDERS ==========');
try {
  const orders = await client.getOpenOrders(address);
  console.log('Orders:', JSON.stringify(orders, null, 2));
} catch (e) {
  console.log('Error:', e.message);
}

// 8. Cancel all orders
console.log('\n========== 8. CANCEL ALL ==========');
try {
  const r2 = await client.cancelAllOrders();
  console.log('Result:', JSON.stringify(r2, null, 2));
} catch (e) {
  console.log('Error:', e.message);
}

// 9. Market buy — small amount
console.log('\n========== 9. MARKET BUY #110 (1 USDC worth) ==========');
if (bestAsk) {
  const shares = 1.0 / bestAsk;
  const rounded = await client._roundSize('#110', shares);
  console.log(`Shares for $1: ${shares} -> rounded: ${rounded}`);
  
  if (rounded > 0) {
    try {
      const r3 = await client.placeMarketOrder('#110', true, rounded);
      console.log('Result:', JSON.stringify(r3, null, 2));
    } catch (e) {
      console.log('Error:', e.message);
    }
  }
}

// 10. Positions
console.log('\n========== 10. POSITIONS ==========');
try {
  const posData = await client.getUserBalances(address);
  const outcomePos = (posData?.balances || []).filter(b =>
    b.coin?.startsWith('@') || b.coin?.startsWith('+')
  );
  console.log('Outcome positions:', outcomePos);
} catch (e) {
  console.log('Error:', e.message);
}

console.log('\n========== DONE ==========');
process.exit(0);
