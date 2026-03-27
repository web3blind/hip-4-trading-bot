import 'dotenv/config';
import { ethers } from 'ethers';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const W = process.stderr.write.bind(process.stderr);

const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');
const addr = client.getAddress();

W(`Wallet: ${addr}\n`);

// 1. Inspect the spot universe for outcome #90
const meta = await client._infoRequest({ type: 'spotMeta' });
const universe = meta?.universe || [];
const tokens = meta?.tokens || [];

for (const e of universe) {
  if (e.name === '@90') {
    W(`\nUniverse entry for @90: ${JSON.stringify(e)}\n`);
    const baseTokenIdx = e.tokens?.[0];
    if (baseTokenIdx != null && tokens[baseTokenIdx]) {
      W(`  Base token: ${JSON.stringify(tokens[baseTokenIdx])}\n`);
    }
    const quoteTokenIdx = e.tokens?.[1];
    if (quoteTokenIdx != null && tokens[quoteTokenIdx]) {
      W(`  Quote token: ${JSON.stringify(tokens[quoteTokenIdx])}\n`);
    }
  }
}

// 2. Check asset index
const assetIndex = await client._resolveSpotAssetIndex('#90');
W(`\nAsset index for #90: ${assetIndex}\n`);

// 3. Check orderbook
const coin = '#90';
const book = await client.getOrderbook(coin);
const [bids, asks] = book?.levels || [[], []];
W(`\nOrderbook ${coin}:\n`);
W(`  Asks: ${asks.slice(0, 5).map(a => `${a.px}x${a.sz}(n=${a.n})`).join(', ')}\n`);
W(`  Bids: ${bids.slice(0, 5).map(b => `${b.px}x${b.sz}(n=${b.n})`).join(', ')}\n`);

// 4. Check balances
const bals = await client.getUserBalances();
W(`\nBalances: ${JSON.stringify(bals?.balances?.slice(0, 5))}\n`);

// 5. Cancel any existing orders
await client.cancelAllOrders();
await new Promise(r => setTimeout(r, 1500));

// 6. TEST: Try with FrontendMarket TIF (as the web UI uses)
if (asks.length > 0) {
  const bestAsk = Number(asks[0].px);
  const szDec = await client._getSzDecimals(coin);
  const shares = Math.floor((10 / bestAsk) * Math.pow(10, szDec)) / Math.pow(10, szDec);
  
  W(`\n=== TEST 1: GTC at bestAsk (current behavior) ===\n`);
  W(`  bestAsk=${bestAsk}, shares=${shares}, assetIndex=${assetIndex}\n`);
  
  try {
    const result1 = await client.placeOrder(coin, true, bestAsk, shares, 'Limit');
    const s1 = result1?.response?.data?.statuses?.[0];
    if (s1?.filled) {
      W(`  FILLED! totalSz=${s1.filled.totalSz} avgPx=${s1.filled.avgPx}\n`);
    } else if (s1?.resting) {
      W(`  RESTING: oid=${s1.resting.oid}\n`);
    } else {
      W(`  Other: ${JSON.stringify(s1)}\n`);
    }
  } catch (e) {
    W(`  Error: ${e.message}\n`);
  }
  
  // Cancel
  await client.cancelAllOrders();
  await new Promise(r => setTimeout(r, 1500));
  
  W(`\n=== TEST 2: FrontendMarket TIF (what web UI uses) ===\n`);
  // The web UI uses { limit: { tif: 'FrontendMarket' } } for market orders
  try {
    const formatPriceForHl = (price) => {
      const numeric = Number(price);
      if (numeric >= 1) return numeric.toFixed(8).replace(/\.?0+$/, '');
      return numeric.toFixed(5).replace(/\.?0+$/, '');
    };
    
    // Build the order wire manually with FrontendMarket
    const orderWire = {
      a: assetIndex,
      b: true,
      p: formatPriceForHl(bestAsk),
      s: formatPriceForHl(shares),
      r: false,
      t: { limit: { tif: 'FrontendMarket' } },
    };
    
    W(`  Wire: ${JSON.stringify(orderWire)}\n`);
    
    const action = {
      type: 'order',
      orders: [orderWire],
      grouping: 'na',
    };
    
    // Sign and send using the client's internal methods
    const nonce = Date.now();
    
    // Manually replicate signL1Action
    const PHANTOM_DOMAIN = {
      name: 'Exchange',
      version: '1',
      chainId: 1337,
      verifyingContract: '0x0000000000000000000000000000000000000000',
    };
    
    const AGENT_TYPES = {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' },
      ],
    };
    
    function removeTrailingZeros(val) {
      if (typeof val !== 'string' || !val.includes('.')) return val;
      const normalized = val.replace(/\.?0+$/, '');
      return normalized === '-0' ? '0' : normalized;
    }
    
    function normalizeAction(obj) {
      if (!obj || typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map(normalizeAction);
      const result = { ...obj };
      for (const key of Object.keys(result)) {
        const v = result[key];
        if (v && typeof v === 'object') {
          result[key] = normalizeAction(v);
        } else if ((key === 'p' || key === 's') && typeof v === 'string') {
          result[key] = removeTrailingZeros(v);
        }
      }
      return result;
    }
    
    const normalized = normalizeAction(action);
    const msgPackBytes = msgpackEncode(normalized);
    const data = new Uint8Array(msgPackBytes.length + 9);
    data.set(msgPackBytes);
    const view = new DataView(data.buffer);
    view.setBigUint64(msgPackBytes.length, BigInt(nonce), false);
    view.setUint8(msgPackBytes.length + 8, 0);
    const hash = ethers.utils.keccak256(data);
    
    const phantomAgent = {
      source: 'b', // testnet
      connectionId: hash,
    };
    
    const key = pk.startsWith('0x') ? pk : '0x' + pk;
    const wallet = new ethers.Wallet(key);
    
    const rawSig = await wallet._signTypedData(
      PHANTOM_DOMAIN,
      AGENT_TYPES,
      phantomAgent,
    );
    const { r, s, v } = ethers.utils.splitSignature(rawSig);
    const signature = { r, s, v };
    
    const payload = {
      action,
      nonce,
      signature,
      vaultAddress: null,
    };
    
    const response = await fetch('https://api.hyperliquid-testnet.xyz/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    
    const result2 = await response.json();
    W(`  Response: ${JSON.stringify(result2)}\n`);
    
    const s2 = result2?.response?.data?.statuses?.[0];
    if (s2?.filled) {
      W(`  FILLED! totalSz=${s2.filled.totalSz} avgPx=${s2.filled.avgPx}\n`);
    } else if (s2?.resting) {
      W(`  RESTING: oid=${s2.resting.oid}\n`);
    } else if (s2?.error) {
      W(`  Error: ${s2.error}\n`);
    } else {
      W(`  Other: ${JSON.stringify(s2)}\n`);
    }
  } catch (e) {
    W(`  Error: ${e.message}\n`);
  }
  
  // Cancel
  await client.cancelAllOrders();
  await new Promise(r => setTimeout(r, 1500));
  
  W(`\n=== TEST 3: IOC at bestAsk ===\n`);
  try {
    const result3 = await client.placeOrder(coin, true, bestAsk, shares, 'Market'); // Market = IOC
    const s3 = result3?.response?.data?.statuses?.[0];
    if (s3?.filled) {
      W(`  FILLED! totalSz=${s3.filled.totalSz} avgPx=${s3.filled.avgPx}\n`);
    } else if (s3?.resting) {
      W(`  RESTING: oid=${s3.resting.oid}\n`);
    } else {
      W(`  Other: ${JSON.stringify(s3)}\n`);
    }
  } catch (e) {
    W(`  Error: ${e.message}\n`);
  }
  
  // Cancel
  await client.cancelAllOrders();
  await new Promise(r => setTimeout(r, 1500));
  
  // TEST 4: Try with a much HIGHER price (way above bestAsk) to see if price is the issue
  W(`\n=== TEST 4: GTC at MUCH higher price (0.99) ===\n`);
  try {
    const result4 = await client.placeOrder(coin, true, 0.99, shares, 'Limit');
    const s4 = result4?.response?.data?.statuses?.[0];
    if (s4?.filled) {
      W(`  FILLED! totalSz=${s4.filled.totalSz} avgPx=${s4.filled.avgPx}\n`);
    } else if (s4?.resting) {
      W(`  RESTING: oid=${s4.resting.oid}\n`);
    } else {
      W(`  Other: ${JSON.stringify(s4)}\n`);
    }
  } catch (e) {
    W(`  Error: ${e.message}\n`);
  }
  
  // Final cleanup
  await client.cancelAllOrders();
}

W(`\nDone.\n`);
process.exit(0);
