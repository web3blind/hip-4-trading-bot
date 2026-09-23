import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

const dir = await mkdtemp(join(tmpdir(), 'hip4-mcp-bridge-'));
process.env.HIP4_DATA_DIR = dir;
process.env.LOG_TO_FILE = 'false';
const { issueMcpKey, revokeMcpKey } = await import('../../src/modules/mcp/key-store.js');
const { startMcpBroker, stopMcpBroker, MCP_SOCKET } = await import('../../src/modules/mcp/broker.js');
const { startMcpServer } = await import('../../src/mcp-server.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

test.after(async () => { await stopMcpBroker(); await rm(dir, { recursive: true, force: true }); });
function socketCall(token, path = '/auth') {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: MCP_SOCKET, path, method: 'GET', headers: { Host: 'localhost', Authorization: `Bearer ${token}` } }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject); req.end();
  });
}

test('broker is a private Unix socket; revocation invalidates frontend sessions immediately', async t => {
  const key = await issueMcpKey('read');
  await startMcpBroker({ operation: async (name, args, identity) => ({ name, args, scope: identity.scope }) });
  t.after(async () => stopMcpBroker());
  assert.equal((await stat(MCP_SOCKET)).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, 'runtime'))).mode & 0o777, 0o700);
  assert.equal(await socketCall('invalid'), 401);
  assert.equal(await socketCall(key), 200);
  const app = await startMcpServer({ port: 0 });
  t.after(async () => { await app.close(); });
  const client = new Client({ name: 'hip4-end-to-end', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${app.url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}`, Origin: app.url } }
  });
  await client.connect(transport);
  t.after(async () => client.close());
  const status = await client.callTool({ name: 'get_bot_status', arguments: {} });
  assert.deepEqual(JSON.parse(status.content[0].text), { name: 'get_bot_status', args: {}, scope: 'read' });
  await revokeMcpKey('read');
  await assert.rejects(() => client.listTools());
});

test('broker recovers only an owned orphaned socket and refuses a non-socket path', async () => {
  const orphan = join(dir, 'runtime', 'mcp.sock');
  execFileSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(orphan)},()=>process.exit(0))`], { timeout: 5000 });
  assert.equal((await stat(orphan)).isSocket(), true);
  await startMcpBroker();
  assert.equal(await socketCall(null), 401);
  await stopMcpBroker();
  await writeFile(orphan, 'not a socket');
  await assert.rejects(() => startMcpBroker(), /Unsafe MCP socket path/);
  await rm(orphan);
});
