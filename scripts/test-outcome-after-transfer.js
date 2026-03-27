import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const coin = process.argv[2] || '#110';
const price = Number(process.argv[3] || '0.663');
const size = Number(process.argv[4] || '16');

const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');

console.error(`Placing test order: ${coin} price=${price} size=${size}`);
try {
  const result = await client.placeOrder(coin, true, price, size, 'Limit');
  console.error(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`Error: ${error.message}`);
  if (error.hlResult) console.error(JSON.stringify(error.hlResult, null, 2));
}
