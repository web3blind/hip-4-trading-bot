import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { loadConfig, mutateConfig } from '../config.js';

const FORMAT = /^hip4mcp_[A-Za-z0-9_-]{43}$/;
const SCOPES = new Set(['read', 'trade']);
let queue = Promise.resolve();

function serial(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

export async function issueMcpKey(scope) {
  if (!SCOPES.has(scope)) throw new Error('Invalid MCP scope');
  return serial(async () => {
    const token = `hip4mcp_${randomBytes(32).toString('base64url')}`;
    await mutateConfig(config => {
      const keys = (config.mcp?.keys || []).filter(k => k.scope !== scope);
      keys.push({ id: randomBytes(8).toString('hex'), generation: randomBytes(12).toString('hex'), scope,
        hash: createHash('sha256').update(token).digest('hex'), createdAt: new Date().toISOString() });
      config.mcp = { keys };
    });
    return token; // Only the authorized private Telegram chat receives this value, once.
  });
}

export async function revokeMcpKey(scope) {
  if (!SCOPES.has(scope)) throw new Error('Invalid MCP scope');
  return serial(async () => {
    await mutateConfig(config => {
      config.mcp = { keys: (config.mcp?.keys || []).filter(k => k.scope !== scope) };
    });
  });
}

export async function listMcpKeys() {
  const config = await loadConfig();
  return (config.mcp?.keys || []).filter(k => SCOPES.has(k.scope)).map(k => ({ scope: k.scope, createdAt: k.createdAt }));
}

export async function isMcpCredentialCurrent(credential) {
  if (!credential || !SCOPES.has(credential.scope)) return false;
  const config = await loadConfig();
  return (config.mcp?.keys || []).some(k => k.id === credential.id && k.scope === credential.scope && k.generation === credential.generation);
}

export async function authenticateMcp(authorization) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null;
  const token = authorization.slice(7);
  if (!FORMAT.test(token)) return null;
  const hash = createHash('sha256').update(token).digest();
  const config = await loadConfig();
  for (const entry of config.mcp?.keys || []) {
    if (!SCOPES.has(entry.scope) || !/^[a-f0-9]{64}$/.test(entry.hash || '')) continue;
    if (timingSafeEqual(hash, Buffer.from(entry.hash, 'hex'))) {
      return { id: entry.id, scope: entry.scope, generation: entry.generation };
    }
  }
  return null;
}
