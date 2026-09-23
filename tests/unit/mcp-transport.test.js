import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer } from '../../src/mcp-server.js';

const TOKEN = `hip4mcp_${'A'.repeat(43)}`;

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

async function fixture(t, { rpcHandler } = {}) {
  const events = [];
  const broker = createServer(async (req, res) => {
    const authorization = req.headers.authorization;
    if (req.method === 'GET' && req.url === '/auth') {
      events.push({ type: 'auth', authorization });
      res.writeHead(authorization === `Bearer ${TOKEN}` ? 200 : 403).end();
      return;
    }
    if (req.method === 'POST' && req.url === '/rpc') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      events.push({ type: 'rpc', authorization, body });
      const response = rpcHandler ? await rpcHandler(body) : { ok: true, operation: body.operation, args: body.args };
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(response));
      return;
    }
    res.writeHead(404).end();
  });
  const brokerUrl = await listen(broker);
  const app = await startMcpServer({ port: 0, brokerUrl });
  t.after(async () => { await app.close(); await close(broker); });
  return { ...app, events };
}

function clientFor(url, token = TOKEN) {
  const client = new Client({ name: 'hip4-mcp-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, Origin: url } }
  });
  return { client, transport };
}

function rawRequest(url, { method = 'POST', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL('/mcp', url);
    const req = httpRequest(target, { method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('real MCP client lists all tools and forwards bounded calls after per-request auth', async t => {
  const f = await fixture(t);
  const { client, transport } = clientFor(f.url);
  await client.connect(transport);
  t.after(() => client.close());

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [
    'get_action_status', 'get_balances', 'get_bot_status', 'get_market',
    'get_open_orders', 'get_orderbook', 'get_positions', 'get_recent_fills',
    'list_markets', 'request_cancel_orders', 'request_limit_order', 'request_market_order'
  ]);
  assert.match(listed.tools.find(tool => tool.name === 'request_market_order').description, /Telegram approval/i);

  const result = await client.callTool({ name: 'get_orderbook', arguments: { coin: '#21460' } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), { ok: true, operation: 'get_orderbook', args: { coin: '#21460' } });

  const rpcIndex = f.events.findIndex(event => event.type === 'rpc');
  assert.ok(rpcIndex > 0);
  assert.equal(f.events[rpcIndex - 1].type, 'auth');
  assert.equal(f.events[rpcIndex].authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(f.events[rpcIndex].body, { operation: 'get_orderbook', args: { coin: '#21460' } });
  assert.ok(f.events.filter(event => event.type === 'auth').length >= 3);
});

test('trade calls only request broker approval and schemas reject unsafe or unbounded arguments', async t => {
  const f = await fixture(t);
  const { client, transport } = clientFor(f.url);
  await client.connect(transport);
  t.after(() => client.close());

  const requested = await client.callTool({
    name: 'request_limit_order',
    arguments: { coin: '#21460', is_buy: true, size: 20, price: 0.5, request_id: 'test-req-1234', credential: TOKEN }
  });
  assert.equal(requested.isError, undefined);
  const rpc = f.events.find(event => event.type === 'rpc');
  assert.deepEqual(rpc.body, {
    operation: 'request_limit_order',
    args: { coin: '#21460', is_buy: true, size: 20, price: 0.5, request_id: 'test-req-1234' }
  });
  assert.equal(JSON.stringify(rpc.body).includes(TOKEN), false);

  const invalid = await client.callTool({ name: 'request_cancel_orders', arguments: { coin: '#21460', oids: Array.from({ length: 6 }, (_, i) => i + 1), request_id: 'test-req-5678' } });
  assert.equal(invalid.isError, true);
  assert.equal(f.events.filter(event => event.type === 'rpc').length, 1);
});

test('strict transport rejects bad host, origin, bearer, oversized bodies, and emits no CORS headers', async t => {
  const f = await fixture(t);
  const validHeaders = { Host: new URL(f.url).host, Origin: f.url, Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });

  const badHost = await rawRequest(f.url, { headers: { ...validHeaders, Host: 'evil.example' }, body: initialize });
  const badOrigin = await rawRequest(f.url, { headers: { ...validHeaders, Origin: 'https://evil.example' }, body: initialize });
  const badBearer = await rawRequest(f.url, { headers: { ...validHeaders, Authorization: 'Bearer not-a-key' }, body: initialize });
  const tooLarge = await rawRequest(f.url, { headers: { ...validHeaders, 'Content-Length': '70000' }, body: 'x'.repeat(70000) });

  assert.deepEqual([badHost.status, badOrigin.status, badBearer.status, tooLarge.status], [403, 403, 401, 413]);
  for (const response of [badHost, badOrigin, badBearer, tooLarge]) {
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.body.includes(TOKEN), false);
  }
});

test('broker failures and sensitive broker fields are redacted from MCP results', async t => {
  let fail = false;
  const f = await fixture(t, { rpcHandler: body => {
    if (body.operation === 'list_markets') return [{ market: 'BTC-USD' }];
    return fail ? { error: `failed for ${TOKEN}` } : { operation: body.operation, token: TOKEN, privateKey: '0xsecret', nested: { credential: 'hidden', value: 7 } };
  } });
  const { client, transport } = clientFor(f.url);
  await client.connect(transport);
  t.after(() => client.close());

  const safe = await client.callTool({ name: 'get_bot_status', arguments: {} });
  const text = safe.content[0].text;
  assert.equal(text.includes(TOKEN), false);
  assert.equal(text.includes('0xsecret'), false);
  assert.deepEqual(JSON.parse(text), { operation: 'get_bot_status', token: '[REDACTED]', privateKey: '[REDACTED]', nested: { credential: '[REDACTED]', value: 7 } });

  const arrayResult = await client.callTool({ name: 'list_markets', arguments: { page: 1 } });
  assert.deepEqual(JSON.parse(arrayResult.content[0].text), [{ market: 'BTC-USD' }]);

  fail = true;
  const failed = await client.callTool({ name: 'get_bot_status', arguments: {} });
  assert.equal(failed.isError, true);
  assert.equal(failed.content[0].text.includes(TOKEN), false);
  assert.match(failed.content[0].text, /request failed/i);
});
