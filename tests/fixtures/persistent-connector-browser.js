// Offline browser fixture. Start only during parent QA:
// node tests/fixtures/persistent-connector-browser.js
// Optional: HIP4_FIXTURE_REPLACEMENT=1 for the explicit replacement flow.
// Synthetic owner: ethers.Wallet('0x' + '1'.padStart(64, '0')).address
// Synthetic API key input: '0x' + '2'.padStart(64, '0'). NEVER fund these wallets.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';

const dataDir = await mkdtemp(join(tmpdir(), 'hip4-persistent-browser-'));
process.env.HIP4_DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.HL_NETWORK = 'testnet';
const owner = new ethers.Wallet(`0x${'1'.padStart(64, '0')}`);
const agent = new ethers.Wallet(`0x${'2'.padStart(64, '0')}`);
const priorOwner = new ethers.Wallet(`0x${'3'.padStart(64, '0')}`);
const validUntil = Date.now() + 7 * 24 * 60 * 60 * 1000;
// Fail closed: any accidental non-overridden network request is forbidden.
globalThis.fetch = async () => { throw new Error('External network disabled in fixture'); };
const getAgents = async (url, init) => {
 const request = JSON.parse(init.body);
 if (!['https://api.hyperliquid-testnet.xyz/info', 'https://api.hyperliquid.xyz/info'].includes(String(url)) || init.method !== 'POST' || request.type !== 'extraAgents' || Object.keys(request).some(key => !['type', 'user'].includes(key))) throw new Error('Unexpected fixture request');
 // Deliberately no exchange endpoint, approval signatures, or real credentials.
 const agents = request.user?.toLowerCase() === owner.address.toLowerCase() && String(url).includes('hyperliquid-testnet.xyz') ? [{name:'HIP4Bot', address:agent.address, validUntil}] : [];
 return new Response(JSON.stringify(agents), {status:200, headers:{'Content-Type':'application/json'}});
};
let app;
let closing = false;
async function cleanup() {
 if (closing) return;
 closing = true;
 try { if (app) await app.close(); }
 finally { await rm(dataDir, {recursive:true, force:true}); }
}
try {
 // Dynamic imports MUST follow temp-path setup; config captures it at import time.
 const { startPersistentAgentConnection } = await import('../../src/modules/persistent-agent-connection.js');
 if (process.env.HIP4_FIXTURE_REPLACEMENT === '1') {
  const { importWallet } = await import('../../src/modules/auth.js');
  const { saveConfig } = await import('../../src/modules/config.js');
  const imported = await importWallet(priorOwner.privateKey);
  await saveConfig({walletAddress:priorOwner.address, authMode:'wallet', hlNetwork:'testnet', encrypted:{privateKey:imported.encryptedPrivateKey}, language:'ru'});
 }
 app = await startPersistentAgentConnection({port:Number(process.env.HIP4_FIXTURE_PORT || 8789), fetchImpl:getAgents});
 // Print only synthetic public metadata and the short-lived local fixture URL.
 process.stdout.write(`${JSON.stringify({url:app.url, owner:owner.address, agent:agent.address, previousOwner:process.env.HIP4_FIXTURE_REPLACEMENT === '1' ? priorOwner.address : null, dataDir})}\n`);
 for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().then(() => process.exit(0)); });
} catch (error) {
 await cleanup();
 throw error;
}
