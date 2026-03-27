import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const W = process.stderr.write.bind(process.stderr);

const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');
const addr = client.getAddress();

W(`Wallet: ${addr}\n`);

// Test on #110 (Canned Tuna YES) — has liquidity
const coin = '#110';
W(`\n--- Testing market buy on ${coin} ---\n`);

const book = await client.getOrderbook(coin);
const [bids, asks] = book?.levels || [[], []];
W(`Best ask: ${asks[0]?.px} x ${asks[0]?.sz}\n`);
W(`Best bid: ${bids[0]?.px} x ${bids[0]?.sz}\n`);

const bestAsk = Number(asks[0]?.px);
const shares = 10 / bestAsk;
const szDec = await client._getSzDecimals(coin);
const rounded = await client._roundSize(coin, shares);

W(`bestAsk=${bestAsk} shares=${shares} szDec=${szDec} rounded=${rounded}\n`);

try {
  const result = await client.placeMarketOrder(coin, true, rounded);
  W(`Result: ${JSON.stringify(result, null, 2)}\n`);
} catch (e) {
  W(`Error: ${e.message}\n`);
}

// Check what the bot's trade-market.js does differently
W(`\n--- Now testing the same way bot does it ---\n`);
// Bot calls: client.placeMarketOrder(state.coin, true, state.amount)
// where state.amount = estimatedShares = usdcAmount / price
// Let's replicate exactly
const usdcAmount = 10;
const estShares = usdcAmount / bestAsk;
W(`Bot would calculate: ${usdcAmount} / ${bestAsk} = ${estShares}\n`);
const botRounded = await client._roundSize(coin, estShares);
W(`Bot rounded: ${botRounded}\n`);

try {
  const result2 = await client.placeMarketOrder(coin, true, botRounded);
  W(`Bot-style result: ${JSON.stringify(result2, null, 2)}\n`);
} catch (e) {
  W(`Bot-style error: ${e.message}\n`);
}

// Cancel any resting orders
W(`\n--- Cleaning up ---\n`);
try {
  const r = await client.cancelAllOrders();
  W(`cancelAll: ${JSON.stringify(r)}\n`);
} catch (e) {
  W(`cancelAll error: ${e.message}\n`);
}

process.exit(0);
