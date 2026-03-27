import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');

// Get spotMeta to see tick sizes
const meta = await client._infoRequest({ type: 'spotMeta' });
const universe = meta.universe || [];
const tokens = meta.tokens || [];

console.log('spotMeta keys:', Object.keys(meta));

// Find outcome entries
for (const entry of universe) {
  if (entry.name && entry.name.startsWith('@')) {
    const tokenIdx = Array.isArray(entry.tokens) ? entry.tokens[0] : null;
    const tok = tokenIdx != null ? tokens[tokenIdx] : null;
    console.log(JSON.stringify({
      name: entry.name,
      index: entry.index,
      tokens: entry.tokens,
      szDecimals: tok?.szDecimals,
      weiDecimals: tok?.weiDecimals,
      fullEntry: entry,
    }));
  }
}

// Also try spotMetaAndAssetCtxs which may have tick size info
try {
  const meta2 = await client._infoRequest({ type: 'spotMetaAndAssetCtxs' });
  const assetCtxs = meta2?.[1] || [];
  console.log('\nspotMetaAndAssetCtxs meta keys:', Object.keys(meta2?.[0] || {}));
  // Find outcome contexts
  const uni2 = meta2?.[0]?.universe || [];
  for (let i = 0; i < uni2.length; i++) {
    if (uni2[i].name && uni2[i].name.startsWith('@')) {
      console.log(`\n${uni2[i].name} (idx ${i}):`);
      console.log('  entry:', JSON.stringify(uni2[i]));
      console.log('  ctx:', JSON.stringify(assetCtxs[i]));
    }
  }
} catch (e) {
  console.log('Error getting spotMetaAndAssetCtxs:', e.message);
}

// Try outcomeMeta for tick info
const outcomeMeta = await client.getOutcomeMeta();
console.log('\noutcomeMeta sample:', JSON.stringify(outcomeMeta.outcomes?.[0], null, 2));

// Check if outcomes have a tickSize field
for (const o of (outcomeMeta.outcomes || [])) {
  console.log(`Outcome ${o.outcome}: `, JSON.stringify(o));
}

process.exit(0);
