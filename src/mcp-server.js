import { createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/v4';
import { isOutcomeCoin } from './modules/hl-encoding.js';

const DEFAULT_PORT = 19120;
const DEFAULT_BROKER_SOCKET = process.env.HIP4_DATA_DIR
  ? join(process.env.HIP4_DATA_DIR, 'runtime', 'mcp.sock')
  : fileURLToPath(new URL('../data/runtime/mcp.sock', import.meta.url));
const BODY_LIMIT = 64 * 1024;
const BEARER_RE = /^Bearer (hip4mcp_[A-Za-z0-9_-]{43})$/;
const SENSITIVE_KEY_RE = /(?:authorization|credential|mnemonic|private.?key|secret|seed|token)/i;

const problem = (status, message) => Object.assign(new Error(message), { status });
const coin = z.string().refine(isOutcomeCoin, 'Canonical HIP-4 outcome coin required').describe('HIP-4 outcome coin, e.g. #21460');
const page = z.number().int().min(1).max(100).default(1);
const amount = z.number().finite().positive().max(1_000_000);
const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/).describe('Unique idempotency key; reuse only for identical retries');
const oid = z.number().int().positive().safe();

function redactSensitive(value, bearer) {
  if (typeof value === 'string') return value.split(bearer).join('[REDACTED]');
  if (Array.isArray(value)) return value.map(item => redactSensitive(item, bearer));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : redactSensitive(item, bearer)
  ]));
}

function toolResult(value, bearer) {
  return { content: [{ type: 'text', text: JSON.stringify(redactSensitive(value, bearer)) }] };
}

function toolFailure() {
  return { isError: true, content: [{ type: 'text', text: 'Broker request failed' }] };
}

function registerTools(server, callBroker) {
  const tools = [
    ['get_bot_status', 'Get bot health and configured network status.', {}],
    ['list_markets', 'List active HIP-4 outcome markets with category/deployer filters; 20 results per page. Prices are cached, not execution prices.', {
      page,
      category: z.enum(['all', 'sports', 'prices', 'economy', 'business', 'other']).optional(),
      venue: z.string().regex(/^[a-z0-9_]{1,16}$/).optional()
    }],
    ['get_market', 'Get one HIP-4 outcome by numeric ID.', { outcome_id: z.number().int().nonnegative().safe() }],
    ['get_orderbook', 'Get up to five bid/ask levels for an outcome coin.', { coin }],
    ['get_balances', 'Get available Spot and outcome USDC, without credentials.', {}],
    ['get_positions', 'Get open outcome positions and indicative unrealized return.', { page }],
    ['get_open_orders', 'Get open HIP-4 orders; 20 per page.', { page }],
    ['get_recent_fills', 'Get recent HIP-4 fills; 20 per page.', { page }],
    ['request_market_order', 'Request owner Telegram approval for a live IOC order; BUY amount is a USDC budget, SELL amount is shares. Never submits directly or transfers funds.', {
      coin, is_buy: z.boolean(), amount, slippage_pct: z.number().positive().max(20).default(2), request_id: requestId
    }],
    ['request_limit_order', 'Request owner Telegram approval for a live GTC limit order; never submits directly or transfers funds.', {
      coin, is_buy: z.boolean(), price: z.number().positive().max(0.99999), size: amount, request_id: requestId
    }],
    ['request_cancel_orders', 'Request owner Telegram approval to cancel up to five explicit OIDs on one HIP-4 coin; never submits directly.', {
      coin, oids: z.array(oid).min(1).max(5), request_id: requestId
    }],
    ['get_action_status', 'Get status of a previously requested Telegram approval action.', { action_id: z.string().regex(/^[a-f0-9]{20}$/) }]
  ];

  for (const [name, description, inputSchema] of tools) {
    server.registerTool(name, { description, inputSchema }, async args => {
      try {
        return toolResult(await callBroker(name, args), callBroker.bearer);
      } catch {
        return toolFailure();
      }
    });
  }
}

function json(res, status, value) {
  if (res.headersSent) return res.end();
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(JSON.stringify(value));
}

async function readJson(req, bodyLimit) {
  if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw problem(415, 'JSON required');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > bodyLimit) {
    req.resume();
    throw problem(413, 'Request too large');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > bodyLimit) {
      req.resume();
      throw problem(413, 'Request too large');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw problem(400, 'Invalid JSON');
  }
}

function safeBrokerOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Broker URL must be a loopback HTTP origin');
  }
  return url.origin;
}

function unixRequest(socketPath, method, path, bearer, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method, headers: {
      Host: 'localhost', Authorization: `Bearer ${bearer}`,
      ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {})
    } }, res => {
      let length = 0, data = '';
      res.on('data', chunk => {
        length += chunk.length;
        if (length > BODY_LIMIT) { req.destroy(); reject(new Error('Broker response too large')); return; }
        data += chunk.toString('utf8');
      });
      res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(data) }));
    });
    req.setTimeout(10_000, () => req.destroy(new Error('Broker timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

/** Start the stateless HIP-4 MCP HTTP frontend. */
export async function startMcpServer({ port = DEFAULT_PORT, brokerSocket = DEFAULT_BROKER_SOCKET, brokerUrl, fetchImpl = fetch, bodyLimit = BODY_LIMIT } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid MCP port');
  if (!Number.isInteger(bodyLimit) || bodyLimit < 1024 || bodyLimit > BODY_LIMIT) throw new Error('Invalid body limit');
  const brokerOrigin = brokerUrl ? safeBrokerOrigin(brokerUrl) : null;
  if (!brokerOrigin && (!brokerSocket.startsWith('/') || !brokerSocket.endsWith('/mcp.sock'))) throw new Error('Private MCP broker socket required');
  let origin;

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (req.headers.host !== new URL(origin).host) throw problem(403, 'Forbidden');
      if (req.headers.origin !== undefined && req.headers.origin !== origin) throw problem(403, 'Forbidden');
      const match = BEARER_RE.exec(req.headers.authorization || '');
      if (!match) throw problem(401, 'Unauthorized');
      const bearer = match[1];

      const authResponse = brokerOrigin ? await fetchImpl(`${brokerOrigin}/auth`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${bearer}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(5000)
      }) : await unixRequest(brokerSocket, 'GET', '/auth', bearer);
      if (authResponse.status !== 200) throw problem(401, 'Unauthorized');

      const url = new URL(req.url, origin);
      if (url.origin !== origin || url.pathname !== '/mcp' || url.search || url.hash) throw problem(404, 'Not found');
      if (req.method !== 'POST') throw problem(405, 'Method not allowed');
      const body = await readJson(req, bodyLimit);

      const callBroker = async (operation, args) => {
        const payload = JSON.stringify({ operation, args });
        const response = brokerOrigin ? await fetchImpl(`${brokerOrigin}/rpc`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
          body: payload,
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000)
        }) : await unixRequest(brokerSocket, 'POST', '/rpc', bearer, payload);
        if (response.status !== 200) throw new Error('Broker request failed');
        const value = await response.json();
        if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'error')) throw new Error('Broker request failed');
        return value;
      };
      callBroker.bearer = bearer;

      const mcp = new McpServer({ name: 'hip-4-telegram-bot', version: '1.0.0' });
      registerTools(mcp, callBroker);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      let cleaned = false;
      const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        await transport.close().catch(() => {});
        await mcp.close().catch(() => {});
      };
      res.once('close', cleanup);
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      json(res, error.status || 500, {
        jsonrpc: '2.0',
        error: { code: error.status === 401 ? -32001 : -32603, message: error.status ? error.message : 'Internal server error' },
        id: null
      });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    url: origin,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMcpServer().then(app => {
    process.stdout.write(`HIP-4 MCP listening on ${app.url}/mcp\n`);
  }).catch(() => {
    process.stderr.write('HIP-4 MCP failed to start\n');
    process.exitCode = 1;
  });
}
