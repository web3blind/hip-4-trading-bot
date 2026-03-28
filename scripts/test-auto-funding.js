/**
 * Test auto-funding for HIP-4 outcome trading.
 *
 * 1. Moves all perp USDC back to spot
 * 2. Verifies perp is empty
 * 3. Calls ensureOutcomeFunding (should auto-transfer from spot)
 * 4. Places a small test order
 * 5. Cancels the order
 * 6. Shows final balances
 */
import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const log = (...args) => process.stderr.write(args.join(' ') + '\n');

async function main() {
  const config = await loadConfig();
  const pk = await getDecryptedPrivateKey();
  const client = await HLClient.create(pk, config.hlNetwork || 'testnet');

  log('=== Auto-Funding Test ===');
  log(`Address: ${client.getAddress()}`);
  log(`Network: ${config.hlNetwork || 'testnet'}`);

  // Step 1: Show initial balances
  const initSpot = await client.getSpotUsdcBalance();
  const initPerp = await client.getPerpBalance();
  log(`\nInitial balances:`);
  log(`  Spot USDC: $${initSpot.toFixed(2)}`);
  log(`  Perp USDC: $${initPerp.toFixed(2)}`);

  // Step 2: Transfer perp -> spot (empty the perp account)
  if (initPerp > 0.01) {
    const amt = Math.floor(initPerp * 100) / 100;
    log(`\nMoving $${amt} perp -> spot...`);
    try {
      await client.transferUsdClass(amt, false);
      log('  Transfer successful');
    } catch (err) {
      log(`  Transfer error: ${err.message}`);
    }
    // Brief delay for settlement
    await new Promise(r => setTimeout(r, 2000));
  }

  const afterMoveSpot = await client.getSpotUsdcBalance();
  const afterMovePerp = await client.getPerpBalance();
  log(`\nAfter moving to spot:`);
  log(`  Spot USDC: $${afterMoveSpot.toFixed(2)}`);
  log(`  Perp USDC: $${afterMovePerp.toFixed(2)}`);

  // Step 3: Test ensureOutcomeFunding with $15 (should auto-transfer from spot)
  const requiredUsdc = 15;
  log(`\nCalling ensureOutcomeFunding(${requiredUsdc})...`);
  const funded = await client.ensureOutcomeFunding(requiredUsdc);
  log(`  Result: ${funded ? 'FUNDED' : 'FAILED'}`);

  if (!funded) {
    log('\nAuto-funding failed — aborting test.');
    return;
  }

  // Brief delay
  await new Promise(r => setTimeout(r, 1000));

  const afterFundSpot = await client.getSpotUsdcBalance();
  const afterFundPerp = await client.getPerpBalance();
  log(`\nAfter auto-funding:`);
  log(`  Spot USDC: $${afterFundSpot.toFixed(2)}`);
  log(`  Perp USDC: $${afterFundPerp.toFixed(2)}`);

  // Step 4: Place a test order on #110 (YES side of outcome 11)
  const coin = '#110';
  const price = 0.5;
  const size = 20;  // 20 shares at $0.50 = $10 notional (HL minimum)

  log(`\nPlacing test order: BUY ${size} ${coin} @ ${price}...`);
  let orderId = null;
  try {
    const result = await client.placeOrder(coin, true, price, size, 'Limit');
    const statuses = result?.response?.data?.statuses || [];
    log(`  Statuses: ${JSON.stringify(statuses)}`);

    const resting = statuses.find(s => s.resting);
    const filled = statuses.find(s => s.filled);
    if (resting) {
      orderId = resting.resting.oid;
      log(`  Order resting, OID: ${orderId}`);
    } else if (filled) {
      log(`  Order filled: ${filled.filled.totalSz} shares @ ${filled.filled.avgPx}`);
    } else {
      log(`  Unexpected statuses: ${JSON.stringify(statuses)}`);
    }
  } catch (err) {
    log(`  Order error: ${err.message}`);
  }

  // Step 5: Cancel the order if it's resting
  if (orderId) {
    log(`\nCancelling order ${orderId}...`);
    try {
      await client.cancelOrder(coin, orderId);
      log('  Cancelled');
    } catch (err) {
      log(`  Cancel error: ${err.message}`);
    }
  }

  // Step 6: Final balances
  await new Promise(r => setTimeout(r, 1000));
  const finalSpot = await client.getSpotUsdcBalance();
  const finalPerp = await client.getPerpBalance();
  log(`\nFinal balances:`);
  log(`  Spot USDC: $${finalSpot.toFixed(2)}`);
  log(`  Perp USDC: $${finalPerp.toFixed(2)}`);

  log('\n=== Test Complete ===');
}

main().catch(err => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
