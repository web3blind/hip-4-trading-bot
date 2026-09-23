import { createServer, request as httpRequest } from 'node:http';
import { mkdir, chmod, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from '../config.js';
import { authenticateMcp } from './key-store.js';
import { mcpOperation } from './operations.js';

export const MCP_SOCKET = join(DATA_DIR, 'runtime', 'mcp.sock');
let server = null;
let socketIdentity = null;
let activeSocketPath = null;
let active = 0;

async function removeStaleSocket(socketPath) {
  let stale;
  try { stale = await lstat(socketPath); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stale.isSocket() || stale.uid !== process.getuid()) throw new Error('Unsafe MCP socket path');
  const live = await new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path: '/auth', method: 'GET', headers: { Host: 'localhost' } }, res => {
      res.resume(); resolve(true); // Even 401 means a live broker owns the socket.
    });
    req.setTimeout(1500, () => req.destroy(new Error('MCP socket probe timed out')));
    req.on('error', error => error.code === 'ECONNREFUSED' ? resolve(false) : reject(error));
    req.end();
  });
  if (live) throw new Error('MCP broker socket already active');
  const current = await lstat(socketPath);
  if (!current.isSocket() || current.uid !== process.getuid() || current.ino !== stale.ino || current.dev !== stale.dev) throw new Error('MCP socket changed during recovery');
  await unlink(socketPath);
}

export async function startMcpBroker({ socketPath = MCP_SOCKET, operation = mcpOperation } = {}) {
  if (server) throw new Error('MCP broker already started');
  const instance = createServer(async (req, res) => {
    const reply = (status, data) => {
      if (res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };
    try {
      if (!/^(?:localhost|127\.0\.0\.1)(?::[0-9]+)?$/.test(req.headers.host || '') ||
          (req.headers.origin && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::[0-9]+)?$/.test(req.headers.origin))) return reply(403, { error: 'Forbidden' });
      const identity = await authenticateMcp(req.headers.authorization);
      if (!identity) return reply(401, { error: 'Unauthorized' });
      if (req.method === 'GET' && req.url === '/auth') return reply(200, { ok: true });
      if (req.method !== 'POST' || req.url !== '/rpc') return reply(404, { error: 'Not found' });
      if (++active > 8) { active--; return reply(429, { error: 'Busy' }); }
      try {
        let length = 0, text = '';
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 8192) return reply(413, { error: 'Request too large' });
          text += chunk.toString('utf8');
        }
        let body;
        try { body = JSON.parse(text); } catch { return reply(400, { error: 'Invalid JSON' }); }
        if (!body || typeof body !== 'object' || typeof body.operation !== 'string' || !body.args ||
            typeof body.args !== 'object' || Array.isArray(body.args)) return reply(400, { error: 'Invalid request' });
        const result = await operation(body.operation, body.args, identity);
        return reply(200, result);
      } finally { active--; }
    } catch {
      return reply(400, { error: 'Request rejected' }); // Never echo credentials, config, wallet or provider response.
    }
  });
  instance.requestTimeout = 10_000;
  instance.headersTimeout = 10_000;
  const dir = join(DATA_DIR, 'runtime');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await lstat(dir)).isDirectory()) throw new Error('MCP runtime directory is not a directory');
  await chmod(dir, 0o700);
  // Recover only an owned, verified orphan. A responding broker is never displaced.
  await removeStaleSocket(socketPath);
  try {
    await new Promise((resolve, reject) => { instance.once('error', reject); instance.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
    socketIdentity = await lstat(socketPath);
    activeSocketPath = socketPath;
    server = instance;
    return instance;
  } catch (error) {
    instance.close();
    throw error;
  }
}

export async function stopMcpBroker() {
  const instance = server;
  server = null;
  if (!instance) return;
  instance.closeAllConnections?.();
  await new Promise(resolve => instance.close(resolve));
  try {
    const current = await lstat(activeSocketPath);
    if (socketIdentity && current.dev === socketIdentity.dev && current.ino === socketIdentity.ino) await unlink(activeSocketPath);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  socketIdentity = null;
  activeSocketPath = null;
}
