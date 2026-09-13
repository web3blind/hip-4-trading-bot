import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { startAgentConnection } from '../../src/modules/agent-connection.js';

const owner = new ethers.Wallet('0x' + '1'.padStart(64, '0'));
const other = new ethers.Wallet('0x' + '2'.padStart(64, '0'));
async function fixture(t, options = {}) {
  const calls = [];
  let approved;
  let connected;
  const app = await startAgentConnection({ port: 0,
    fetchImpl: async (url, init) => {
      const payload = JSON.parse(init.body); calls.push({ url, payload });
      if (payload.action) {
        if (payload.action.type === 'approveAgent') approved = payload.action.agentAddress;
        return new Response(JSON.stringify({ status: 'ok', response: { type: 'default' } }));
      }
      return new Response(JSON.stringify(payload.type === 'extraAgents'
        ? [{ address: approved, validUntil: Date.now() + 86400000 }] : 0));
    },
    onConnected: async (data) => { connected = data; }, ...options,
  });
  t.after(() => app.close());
  const url = new URL(app.url); const token = url.hash.slice(1); url.hash = '';
  const request = (path, body, headers = {}) => fetch(new URL(path, url), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, Origin: url.origin, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { app, request, calls, get connected() { return connected; } };
}
async function prepare(f, builderEnabled = false) {
  const r = await f.request('/api/prepare', { address: owner.address, network: 'testnet', builderEnabled });
  assert.equal(r.status, 200); return r.json();
}
async function signatures(prepared, signer = owner) {
  return Promise.all(prepared.approvals.map(a => signer._signTypedData(a.domain, a.types, a.message)));
}
test('connector requires local origin, bearer token and validated JSON', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/session', undefined, { Authorization: '' })).status, 403);
  assert.equal((await f.request('/api/session', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/api/prepare', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.request('/api/prepare', { address: owner.address, network: 'other', builderEnabled: false })).status, 400);
  assert.equal((await f.request('/api/prepare', { address: owner.address, network: 'testnet', builderEnabled: false, privateKey: 'do-not-accept' })).status, 400);
  assert.equal(f.calls.length, 0);
});
test('owner signature, explicit network, readback and one-use approval connect ephemeral agent', async t => {
  const f = await fixture(t); const p = await prepare(f);
  assert.equal(p.approvals.length, 1);
  assert.equal(p.approvals[0].message.hyperliquidChain, 'Testnet');
  assert.equal(JSON.stringify(p).includes('privateKey'), false);
  assert.match(p.approvals[0].message.agentName, /valid_until /);
  const sigs = await signatures(p);
  const r = await f.request('/api/complete', { id: p.id, signatures: sigs });
  assert.equal(r.status, 200);
  const result = await r.json(); assert.equal(result.connected, true);
  assert.equal(f.connected.accountAddress, owner.address);
  assert.equal(new ethers.Wallet(f.connected.privateKey).address, p.agentAddress);
  assert.equal(f.connected.network, 'testnet');
  assert.equal(JSON.stringify(result).includes(f.connected.privateKey), false);
  assert.equal(f.calls.filter(c => c.payload.action).length, 1);
  assert.equal(f.calls.at(-1).payload.type, 'extraAgents');
  assert.equal((await f.request('/api/complete', { id: p.id, signatures: sigs })).status, 409);
});
test('wrong owner signature cannot submit any approval', async t => {
  const f = await fixture(t); const p = await prepare(f);
  assert.equal((await f.request('/api/complete', { id: p.id, signatures: await signatures(p, other) })).status, 400);
  assert.equal(f.calls.length, 0);
});
test('Outcome attribution is opt-in and approval caps builder fee at zero', async t => {
  const f = await fixture(t); const p = await prepare(f, true);
  assert.equal(p.approvals.length, 2);
  assert.equal(p.approvals[1].message.maxFeeRate, '0%');
  assert.equal(p.approvals[1].message.builder, '0xab5dbc057628bc18523c4cdfc0e1e2ebdbecb704');
  assert.equal((await f.request('/api/complete', { id: p.id, signatures: await signatures(p) })).status, 200);
  assert.equal(f.connected.builderEnabled, true);
});
test('HTTP approvals activate the real owner/signer client and ephemeral config without replacing disk wallet', async t => {
  const { activateConnectedAgent } = await import('../../scripts/connect-agent.js');
  const { saveConfig, loadConfig, setSessionConfig, isWalletConfigured } = await import('../../src/modules/config.js');
  const previous = { walletAddress: other.address, encrypted: { privateKey: 'synthetic-encrypted-value' }, language: 'en' };
  await saveConfig(previous);
  t.after(() => setSessionConfig(null));
  let activated; let starts = 0;
  const f = await fixture(t, { onConnected: async session => {
    await activateConnectedAgent(session, previous, {
      init: async () => {}, activate: async client => { activated = client; }, start: () => { starts++; },
    });
  } });
  const p = await prepare(f, true);
  assert.equal((await f.request('/api/complete', { id: p.id, signatures: await signatures(p) })).status, 200);
  assert.equal(starts, 1);
  assert.equal(await activated.getAddress(), owner.address);
  assert.equal(activated.wallet.address, p.agentAddress);
  assert.equal(activated.authMode, 'agent');
  assert.equal(activated.builder.f, 0);
  assert.equal(activated.network, 'testnet');
  const config = await loadConfig();
  assert.equal(config.outcomeBuilderEnabled, true);
  assert.ok(config.agentValidUntil > Date.now() + 60000);
  assert.equal(await isWalletConfigured(), true);
  assert.equal(config.encrypted.privateKey, '');
  setSessionConfig(null);
  assert.deepEqual(await loadConfig(), previous);
});

test('connector launcher releases singleton after stop and occupied-port failure', async t => {
  const { runAgentConnector } = await import('../../scripts/connect-agent.js');
  process.env.TELEGRAM_BOT_TOKEN = '123:synthetic'; process.env.TELEGRAM_ALLOWED_USER_ID = '123';
  t.after(() => { delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_ALLOWED_USER_ID; });
  const occupied = await fixture(t);
  await assert.rejects(runAgentConnector({ port: new URL(occupied.app.url).port, onConnected: async () => {} }), /EADDRINUSE/);
  const app = await runAgentConnector({ port: 0, onConnected: async () => {} });
  await app.stop();
  const second = await runAgentConnector({ port: 0, onConnected: async () => {} });
  await second.stop();
});

test('HTTP success with exchange refusal never activates bot', async t => {
  const f = await fixture(t, { fetchImpl: async () => new Response(JSON.stringify({ status: 'err', response: 'rejected' })) });
  const p = await prepare(f);
  assert.equal((await f.request('/api/complete', { id: p.id, signatures: await signatures(p) })).status, 502);
  assert.equal(f.connected, undefined);
});
