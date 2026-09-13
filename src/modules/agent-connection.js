import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ethers } from 'ethers';

export const OUTCOME_BUILDER = '0xab5dbc057628bc18523c4cdfc0e1e2ebdbecb704';
const ZERO = ethers.constants.AddressZero;
const SESSION_MS = 15 * 60_000;
const APPROVAL_MS = 24 * 60 * 60_000;
const TYPES = {
  approveAgent: ['HyperliquidTransaction:ApproveAgent', [
    { name: 'hyperliquidChain', type: 'string' }, { name: 'agentAddress', type: 'address' },
    { name: 'agentName', type: 'string' }, { name: 'nonce', type: 'uint64' },
  ]],
  approveBuilderFee: ['HyperliquidTransaction:ApproveBuilderFee', [
    { name: 'hyperliquidChain', type: 'string' }, { name: 'maxFeeRate', type: 'string' },
    { name: 'builder', type: 'address' }, { name: 'nonce', type: 'uint64' },
  ]],
};
function problem(status, message) { return Object.assign(new Error(message), { status }); }
function exactKeys(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).length !== keys.length || Object.keys(body).some(k => !keys.includes(k))) {
    throw problem(400, 'Invalid request fields');
  }
}
function approval(action, network) {
  const [primaryType, fields] = TYPES[action.type];
  return { domain: { name: 'HyperliquidSignTransaction', version: '1',
    chainId: network === 'mainnet' ? 42161 : 421614, verifyingContract: ZERO },
  types: { [primaryType]: fields }, primaryType, message: action };
}
async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw problem(415, 'JSON required');
  let bytes = 0; const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 8192) throw problem(413, 'Request too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw problem(400, 'Invalid JSON'); }
}
function secureEqual(value, expected) {
  const a = Buffer.from(value || ''); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Loopback-only, one-use owner approval. Agent key never leaves process memory. */
export async function startAgentConnection({ port = 8787, fetchImpl = fetch, onConnected } = {}) {
  if (typeof onConnected !== 'function') throw new Error('onConnected is required');
  const token = randomBytes(32).toString('hex');
  const deadline = Date.now() + SESSION_MS;
  let origin;
  let pending = null;
  let connected = false;
  let processing = false;
  let requests = [];
  const files = {
    '/': [new URL('../connect-ui/index.html', import.meta.url), 'text/html; charset=utf-8'],
    '/app.js': [new URL('../connect-ui/app.js', import.meta.url), 'text/javascript; charset=utf-8'],
    '/style.css': [new URL('../connect-ui/style.css', import.meta.url), 'text/css; charset=utf-8'],
    '/ethers.js': [new URL('../../node_modules/ethers/dist/ethers.umd.min.js', import.meta.url), 'text/javascript; charset=utf-8'],
  };
  async function api(network, endpoint, payload) {
    const base = network === 'mainnet' ? 'https://api.hyperliquid.xyz' : 'https://api.hyperliquid-testnet.xyz';
    try {
      const response = await fetchImpl(`${base}/${endpoint}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!response.ok) throw new Error('HTTP failure');
      const data = await response.json();
      if (endpoint === 'exchange' && (data?.status !== 'ok' || data?.response?.type !== 'default')) throw new Error('Approval refused');
      return data;
    } catch { throw problem(502, 'Approval not verified. Check API permissions in Hyperliquid before retrying; revoke unused HIP4 Bot agents.'); }
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    function json(status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
    try {
      if (req.headers.host !== new URL(origin).host) throw problem(403, 'Invalid host');
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && files[url.pathname]) {
        const [path, contentType] = files[url.pathname];
        res.writeHead(200, { 'Content-Type': contentType }); res.end(await readFile(path)); return;
      }
      if (!url.pathname.startsWith('/api/')) throw problem(404, 'Not found');
      if (req.headers.origin !== origin || !secureEqual(req.headers.authorization, `Bearer ${token}`)) throw problem(403, 'Open the local connection link printed by the bot');
      if (Date.now() > deadline) { pending = null; throw problem(410, 'Connection session expired; restart the connector'); }
      requests = requests.filter(time => time > Date.now() - 60_000);
      if (requests.length >= 30) throw problem(429, 'Too many requests');
      requests.push(Date.now());
      if (url.pathname === '/api/session' && req.method === 'GET') {
        json(200, { connected, builderAddress: OUTCOME_BUILDER, expiresAt: deadline }); return;
      }
      if (req.method !== 'POST') throw problem(405, 'Method not allowed');
      if (processing || connected) throw problem(409, 'Connection already submitted');
      const body = await readJson(req);
      // Reading an HTTP body yields: another request may consume this session meanwhile.
      if (processing || connected) throw problem(409, 'Connection already submitted');
      if (url.pathname === '/api/prepare') {
        exactKeys(body, ['address', 'network', 'builderEnabled']);
        if (!ethers.utils.isAddress(body.address) || body.address === ZERO || !['mainnet','testnet'].includes(body.network) || typeof body.builderEnabled !== 'boolean') throw problem(400, 'Invalid account or network');
        const owner = ethers.utils.getAddress(body.address);
        const agent = ethers.Wallet.createRandom();
        const nonce = Date.now();
        const network = body.network;
        const common = { hyperliquidChain: network === 'mainnet' ? 'Mainnet' : 'Testnet', signatureChainId: network === 'mainnet' ? '0xa4b1' : '0x66eee' };
        const actions = [{ type: 'approveAgent', ...common, agentAddress: agent.address,
          agentName: `HIP4 Bot valid_until ${nonce + APPROVAL_MS}`, nonce }];
        if (body.builderEnabled) actions.push({ type: 'approveBuilderFee', ...common, maxFeeRate: '0%', builder: OUTCOME_BUILDER, nonce: nonce + 1 });
        pending = { id: randomBytes(16).toString('hex'), owner, agent, network, actions,
          builderEnabled: body.builderEnabled, expiresAt: nonce + 5 * 60_000 };
        json(200, { id: pending.id, accountAddress: owner, agentAddress: agent.address, network,
          expiresAt: nonce + APPROVAL_MS, approvals: actions.map(a => approval(a, network)) }); return;
      }
      if (url.pathname !== '/api/complete') throw problem(404, 'Not found');
      exactKeys(body, ['id', 'signatures']);
      if (!pending || body.id !== pending.id || Date.now() > pending.expiresAt) throw problem(409, 'Approval review expired');
      if (!Array.isArray(body.signatures) || body.signatures.length !== pending.actions.length) throw problem(400, 'Missing signatures');
      const current = pending;
      const signatures = current.actions.map((action, i) => {
        const typed = approval(action, current.network);
        try {
          const recovered = ethers.utils.verifyTypedData(typed.domain, typed.types, typed.message, body.signatures[i]);
          if (recovered.toLowerCase() !== current.owner.toLowerCase()) throw new Error('Wrong owner');
          const { r,s,v } = ethers.utils.splitSignature(body.signatures[i]); return { r,s,v };
        } catch { throw problem(400, 'Signature does not match the reviewed owner and approval'); }
      });
      // Consume before network writes: a timeout must never trigger a blind retry.
      pending = null; processing = true;
      try {
        for (let i = 0; i < current.actions.length; i++) {
          const action = current.actions[i];
          await api(current.network, 'exchange', { action, nonce: action.nonce, signature: signatures[i] });
        }
        const agents = await api(current.network, 'info', { type: 'extraAgents', user: current.owner });
        const approvedAgent = Array.isArray(agents) && agents.find(a => String(a.address).toLowerCase() === current.agent.address.toLowerCase() && Number(a.validUntil) > Date.now());
        if (!approvedAgent) throw problem(502, 'Agent approval not found in account permissions; reconnect or revoke it in Hyperliquid');
        if (current.builderEnabled) {
          const maxFee = await api(current.network, 'info', { type: 'maxBuilderFee', user: current.owner, builder: OUTCOME_BUILDER });
          if (maxFee !== 0) throw problem(502, 'Zero builder fee cap not confirmed');
        }
        await onConnected({ accountAddress: current.owner, agentAddress: current.agent.address,
          privateKey: current.agent.privateKey, network: current.network, builderEnabled: current.builderEnabled,
          expiresAt: Math.min(Number(approvedAgent.validUntil), current.actions[0].nonce + APPROVAL_MS) });
        connected = true;
        json(200, { connected: true, accountAddress: current.owner, network: current.network });
      } finally { processing = false; }
    } catch (error) {
      if (!res.headersSent) json(error.status || 500, { error: error.status ? error.message : 'Connection failed; check Hyperliquid permissions and revoke unused agents' });
      else res.end();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, url: `${origin}/#${token}`, close: () => {
    pending = null; server.closeAllConnections(); return new Promise(resolve => server.close(resolve));
  } };
}
