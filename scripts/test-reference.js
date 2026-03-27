import 'dotenv/config';
import { loadConfig } from '../src/modules/config.js';
import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { HLClient } from '../src/modules/hyperliquid.js';

const W = process.stderr.write.bind(process.stderr);
const config = await loadConfig();
const pk = await getDecryptedPrivateKey();
const client = await HLClient.create(pk, config.hlNetwork || 'testnet');

// Get spotMetaAndAssetCtxs for markPx
const metaCtx = await client._infoRequest({ type: 'spotMetaAndAssetCtxs' });
const universe = metaCtx[0]?.universe || [];
const ctxs = metaCtx[1] || [];

const meta = await client.getOutcomeMeta();
const mids = await client.getAllMids();

W('=== Reference price analysis ===\n\n');

for (const o of meta.outcomes) {
  for (let side = 0; side <= 1; side++) {
    const coin = '#' + (10 * o.outcome + side);
    const atCoin = '@' + (10 * o.outcome + side);
    const mid = mids[coin] ? parseFloat(mids[coin]) : null;
    
    // Find in universe
    const uIdx = universe.findIndex(e => e.name === atCoin);
    let markPx = null;
    if (uIdx >= 0 && ctxs[uIdx]) {
      markPx = parseFloat(ctxs[uIdx].markPx || '0');
    }
    
    const pctAway = (mid && markPx && markPx > 0) 
      ? Math.abs(mid - markPx) / markPx * 100 
      : null;
    
    const canTrade = pctAway !== null ? (pctAway < 80 ? 'YES' : 'NO') : '???';
    
    W(`${coin} ${o.name} side${side}: mid=${mid} markPx=${markPx} pctAway=${pctAway?.toFixed(0)}% canTrade=${canTrade}\n`);
  }
}

process.exit(0);
