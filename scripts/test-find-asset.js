import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const W = process.stderr.write.bind(process.stderr);
const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');

// Get spotMeta universe — look for entries that map to outcome #90
const meta = await client._infoRequest({ type: 'spotMeta' });
const universe = meta.universe || [];
const tokens = meta.tokens || [];

// Search for anything related to outcome 90
W('=== Searching for outcome-related entries in spot universe ===\n\n');

// The encoding from hl-encoding.js: coin = #(10*outcomeId + side)
// So #90 = outcomeId=9, side=0
// Maybe the universe entry for outcome uses a different name pattern?

// Let's look for entries with high indexes or special patterns
for (let i = 0; i < universe.length; i++) {
  const e = universe[i];
  const name = e.name || '';
  // Check if any entry has index >= 1000 or name contains '90' or '#'
  if (e.index >= 900 || name.includes('#') || name.includes('90') || name.includes('91')) {
    const tok0 = tokens[e.tokens?.[0]] || {};
    W(`[${i}] name="${name}" index=${e.index} tokens=${JSON.stringify(e.tokens)} tokenName="${tok0.name}" szDec=${tok0.szDecimals}\n`);
  }
}

// Also check: what does outcomeMeta tell us about asset mapping?
W('\n=== outcomeMeta ===\n');
const outMeta = await client._infoRequest({ type: 'outcomeMeta' });
const outcome9 = outMeta.outcomes?.find(o => o.outcome === 9);
W(`Outcome 9: ${JSON.stringify(outcome9)}\n`);

// Check if there's a spotMetaAndAssetCtxs entry for #90
W('\n=== spotMetaAndAssetCtxs — searching for #90/#91 ===\n');
const metaCtx = await client._infoRequest({ type: 'spotMetaAndAssetCtxs' });
const uniArr = metaCtx[0]?.universe || [];
for (let i = 0; i < uniArr.length; i++) {
  const name = uniArr[i]?.name || '';
  if (name === '#90' || name === '#91' || name === '@90' || name === '@91') {
    W(`[${i}] name="${name}" index=${uniArr[i].index} tokens=${JSON.stringify(uniArr[i].tokens)}\n`);
  }
}

// Maybe outcomes use a completely different endpoint / asset numbering
// Let's check the l2Book coin parameter — it uses #90, so the info API knows about #90
// But the exchange API might need a different asset ID

// Check if outcome coins appear in allMids
const mids = await client._infoRequest({ type: 'allMids' });
const outcomeMids = Object.keys(mids).filter(k => k.startsWith('#')).slice(0, 10);
W(`\nOutcome mids: ${outcomeMids.join(', ')}\n`);

// The asset ID might be derived differently for outcomes
// From hl-encoding.js: OUTCOME_ASSET_BASE = 100_000_000
// So maybe asset = 100_000_000 + encoding?
// encoding for #90 = 90, so asset = 100000090

W('\n=== Testing different asset ID encodings ===\n');
const testAssets = [
  { name: '10000+90 (current)', id: 10090 },
  { name: '100000000+90', id: 100000090 },
  { name: '10000+9*2', id: 10018 },
  { name: '90 (raw)', id: 90 },
];

for (const ta of testAssets) {
  W(`\nTrying asset ${ta.name} = ${ta.id}...\n`);
  try {
    // Build a minimal order to see if HL accepts the asset
    const { ethers } = await import('ethers');
    const { encode: msgpackEncode } = await import('@msgpack/msgpack');
    
    const orderWire = {
      a: ta.id,
      b: true,
      p: '0.5',
      s: '20',
      r: false,
      t: { limit: { tif: 'Gtc' } },
    };
    
    const action = { type: 'order', orders: [orderWire], grouping: 'na' };
    
    // We need to sign and send — use the client's internal methods
    const nonce = Date.now();
    
    // Use raw exchange request approach
    const result = await client._infoRequest({ type: 'l2Book', coin: `#90` });
    // Actually let's just try placing with the client
    // Temporarily override the resolve method
    const origResolve = client._resolveSpotAssetIndex.bind(client);
    client._resolveSpotAssetIndex = async () => ta.id;
    
    try {
      const r = await client.placeOrder('#90', true, 0.5, 20, 'Limit');
      const s = r?.response?.data?.statuses?.[0];
      W(`  Result: ${JSON.stringify(s)}\n`);
      // Cancel if resting
      if (s?.resting) {
        await client.cancelAllOrders();
        W(`  (cancelled)\n`);
      }
    } catch (e) {
      W(`  Error: ${e.message}\n`);
    }
    
    client._resolveSpotAssetIndex = origResolve;
  } catch (e) {
    W(`  Setup error: ${e.message}\n`);
  }
}

process.exit(0);
