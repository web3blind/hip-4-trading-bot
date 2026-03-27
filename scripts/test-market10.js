import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');

const coin = '#110';
const book = await client.getOrderbook(coin);
const [bids, asks] = book?.levels || [[], []];
const bestAsk = Number(asks[0].px);
const shares = 10 / bestAsk;
const rounded = await client._roundSize(coin, shares);

console.log('bestAsk=', bestAsk, 'shares=', shares, 'rounded=', rounded, 'value=', rounded * bestAsk);
const result = await client.placeMarketOrder(coin, true, rounded);
console.log(JSON.stringify(result, null, 2));
