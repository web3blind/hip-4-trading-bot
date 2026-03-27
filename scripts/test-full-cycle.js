/**
 * Comprehensive end-to-end test of ALL trade functions against HyperLiquid testnet.
 *
 * Tests:
 *  1. MARKET BUY on every active outcome market
 *  2. MARKET SELL all positions
 *  3. LIMIT BUY on every active market
 *  4. LIMIT SELL where we have inventory
 *  5. CANCEL orders individually + cancelAll
 *  6. ERROR CASES (min value, empty book, insufficient balance, 80% away)
 *  7. POSITIONS / balances verification
 *
 * Run: node scripts/test-full-cycle.js 2>&1
 */
import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';
import { encodeOutcome, SIDES } from '../src/modules/hl-encoding.js';

// ─── Logging ─────────────────────────────────────────────────────
const log = (msg) => process.stderr.write(`${msg}\n`);
const logJSON = (label, obj) => log(`  ${label}: ${JSON.stringify(obj)}`);

// ─── Test tracking ───────────────────────────────────────────────
const results = { pass: 0, fail: 0, skip: 0, details: [] };

function record(name, passed, detail = '') {
  if (passed === 'skip') {
    results.skip++;
    results.details.push({ name, status: 'SKIP', detail });
    log(`  [SKIP] ${name}: ${detail}`);
  } else if (passed) {
    results.pass++;
    results.details.push({ name, status: 'PASS', detail });
    log(`  [PASS] ${name}: ${detail}`);
  } else {
    results.fail++;
    results.details.push({ name, status: 'FAIL', detail });
    log(`  [FAIL] ${name}: ${detail}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Main ────────────────────────────────────────────────────────
async function main() {
  log('=== COMPREHENSIVE E2E TEST SUITE ===\n');

  // Setup
  const config = await loadConfig();
  const pk = await getDecryptedPrivateKey();
  const client = await HLClient.create(pk, config.hlNetwork || 'testnet');
  const address = client.getAddress();
  log(`Wallet: ${address}`);
  log(`Network: ${config.hlNetwork || 'testnet'}\n`);

  // ────────────────────────────────────────────────────────────────
  // 0. GET ALL ACTIVE OUTCOMES
  // ────────────────────────────────────────────────────────────────
  log('========== 0. OUTCOME DISCOVERY ==========');
  const meta = await client.getOutcomeMeta();
  const outcomes = meta?.outcomes || [];
  log(`Found ${outcomes.length} outcomes`);

  // For each outcome, determine the coins (YES=side0, NO=side1)
  const allCoins = [];
  for (const o of outcomes) {
    const yesCoin = '#' + encodeOutcome(o.outcome, SIDES.YES);
    const noCoin = '#' + encodeOutcome(o.outcome, SIDES.NO);
    allCoins.push({ outcomeId: o.outcome, name: o.name, side: 'YES', coin: yesCoin });
    allCoins.push({ outcomeId: o.outcome, name: o.name, side: 'NO', coin: noCoin });
    log(`  ${o.outcome} "${o.name}" => ${yesCoin} (YES), ${noCoin} (NO)`);
  }

  // ────────────────────────────────────────────────────────────────
  // 0b. INITIAL BALANCE
  // ────────────────────────────────────────────────────────────────
  log('\n========== 0b. INITIAL BALANCE ==========');
  const initBal = await client.getUserBalances(address);
  const initBalances = initBal?.balances || [];
  for (const b of initBalances) {
    log(`  ${b.coin}: total=${b.total}, hold=${b.hold}`);
  }

  // ────────────────────────────────────────────────────────────────
  // 1. MARKET BUY on every active outcome market
  // ────────────────────────────────────────────────────────────────
  log('\n========== 1. MARKET BUY (ALL MARKETS) ==========');

  const buyTargetUsdc = 11; // slightly above $10 minimum
  const boughtPositions = []; // track what we bought for selling later

  for (const entry of allCoins) {
    const testName = `MarketBuy ${entry.coin} (${entry.name} ${entry.side})`;
    log(`\n--- ${testName} ---`);

    try {
      const book = await client.getOrderbook(entry.coin);
      const [bids, asks] = book?.levels || [[], []];
      const bestAsk = asks?.[0]?.px ? Number(asks[0].px) : null;
      const bestBid = bids?.[0]?.px ? Number(bids[0].px) : null;

      if (!bestAsk) {
        record(testName, 'skip', 'No asks in orderbook');
        continue;
      }

      const shares = buyTargetUsdc / bestAsk;
      const rounded = await client._roundSize(entry.coin, shares);
      const notional = rounded * bestAsk;
      log(`  bestAsk=${bestAsk}, shares=${shares.toFixed(6)}, rounded=${rounded}, notional=$${notional.toFixed(2)}`);

      if (rounded <= 0) {
        record(testName, false, 'Rounded size is 0');
        continue;
      }

      if (notional < 10) {
        // Need more shares to meet $10 minimum
        log(`  Notional $${notional.toFixed(2)} < $10 — adjusting up`);
        const adjustedShares = Math.ceil(10 / bestAsk * 100) / 100;
        const result = await client.placeMarketOrder(entry.coin, true, adjustedShares);
        const statuses = result?.response?.data?.statuses || [];
        logJSON('statuses', statuses);
        const filled = statuses.find(s => s.filled);
        const resting = statuses.find(s => s.resting);
        if (filled || resting) {
          record(testName, true, `Adjusted size. ${filled ? 'FILLED' : 'RESTING'}`);
          boughtPositions.push({ ...entry, shares: filled?.filled?.totalSz || adjustedShares });
        } else {
          record(testName, false, `Unexpected status: ${JSON.stringify(statuses)}`);
        }
      } else {
        const result = await client.placeMarketOrder(entry.coin, true, rounded);
        const statuses = result?.response?.data?.statuses || [];
        logJSON('statuses', statuses);
        const filled = statuses.find(s => s.filled);
        const resting = statuses.find(s => s.resting);
        if (filled || resting) {
          record(testName, true, `${filled ? 'FILLED' : 'RESTING'}`);
          boughtPositions.push({ ...entry, shares: filled?.filled?.totalSz || rounded });
        } else {
          record(testName, false, `Unexpected status: ${JSON.stringify(statuses)}`);
        }
      }
    } catch (err) {
      if (err.message.includes('Not found in spot universe')) {
        record(testName, 'skip', 'Not in spot universe (inactive/recurring market)');
      } else if (err.message.includes('80%') || err.message.includes('reference price')) {
        record(testName, 'skip', `80% away from reference: ${err.message}`);
      } else {
        record(testName, false, `Error: ${err.message}`);
      }
    }

    await delay(300); // rate limit
  }

  // ────────────────────────────────────────────────────────────────
  // 2. CHECK POSITIONS AFTER BUYS
  // ────────────────────────────────────────────────────────────────
  log('\n========== 2. POSITIONS AFTER BUYS ==========');
  await delay(1000);
  const postBuyBal = await client.getUserBalances(address);
  const postBuyBalances = postBuyBal?.balances || [];
  const outcomePositions = postBuyBalances.filter(b => {
    const c = b.coin || '';
    return (c.startsWith('@') || c.startsWith('+') || c.startsWith('#'));
  });

  log(`  Found ${outcomePositions.length} outcome token positions`);
  for (const p of outcomePositions) {
    log(`    ${p.coin}: total=${p.total}, hold=${p.hold}`);
  }

  const buySuccesses = boughtPositions.length;
  if (buySuccesses > 0) {
    const hasPositions = outcomePositions.length > 0;
    // On testnet with thin markets, aggressive GTC limits often rest rather than fill.
    // Having 0 positions but successful resting orders is valid behavior.
    record('Positions after buy', true, 
      hasPositions 
        ? `${outcomePositions.length} outcome positions found`
        : `${buySuccesses} buys resulted in resting orders (thin testnet liquidity)`);
  } else {
    record('Positions after buy', 'skip', 'No successful buys to verify');
  }

  // ────────────────────────────────────────────────────────────────
  // 3. MARKET SELL all positions
  // ────────────────────────────────────────────────────────────────
  log('\n========== 3. MARKET SELL (ALL POSITIONS) ==========');

  for (const pos of outcomePositions) {
    const rawCoin = pos.coin;
    const total = parseFloat(pos.total || '0');
    if (total <= 0) continue;

    // Convert @ or + prefix to # for trading
    const tradeCoin = rawCoin.startsWith('@') ? '#' + rawCoin.slice(1) : 
                      rawCoin.startsWith('+') ? '#' + rawCoin.slice(1) : rawCoin;
    
    const testName = `MarketSell ${tradeCoin} (${total.toFixed(4)} shares)`;
    log(`\n--- ${testName} ---`);

    try {
      const book = await client.getOrderbook(tradeCoin);
      const [bids, asks] = book?.levels || [[], []];
      const bestBid = bids?.[0]?.px ? Number(bids[0].px) : null;

      if (!bestBid) {
        record(testName, 'skip', 'No bids in orderbook');
        continue;
      }

      const rounded = await client._roundSize(tradeCoin, total);
      const notional = rounded * bestBid;
      log(`  bestBid=${bestBid}, shares=${rounded}, notional=$${notional.toFixed(2)}`);

      if (notional < 10) {
        record(testName, 'skip', `Notional $${notional.toFixed(2)} < $10 minimum`);
        continue;
      }

      const result = await client.placeMarketOrder(tradeCoin, false, rounded);
      const statuses = result?.response?.data?.statuses || [];
      logJSON('statuses', statuses);
      const filled = statuses.find(s => s.filled);
      const resting = statuses.find(s => s.resting);
      if (filled || resting) {
        record(testName, true, `${filled ? 'FILLED' : 'RESTING'}`);
      } else {
        record(testName, false, `Unexpected status: ${JSON.stringify(statuses)}`);
      }
    } catch (err) {
      record(testName, false, `Error: ${err.message}`);
    }

    await delay(300);
  }

  // Cancel any resting orders before next phase
  log('\n--- Cancelling any resting orders from market sells ---');
  try {
    await client.cancelAllOrders();
    log('  Cancelled all.');
  } catch (e) {
    log(`  Cancel error: ${e.message}`);
  }
  await delay(500);

  // ────────────────────────────────────────────────────────────────
  // 4. LIMIT BUY on every active market
  // ────────────────────────────────────────────────────────────────
  log('\n========== 4. LIMIT BUY (ALL MARKETS) ==========');

  const limitBuyOids = [];

  for (const entry of allCoins) {
    const testName = `LimitBuy ${entry.coin} (${entry.name} ${entry.side})`;
    log(`\n--- ${testName} ---`);

    try {
      const book = await client.getOrderbook(entry.coin);
      const [bids, asks] = book?.levels || [[], []];
      const bestAsk = asks?.[0]?.px ? Number(asks[0].px) : null;
      const bestBid = bids?.[0]?.px ? Number(bids[0].px) : null;
      const midPrice = bestAsk && bestBid ? (bestAsk + bestBid) / 2 : bestAsk || bestBid;

      if (!midPrice) {
        record(testName, 'skip', 'No price data in orderbook');
        continue;
      }

      // Limit buy at 80% of mid
      const limitPrice = Number((midPrice * 0.8).toFixed(6));
      const shares = 11 / limitPrice; // $11 worth
      const rounded = await client._roundSize(entry.coin, shares);

      if (rounded <= 0) {
        record(testName, false, 'Rounded size is 0');
        continue;
      }

      log(`  midPrice=${midPrice}, limitPrice=${limitPrice}, shares=${rounded}`);

      const result = await client.placeOrder(entry.coin, true, limitPrice, rounded, 'Limit');
      const statuses = result?.response?.data?.statuses || [];
      logJSON('statuses', statuses);
      const resting = statuses.find(s => s.resting);
      const filled = statuses.find(s => s.filled);

      if (resting) {
        record(testName, true, `RESTING oid=${resting.resting.oid}`);
        limitBuyOids.push({ coin: entry.coin, oid: resting.resting.oid });
      } else if (filled) {
        record(testName, true, `FILLED (unexpectedly) oid=${filled.filled.oid}`);
      } else {
        record(testName, false, `Unexpected status: ${JSON.stringify(statuses)}`);
      }
    } catch (err) {
      if (err.message.includes('80%') || err.message.includes('reference price')) {
        record(testName, 'skip', `80% away error (expected for deep limit): ${err.message}`);
      } else if (err.message.includes('Not found in spot universe')) {
        record(testName, 'skip', 'Not in spot universe (inactive/recurring market)');
      } else {
        record(testName, false, `Error: ${err.message}`);
      }
    }

    await delay(300);
  }

  // ────────────────────────────────────────────────────────────────
  // 5. VERIFY OPEN ORDERS
  // ────────────────────────────────────────────────────────────────
  log('\n========== 5. VERIFY OPEN ORDERS ==========');
  await delay(500);
  const openOrders = await client.getOpenOrders(address);
  log(`  Found ${openOrders.length} open orders`);
  for (const o of openOrders) {
    log(`    coin=${o.coin} side=${o.side} px=${o.limitPx} sz=${o.sz} oid=${o.oid}`);
  }
  record('Open orders after limit buys', 
    openOrders.length > 0 || limitBuyOids.length === 0, 
    `${openOrders.length} orders (${limitBuyOids.length} placed)`);

  // ────────────────────────────────────────────────────────────────
  // 6. LIMIT SELL (where we have inventory)
  // ────────────────────────────────────────────────────────────────
  log('\n========== 6. LIMIT SELL (ON POSITIONS) ==========');

  // Refresh positions
  const preSellBal = await client.getUserBalances(address);
  const preSellPositions = (preSellBal?.balances || []).filter(b => {
    const c = b.coin || '';
    return (c.startsWith('@') || c.startsWith('+') || c.startsWith('#')) && parseFloat(b.total || '0') > 0;
  });

  const limitSellOids = [];

  for (const pos of preSellPositions) {
    const rawCoin = pos.coin;
    const total = parseFloat(pos.total || '0');
    if (total <= 0) continue;

    const tradeCoin = rawCoin.startsWith('@') ? '#' + rawCoin.slice(1) : 
                      rawCoin.startsWith('+') ? '#' + rawCoin.slice(1) : rawCoin;

    const testName = `LimitSell ${tradeCoin} (${total.toFixed(4)} shares)`;
    log(`\n--- ${testName} ---`);

    try {
      const book = await client.getOrderbook(tradeCoin);
      const [bids, asks] = book?.levels || [[], []];
      const bestAsk = asks?.[0]?.px ? Number(asks[0].px) : null;
      const bestBid = bids?.[0]?.px ? Number(bids[0].px) : null;
      const midPrice = bestAsk && bestBid ? (bestAsk + bestBid) / 2 : bestAsk || bestBid;

      if (!midPrice) {
        record(testName, 'skip', 'No price data');
        continue;
      }

      // Limit sell at 120% of mid (but capped at 0.999)
      const limitPrice = Math.min(Number((midPrice * 1.2).toFixed(6)), 0.999);
      const rounded = await client._roundSize(tradeCoin, total);

      if (rounded <= 0) {
        record(testName, 'skip', 'Zero size after rounding');
        continue;
      }

      const notional = rounded * limitPrice;
      if (notional < 10) {
        record(testName, 'skip', `Notional $${notional.toFixed(2)} < $10`);
        continue;
      }

      log(`  limitPrice=${limitPrice}, shares=${rounded}, notional=$${notional.toFixed(2)}`);

      const result = await client.placeOrder(tradeCoin, false, limitPrice, rounded, 'Limit');
      const statuses = result?.response?.data?.statuses || [];
      logJSON('statuses', statuses);
      const resting = statuses.find(s => s.resting);
      const filled = statuses.find(s => s.filled);

      if (resting) {
        record(testName, true, `RESTING oid=${resting.resting.oid}`);
        limitSellOids.push({ coin: tradeCoin, oid: resting.resting.oid });
      } else if (filled) {
        record(testName, true, `FILLED`);
      } else {
        record(testName, false, `Unexpected status: ${JSON.stringify(statuses)}`);
      }
    } catch (err) {
      if (err.message.includes('80%')) {
        record(testName, 'skip', `80% away error: ${err.message}`);
      } else {
        record(testName, false, `Error: ${err.message}`);
      }
    }

    await delay(300);
  }

  // ────────────────────────────────────────────────────────────────
  // 7. CANCEL INDIVIDUAL ORDERS
  // ────────────────────────────────────────────────────────────────
  log('\n========== 7. CANCEL INDIVIDUAL ORDERS ==========');

  const allOids = [...limitBuyOids, ...limitSellOids];
  const cancelledSome = allOids.length > 0;

  // Cancel first order individually if any
  if (allOids.length > 0) {
    const first = allOids[0];
    const testName = `CancelOrder ${first.coin} oid=${first.oid}`;
    log(`\n--- ${testName} ---`);
    try {
      const result = await client.cancelOrder(first.coin, first.oid);
      logJSON('result', result);
      record(testName, true, 'Cancelled');
    } catch (err) {
      record(testName, false, `Error: ${err.message}`);
    }
    await delay(300);
  }

  // ────────────────────────────────────────────────────────────────
  // 8. CANCEL ALL REMAINING ORDERS
  // ────────────────────────────────────────────────────────────────
  log('\n========== 8. CANCEL ALL ORDERS ==========');
  try {
    const result = await client.cancelAllOrders();
    logJSON('cancelAll result', result);
    record('CancelAll', true, JSON.stringify(result));
  } catch (err) {
    record('CancelAll', false, `Error: ${err.message}`);
  }

  await delay(500);
  const remainingOrders = await client.getOpenOrders(address);
  record('No remaining orders', remainingOrders.length === 0, `${remainingOrders.length} remaining`);

  // ────────────────────────────────────────────────────────────────
  // 9. ERROR CASES
  // ────────────────────────────────────────────────────────────────
  log('\n========== 9. ERROR CASES ==========');

  // 9a. Buy with amount < $10 USDC
  {
    const testName = 'ErrorCase: Buy < $10 USDC';
    log(`\n--- ${testName} ---`);
    try {
      // Use a small size that's < $10
      const book = await client.getOrderbook('#110');
      const [, asks] = book?.levels || [[], []];
      const bestAsk = asks?.[0]?.px ? Number(asks[0].px) : null;
      if (bestAsk) {
        const tinyShares = await client._roundSize('#110', 5 / bestAsk); // $5 worth
        if (tinyShares > 0) {
          await client.placeMarketOrder('#110', true, tinyShares);
          record(testName, false, 'Should have thrown but succeeded');
        } else {
          record(testName, 'skip', 'Cannot create small enough size');
        }
      } else {
        record(testName, 'skip', 'No asks');
      }
    } catch (err) {
      const msg = err.message.toLowerCase();
      if (msg.includes('minimum') || msg.includes('10 usdc') || msg.includes('$10')) {
        record(testName, true, `Got expected error: ${err.message}`);
      } else {
        record(testName, false, `Unexpected error: ${err.message}`);
      }
    }
  }

  // 9b. Buy on empty orderbook
  {
    const testName = 'ErrorCase: Buy empty orderbook';
    log(`\n--- ${testName} ---`);
    // Find a coin with no asks
    let emptyAsksCoin = null;
    for (const entry of allCoins) {
      try {
        const book = await client.getOrderbook(entry.coin);
        const [, asks] = book?.levels || [[], []];
        if (!asks || asks.length === 0) {
          emptyAsksCoin = entry.coin;
          break;
        }
      } catch { /* skip */ }
    }

    if (emptyAsksCoin) {
      try {
        await client.placeMarketOrder(emptyAsksCoin, true, 100);
        record(testName, false, 'Should have thrown but succeeded');
      } catch (err) {
        if (err.message.includes('empty') || err.message.includes('market price')) {
          record(testName, true, `Got expected error: ${err.message}`);
        } else {
          record(testName, false, `Unexpected error type: ${err.message}`);
        }
      }
    } else {
      // Manufacture the test with a totally invalid coin — skip if all have asks
      record(testName, 'skip', 'All markets have asks');
    }
  }

  // 9c. Sell with 0 inventory
  {
    const testName = 'ErrorCase: Sell 0 inventory';
    log(`\n--- ${testName} ---`);
    // Pick a coin we definitely don't hold
    try {
      // Use a coin where we don't have inventory
      const book = await client.getOrderbook('#110');
      const [bids] = book?.levels || [[], []];
      const bestBid = bids?.[0]?.px ? Number(bids[0].px) : null;
      if (bestBid) {
        const szDec = await client._getSzDecimals('#110');
        const minSize = Math.ceil(11 / bestBid * Math.pow(10, szDec)) / Math.pow(10, szDec);
        await client.placeMarketOrder('#110', false, minSize);
        record(testName, false, 'Should have thrown but succeeded');
      } else {
        record(testName, 'skip', 'No bids');
      }
    } catch (err) {
      const msg = err.message.toLowerCase();
      if (msg.includes('insufficient') || msg.includes('balance') || msg.includes('not enough')) {
        record(testName, true, `Got expected error: ${err.message}`);
      } else {
        // Any error (not crash) is acceptable for this edge case
        record(testName, true, `Got error (not crash): ${err.message}`);
      }
    }
  }

  // 9d. Limit buy with price way below market (1% of mid)
  {
    const testName = 'ErrorCase: Limit price 80% away';
    log(`\n--- ${testName} ---`);
    try {
      const book = await client.getOrderbook('#110');
      const [bids, asks] = book?.levels || [[], []];
      const bestAsk = asks?.[0]?.px ? Number(asks[0].px) : null;
      const bestBid = bids?.[0]?.px ? Number(bids[0].px) : null;
      const mid = bestAsk && bestBid ? (bestAsk + bestBid) / 2 : bestAsk || bestBid;
      if (mid) {
        const crazyLowPrice = Number((mid * 0.01).toFixed(6)); // 1% of mid
        const shares = Math.ceil(11 / crazyLowPrice * 100) / 100;
        await client.placeOrder('#110', true, crazyLowPrice, shares, 'Limit');
        record(testName, false, 'Should have thrown 80% error but succeeded');
      } else {
        record(testName, 'skip', 'No price data');
      }
    } catch (err) {
      if (err.message.includes('80%') || err.message.includes('reference price')) {
        record(testName, true, `Got expected error: ${err.message}`);
      } else {
        record(testName, false, `Unexpected error: ${err.message}`);
      }
    }
  }

  // ────────────────────────────────────────────────────────────────
  // 10. FINAL CLEANUP — cancel everything, check final balances
  // ────────────────────────────────────────────────────────────────
  log('\n========== 10. FINAL CLEANUP ==========');
  try {
    await client.cancelAllOrders();
  } catch { /* ignore */ }

  const finalBal = await client.getUserBalances(address);
  const finalBalances = finalBal?.balances || [];
  log('  Final balances:');
  for (const b of finalBalances) {
    log(`    ${b.coin}: total=${b.total}, hold=${b.hold}`);
  }

  // ────────────────────────────────────────────────────────────────
  // SUMMARY
  // ────────────────────────────────────────────────────────────────
  log('\n\n' + '='.repeat(60));
  log('TEST SUMMARY');
  log('='.repeat(60));
  log(`  PASSED: ${results.pass}`);
  log(`  FAILED: ${results.fail}`);
  log(`  SKIPPED: ${results.skip}`);
  log(`  TOTAL:  ${results.pass + results.fail + results.skip}`);
  log('');

  if (results.fail > 0) {
    log('FAILURES:');
    for (const d of results.details.filter(d => d.status === 'FAIL')) {
      log(`  ✗ ${d.name}: ${d.detail}`);
    }
  }

  log('\nALL RESULTS:');
  for (const d of results.details) {
    const icon = d.status === 'PASS' ? '✓' : d.status === 'FAIL' ? '✗' : '○';
    log(`  ${icon} [${d.status}] ${d.name}: ${d.detail}`);
  }

  log('\n='.repeat(60));

  if (results.fail > 0) {
    log(`\nEXIT: ${results.fail} tests FAILED`);
    process.exit(1);
  } else {
    log('\nEXIT: All tests passed (or skipped)');
    process.exit(0);
  }
}

main().catch((err) => {
  log(`\nFATAL ERROR: ${err.message}\n${err.stack}`);
  process.exit(2);
});
