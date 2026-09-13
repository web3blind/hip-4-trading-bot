#!/usr/bin/env node
// Public read-only probe; deliberately imports no wallet/config and never signs.
const network = process.argv.includes('--mainnet') ? 'mainnet' : 'testnet';
const url = network === 'mainnet' ? 'https://api.hyperliquid.xyz/info' : 'https://api.hyperliquid-testnet.xyz/info';
try {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'outcomeMeta' }), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const meta = await response.json();
  if (!Array.isArray(meta?.outcomes) || !Array.isArray(meta?.questions)) throw new Error('Invalid outcomeMeta response');
  console.log(JSON.stringify({ network, outcomes: meta.outcomes.length, questions: meta.questions.length, sample: meta.outcomes.slice(0, 3) }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
