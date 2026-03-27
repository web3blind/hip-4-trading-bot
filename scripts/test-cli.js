/**
 * Interactive CLI for testing HIP-4 bot functions without Telegram.
 * 
 * Usage: node scripts/test-cli.js
 * 
 * Commands:
 *   markets       - List all outcome markets
 *   book <coin>   - Show orderbook (e.g. book #110)
 *   balance       - Show USDC + outcome balances
 *   buy <coin> <usdc_amount>  - Market buy (e.g. buy #110 5)
 *   sell <coin> <shares>      - Market sell (e.g. sell #110 10)
 *   limit_buy <coin> <price> <size>   - Limit buy
 *   limit_sell <coin> <price> <size>  - Limit sell
 *   orders        - Show open orders
 *   cancel <oid>  - Cancel order
 *   cancelall     - Cancel all orders
 *   positions     - Show positions
 *   info          - Show wallet info
 *   exit          - Quit
 */

import 'dotenv/config';
import readline from 'readline';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';
import { initDatabase } from '../src/modules/database.js';

let client;
let address;

async function init() {
  initDatabase();
  const config = await loadConfig();
  const pk = await getDecryptedPrivateKey();
  client = await HLClient.create(pk, config.hlNetwork || 'testnet');
  address = client.getAddress();
  console.log(`\nWallet: ${address}`);
  console.log(`Network: ${config.hlNetwork || 'testnet'}\n`);
}

async function cmdMarkets() {
  const meta = await client.getOutcomeMeta();
  const mids = await client.getAllMids();
  
  console.log('\n=== OUTCOME MARKETS ===\n');
  for (const o of meta.outcomes) {
    const coin0 = '#' + (10 * o.outcome + 0);
    const coin1 = '#' + (10 * o.outcome + 1);
    const p0 = mids[coin0] || '-';
    const p1 = mids[coin1] || '-';
    const sides = o.sideSpecs.map(s => s.name).join('/');
    console.log(`#${o.outcome} "${o.name}" [${sides}]`);
    console.log(`  ${coin0} = ${p0}  |  ${coin1} = ${p1}`);
    console.log(`  ${o.description || ''}`);
    console.log();
  }
  
  if (meta.questions?.length > 0) {
    console.log('=== QUESTIONS (events) ===\n');
    for (const q of meta.questions) {
      console.log(`Q#${q.question}: ${q.name}`);
      console.log(`  Outcomes: ${q.namedOutcomes.join(', ')}${q.fallbackOutcome != null ? ', fallback=' + q.fallbackOutcome : ''}`);
      console.log();
    }
  }
}

async function cmdBook(coin) {
  const book = await client.getOrderbook(coin);
  const [bids, asks] = book?.levels || [[], []];
  console.log(`\n=== Orderbook ${coin} ===`);
  console.log('ASKS (sell side):');
  for (const a of asks.slice(0, 5).reverse()) {
    console.log(`  ${a.px} x ${a.sz}`);
  }
  console.log('---');
  console.log('BIDS (buy side):');
  for (const b of bids.slice(0, 5)) {
    console.log(`  ${b.px} x ${b.sz}`);
  }
  console.log();
}

async function cmdBalance() {
  console.log('\n=== Spot Balances ===');
  try {
    const data = await client.getUserBalances(address);
    const balances = data?.balances || [];
    if (balances.length === 0) {
      console.log('No balances.');
    } else {
      for (const b of balances) {
        console.log(`  ${b.coin}: total=${b.total} hold=${b.hold}`);
      }
    }
  } catch (e) {
    console.log('Error:', e.message);
  }
  
  // Also check perp balance
  try {
    const perpData = await client._infoRequest({ type: 'clearinghouseState', user: address });
    const ms = perpData?.marginSummary;
    if (ms) {
      console.log(`\nPerp account: value=${ms.accountValue} rawUsd=${ms.totalRawUsd}`);
    }
  } catch {}
  console.log();
}

async function cmdBuy(coin, usdcAmount) {
  console.log(`\nMarket BUY ${coin}, USDC amount: ${usdcAmount}`);
  
  // Get best ask price
  const book = await client.getOrderbook(coin);
  const [bids, asks] = book?.levels || [[], []];
  const bestAsk = asks?.[0]?.px ? Number(asks[0].px) : null;
  
  if (!bestAsk) {
    console.log('ERROR: No asks in orderbook');
    return;
  }
  
  console.log(`Best ask: ${bestAsk}`);
  const shares = usdcAmount / bestAsk;
  console.log(`Estimated shares: ${shares}`);
  
  // Round shares
  const roundedShares = await client._roundSize(coin, shares);
  console.log(`Rounded shares (szDecimals): ${roundedShares}`);
  
  if (roundedShares <= 0) {
    console.log('ERROR: Rounded size is 0');
    return;
  }
  
  try {
    const result = await client.placeMarketOrder(coin, true, roundedShares);
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (e) {
    console.log('ERROR:', e.message);
  }
  console.log();
}

async function cmdSell(coin, shares) {
  console.log(`\nMarket SELL ${coin}, shares: ${shares}`);
  
  const book = await client.getOrderbook(coin);
  const [bids, asks] = book?.levels || [[], []];
  const bestBid = bids?.[0]?.px ? Number(bids[0].px) : null;
  
  if (!bestBid) {
    console.log('ERROR: No bids in orderbook');
    return;
  }
  
  console.log(`Best bid: ${bestBid}`);
  
  const roundedShares = await client._roundSize(coin, shares);
  console.log(`Rounded shares: ${roundedShares}`);
  
  try {
    const result = await client.placeMarketOrder(coin, false, roundedShares);
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (e) {
    console.log('ERROR:', e.message);
  }
  console.log();
}

async function cmdLimitBuy(coin, price, size) {
  console.log(`\nLimit BUY ${coin} @ ${price} x ${size}`);
  try {
    const result = await client.placeOrder(coin, true, Number(price), Number(size), 'Limit');
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (e) {
    console.log('ERROR:', e.message);
  }
  console.log();
}

async function cmdLimitSell(coin, price, size) {
  console.log(`\nLimit SELL ${coin} @ ${price} x ${size}`);
  try {
    const result = await client.placeOrder(coin, false, Number(price), Number(size), 'Limit');
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (e) {
    console.log('ERROR:', e.message);
  }
  console.log();
}

async function cmdOrders() {
  console.log('\n=== Open Orders ===');
  try {
    const orders = await client.getOpenOrders(address);
    if (!orders || orders.length === 0) {
      console.log('No open orders.');
    } else {
      for (const o of orders) {
        console.log(`  ${o.coin} ${o.side} @ ${o.limitPx} x ${o.sz} oid=${o.oid}`);
      }
    }
  } catch (e) {
    console.log('Error:', e.message);
  }
  console.log();
}

async function cmdCancel(oid) {
  console.log(`\nCancel order: ${oid}`);
  // Need to find the coin for this order first
  try {
    const orders = await client.getOpenOrders(address);
    const order = orders?.find(o => o.oid === oid);
    if (!order) {
      console.log('Order not found in open orders');
      return;
    }
    const result = await client.cancelOrder(order.coin, oid);
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (e) {
    console.log('ERROR:', e.message);
  }
  console.log();
}

async function cmdCancelAll() {
  console.log('\nCancel all orders...');
  try {
    const result = await client.cancelAllOrders();
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (e) {
    console.log('ERROR:', e.message);
  }
  console.log();
}

async function cmdPositions() {
  console.log('\n=== Positions ===');
  try {
    const data = await client.getUserBalances(address);
    const balances = data?.balances || [];
    const outcomeBalances = balances.filter(b => 
      b.coin?.startsWith('@') || b.coin?.startsWith('+') || b.coin?.startsWith('#')
    );
    if (outcomeBalances.length === 0) {
      console.log('No outcome positions.');
    } else {
      for (const b of outcomeBalances) {
        console.log(`  ${b.coin}: ${b.total} (hold: ${b.hold || '0'})`);
      }
    }
  } catch (e) {
    console.log('Error:', e.message);
  }
  console.log();
}

// ─── Main REPL ──────────────────────────────────────────────────

async function main() {
  await init();
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'hip4> ',
  });
  
  console.log('Commands: markets, book, balance, buy, sell, limit_buy, limit_sell, orders, cancel, cancelall, positions, info, exit\n');
  rl.prompt();
  
  rl.on('line', async (line) => {
    const parts = line.trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    
    try {
      switch (cmd) {
        case 'markets': case 'm':
          await cmdMarkets();
          break;
        case 'book': case 'b':
          await cmdBook(parts[1] || '#110');
          break;
        case 'balance': case 'bal':
          await cmdBalance();
          break;
        case 'buy':
          await cmdBuy(parts[1], Number(parts[2]));
          break;
        case 'sell':
          await cmdSell(parts[1], Number(parts[2]));
          break;
        case 'limit_buy': case 'lb':
          await cmdLimitBuy(parts[1], parts[2], parts[3]);
          break;
        case 'limit_sell': case 'ls':
          await cmdLimitSell(parts[1], parts[2], parts[3]);
          break;
        case 'orders': case 'o':
          await cmdOrders();
          break;
        case 'cancel': case 'c':
          await cmdCancel(parts[1]);
          break;
        case 'cancelall': case 'ca':
          await cmdCancelAll();
          break;
        case 'positions': case 'pos':
          await cmdPositions();
          break;
        case 'info': case 'i':
          console.log(`\nWallet: ${address}\n`);
          break;
        case 'exit': case 'quit': case 'q':
          process.exit(0);
        default:
          if (cmd) console.log(`Unknown command: ${cmd}`);
      }
    } catch (e) {
      console.log('Error:', e.message);
    }
    
    rl.prompt();
  });
}

main().catch(e => { console.error(e); process.exit(1); });
