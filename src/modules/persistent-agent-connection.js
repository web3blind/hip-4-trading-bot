import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { DATA_DIR, loadConfig, saveConfig } from './config.js';
import { encrypt, decrypt, getMachineKey, importWallet, validateWalletConfig, verifyAgentAuthorization } from './auth.js';

const problem = (status, message) => Object.assign(new Error(message), { status });
function fields(body, keys) {
  if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length !== keys.length || Object.keys(body).some(k => !keys.includes(k))) throw problem(400, 'Invalid request fields');
}
async function disk() {
  try { return await readFile(join(DATA_DIR, 'config.json'), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function bodyJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw problem(415, 'JSON required');
  if (Number(req.headers['content-length']) > 4096) { req.resume(); throw problem(413, 'Request too large'); }
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 4096) throw problem(413, 'Request too large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw problem(400, 'Invalid JSON'); }
}

/** Durable connector. Callers must hold the shared runtime lock before starting. */
export async function startPersistentAgentConnection({ port = 8787, fetchImpl = fetch } = {}) {
  const token = randomBytes(32).toString('hex');
  const deadline = Date.now() + 15 * 60_000;
  let origin, pending = null, processing = false, saved = false, closed = false;
  let requests = [];
  let processingDone = Promise.resolve();
  let releaseProcessing;
  const clearPending = () => { pending = null; };
  const timer = setInterval(() => { if (pending && (Date.now() >= pending.expiresAt || Date.now() >= deadline)) clearPending(); }, 1000);
  timer.unref();
  const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      if (closed || req.headers.host !== new URL(origin).host) throw problem(403, 'Invalid host');
      const url = new URL(req.url, origin);
      if (url.origin !== origin) throw problem(403, 'Invalid host');
      if (req.method === 'GET' && files[url.pathname]) {
        const [name, type] = files[url.pathname];
        const content = await readFile(new URL(`../api-wallet-ui/${name}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(content); return;
      }
      if (!url.pathname.startsWith('/api/')) throw problem(404, 'Not found');
      const actual = Buffer.from(req.headers.authorization || ''); const expected = Buffer.from(`Bearer ${token}`);
      // Same-origin browser GETs may omit Origin. Bearer + exact Host remain
      // mandatory; every write and any supplied Origin must match this origin.
      const originAllowed = req.headers.origin === origin || (req.method === 'GET' && req.headers.origin === undefined);
      if (!originAllowed || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw problem(403, 'Open the private local connection link');
      if (Date.now() >= deadline) { clearPending(); throw problem(410, 'Connection session expired; restart connector'); }
      requests = requests.filter(t => t > Date.now() - 60_000);
      if (requests.length >= 30) throw problem(429, 'Too many requests');
      requests.push(Date.now());
      if (req.method === 'GET' && url.pathname === '/api/session') {
        const config = await loadConfig();
        json(200, { saved, accountAddress: config.walletAddress || '', agentAddress: config.agentAddress || '', authMode: config.authMode || 'wallet', network: config.hlNetwork || 'testnet', validUntil: config.agentValidUntil || null, expiresAt: deadline }); return;
      }
      if (req.method !== 'POST') throw problem(405, 'Method not allowed');
      if (processing || saved) throw problem(409, 'Connection already submitted');
      const body = await bodyJson(req);
      if (processing || saved || closed) throw problem(409, 'Connection already submitted');
      processing = true;
      processingDone = new Promise(resolve => { releaseProcessing = resolve; });
      try {
        if (url.pathname === '/api/cancel') { fields(body, ['id']); if (!pending || pending.id !== body.id) throw problem(409, 'Review expired'); clearPending(); json(200, { cancelled: true }); return; }
        if (url.pathname === '/api/prepare') {
          clearPending(); fields(body, ['accountAddress', 'privateKey', 'network']);
          if (!ethers.utils.isAddress(body.accountAddress) || body.accountAddress.toLowerCase() === ethers.constants.AddressZero || !['testnet', 'mainnet'].includes(body.network) || typeof body.privateKey !== 'string' || !/^(?:0x)?[a-fA-F0-9]{64}$/.test(body.privateKey)) throw problem(400, 'Invalid owner, API wallet key or network');
          let wallet;
          try { wallet = new ethers.Wallet(body.privateKey.startsWith('0x') ? body.privateKey : `0x${body.privateKey}`); } catch { throw problem(400, 'Invalid API wallet key'); }
          const accountAddress = ethers.utils.getAddress(body.accountAddress);
          if (accountAddress === wallet.address) throw problem(400, 'Use the API wallet key, never the owner key');
          const baseline = await disk(); const previous = await loadConfig();
          const validUntil = await verifyAgentAuthorization({ walletAddress: accountAddress, agentAddress: wallet.address, hlNetwork: body.network }, { fetchImpl });
          if (closed) throw problem(409, 'Connector closed');
          const review = { id: randomBytes(16).toString('hex'), accountAddress, agentAddress: wallet.address, network: body.network, validUntil, replacing: Boolean(previous.walletAddress || previous.encrypted?.privateKey), previousAccountAddress: previous.walletAddress || '' };
          pending = { ...review, privateKey: wallet.privateKey, baseline, previous, expiresAt: Date.now() + 5 * 60_000 };
          json(200, review); return;
        }
        if (url.pathname !== '/api/save') throw problem(404, 'Not found');
        fields(body, ['id', 'confirm']);
        if (!pending || pending.id !== body.id || Date.now() >= pending.expiresAt) { clearPending(); throw problem(409, 'Review expired'); }
        const current = pending; clearPending();
        if (body.confirm !== true) throw problem(400, 'Explicit confirmation required');
        if (await disk() !== current.baseline) throw problem(409, 'Current config changed; review again');
        const validUntil = await verifyAgentAuthorization({ walletAddress: current.accountAddress, agentAddress: current.agentAddress, hlNetwork: current.network }, { fetchImpl });
        const imported = await importWallet(current.privateKey);
        const config = { ...current.previous, authMode: 'agent', walletAddress: current.accountAddress, agentAddress: current.agentAddress, hlNetwork: current.network, agentValidUntil: validUntil,
          outcomeBuilderEnabled: current.previous.walletAddress?.toLowerCase() === current.accountAddress.toLowerCase() && current.previous.hlNetwork === current.network ? Boolean(current.previous.outcomeBuilderEnabled) : false,
          encrypted: { ...current.previous.encrypted, privateKey: imported.encryptedPrivateKey } };
        await validateWalletConfig(config);
        if (current.replacing && current.baseline !== null) {
          const key = await getMachineKey(); const encrypted = await encrypt(current.baseline, key);
          const backup = join(DATA_DIR, `config.backup-${Date.now()}-${randomBytes(6).toString('hex')}.enc`);
          const file = await open(backup, 'wx', 0o600);
          try { await file.writeFile(encrypted, 'utf8'); await file.sync(); } finally { await file.close(); }
          if (await decrypt(await readFile(backup, 'utf8'), key) !== current.baseline) throw new Error('Backup verification failed');
        }
        if (closed || await disk() !== current.baseline) throw problem(409, 'Current config changed; review again');
        await saveConfig(config, { expectedConfig: current.previous });
        const readback = await loadConfig();
        if (JSON.stringify(readback) !== JSON.stringify(config) || await validateWalletConfig(readback) !== current.privateKey) throw new Error('Readback verification failed');
        saved = true;
        json(200, { saved: true, accountAddress: current.accountAddress, agentAddress: current.agentAddress, network: current.network, validUntil });
        res.once('finish', () => server.emit('saved'));
      } finally { processing = false; releaseProcessing(); }
    } catch (error) {
      if (!res.headersSent) json(error.status || 500, { error: error.status ? error.message : 'Connection failed; existing configuration was not confirmed saved' }); else res.end();
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { clearInterval(timer); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, url: `${origin}/#${token}`, close: async () => { closed = true; clearPending(); clearInterval(timer); await processingDone; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
