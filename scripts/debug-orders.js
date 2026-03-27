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

const coin = process.argv[2] || '#110';
const mode = process.argv[3] || 'market-buy-10';

console.log('wallet', address, 'network', config.hlNetwork || 'testnet', 'coin', coin, 'mode', mode);

if (mode === 'market-buy-10') {
  const book = await client.getOrderbook(coin);
  const [, asks] = book?.levels || [[], []];
  const bestAsk = asks?.[0]?.px ? Number(asks[0].px) : null;
  if (!bestAsk) throw new Error('No ask');
  const targetValue = Number(process.argv[4] || 10);
  const shares = await client._roundSize(coin, targetValue / bestAsk);
  console.log({ bestAsk, shares, value: bestAsk * shares });
  const res = await client.placeMarketOrder(coin, true, shares);
  console.log(JSON.stringify(res, null, 2));
  const open = await client.getOpenOrders(address);
  console.log('openOrders', JSON.stringify(open, null, 2));
  if (open?.length) {
    const cancel = await client.cancelAllOrders();
    console.log('cancelAll', JSON.stringify(cancel, null, 2));
  }
} else if (mode === 'limit-buy') {
  const price = Number(process.argv[4]);
  const size = Number(process.argv[5]);
  const res = await client.placeOrder(coin, true, price, size, 'Limit');
  console.log(JSON.stringify(res, null, 2));
} else if (mode === 'limit-sell') {
  const price = Number(process.argv[4]);
  const size = Number(process.argv[5]);
  const res = await client.placeOrder(coin, false, price, size, 'Limit');
  console.log(JSON.stringify(res, null, 2));
} else if (mode === 'market-sell') {
  const size = Number(process.argv[4]);
  const res = await client.placeMarketOrder(coin, false, size);
  console.log(JSON.stringify(res, null, 2));
} else if (mode === 'cancelall') {
  const res = await client.cancelAllOrders();
  console.log(JSON.stringify(res, null, 2));
} else if (mode === 'orders') {
  const res = await client.getOpenOrders(address);
  console.log(JSON.stringify(res, null, 2));
} else if (mode === 'balances') {
  const res = await client.getUserBalances(address);
  console.log(JSON.stringify(res, null, 2));
}
