import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ethers } from 'ethers';
import { startPersistentAgentConnection } from '../../src/modules/persistent-agent-connection.js';
import { DATA_DIR, loadConfig, saveConfig } from '../../src/modules/config.js';
import { decrypt, getMachineKey, importWallet } from '../../src/modules/auth.js';
import { createConfiguredHLClient } from '../../src/modules/bot/runtime.js';
const owner = new ethers.Wallet('0x' + '1'.padStart(64, '0'));
const agent = new ethers.Wallet('0x' + '2'.padStart(64, '0'));
const other = new ethers.Wallet('0x' + '3'.padStart(64, '0'));
const payload = { accountAddress: owner.address, privateKey: agent.privateKey, network: 'testnet' };
async function fixture(t) {
  assert.ok(process.env.HIP4_DATA_DIR);
  await rm(join(DATA_DIR, 'config.json'), { force: true });
  const state = { validUntil: Date.now() + 86400000, fail: false, revoked: false, calls: [] };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); state.calls.push({ url, body });
    assert.equal(body.type, 'extraAgents'); assert.ok(url.endsWith('/info'));
    if (state.fail) return new Response('{}', { status: 503 });
    return new Response(JSON.stringify(!state.revoked && body.user === owner.address && url.includes('testnet') ? [{ address: agent.address, validUntil: state.validUntil }] : []));
  };
  const app = await startPersistentAgentConnection({ port: 0, fetchImpl }); t.after(() => app.close());
  const url = new URL(app.url);
  const request = (path, body, headers = {}) => fetch(new URL(path, url), { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const prepare = async () => { const r = await request('/api/prepare', payload); assert.equal(r.status, 200); return r.json(); };
  return { app, request, prepare, state, fetchImpl };
}
test('browser session GET may omit Origin but writes still require it', async t => {
  const f = await fixture(t); const url = new URL(f.app.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(new URL('/api/session', url), { headers })).status, 200);
  assert.equal((await fetch(new URL('/api/prepare', url), { method: 'POST', headers, body: JSON.stringify(payload) })).status, 403);
});
test('HTTP saves encrypted durable identity, fresh process rebuilds real client and owner guards', async t => {
  const f = await fixture(t); const p = await f.prepare();
  assert.equal(p.replacing, false); assert.equal(p.agentAddress, agent.address);
  assert.equal((await f.request('/api/save', { id: p.id, confirm: true })).status, 200);
  const config = await loadConfig(); const text = await readFile(join(DATA_DIR, 'config.json'), 'utf8');
  assert.equal(text.includes(agent.privateKey), false); assert.equal(text.includes(agent.privateKey.slice(2)), false);
  assert.equal((await stat(join(DATA_DIR, 'config.json'))).mode & 0o777, 0o600);
  assert.equal(config.authMode, 'agent'); assert.equal(config.agentValidUntil, f.state.validUntil);
  const runtimeUrl = new URL('../../src/modules/bot/runtime.js', import.meta.url).href;
  const configUrl = new URL('../../src/modules/config.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict'; import {loadConfig} from ${JSON.stringify(configUrl)}; import {createConfiguredHLClient} from ${JSON.stringify(runtimeUrl)}; const c=await loadConfig(); const client=await createConfiguredHLClient(c,{fetchImpl:async(url,init)=>{assert.equal(JSON.parse(init.body).user,c.walletAddress);return new Response(JSON.stringify([{address:c.agentAddress,validUntil:c.agentValidUntil}]))}}); assert.equal(client.address,c.walletAddress); assert.equal(client.wallet.address,c.agentAddress); assert.equal(client.authMode,'agent'); assert.equal(client.network,'testnet'); assert.throws(()=>client._requireOwner(),/Owner action/); console.log('REBUILT');`], { env: process.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /REBUILT/);
  assert.equal((await f.request('/api/save', { id: p.id, confirm: true })).status, 409);
  const session = await (await f.request('/api/session')).text(); assert.ok(!session.includes(agent.privateKey)); assert.ok(!session.includes('encrypted'));
  f.state.revoked = true; await assert.rejects(createConfiguredHLClient(config, { fetchImpl: f.fetchImpl }), /not authorized/);
  f.state.fail = true; await assert.rejects(createConfiguredHLClient(config, { fetchImpl: f.fetchImpl }), /unavailable/);
  await assert.rejects(createConfiguredHLClient({ ...config, agentValidUntil: Date.now() - 1 }, { fetchImpl: f.fetchImpl }), /expired/);
});
test('rejects invalid keys, owner key, wrong owner/network, expired and unavailable authorization', async t => {
  const f = await fixture(t);
  for (const change of [{ privateKey: 'x' }, { privateKey: '0x' + '0'.repeat(64) }, { privateKey: owner.privateKey }, { accountAddress: 'bad' }, { network: 'other' }]) assert.equal((await f.request('/api/prepare', { ...payload, ...change })).status, 400);
  for (const change of [{ accountAddress: other.address }, { network: 'mainnet' }, { privateKey: other.privateKey }]) assert.equal((await f.request('/api/prepare', { ...payload, ...change })).status, 403);
  f.state.validUntil = Date.now() - 1; assert.equal((await f.request('/api/prepare', payload)).status, 403);
  f.state.fail = true; assert.equal((await f.request('/api/prepare', payload)).status, 502);
  assert.equal((await loadConfig()).walletAddress, '');
});
test('replacement preserves settings, disables cross-owner builder and verifies encrypted backup', async t => {
  const f = await fixture(t); const imported = await importWallet(other.privateKey);
  const previous = { walletAddress: other.address, authMode: 'wallet', encrypted: { privateKey: imported.encryptedPrivateKey }, language: 'ru', hlNetwork: 'testnet', notifications: { priceChangePercent: 23 }, outcomeBuilderEnabled: true };
  await saveConfig(previous); const before = await readFile(join(DATA_DIR, 'config.json'), 'utf8');
  const p = await f.prepare(); assert.equal(p.replacing, true); assert.equal(p.previousAccountAddress, other.address);
  assert.equal((await f.request('/api/save', { id: p.id, confirm: true })).status, 200);
  const saved = await loadConfig(); assert.equal(saved.language, 'ru'); assert.deepEqual(saved.notifications, previous.notifications); assert.equal(saved.outcomeBuilderEnabled, false);
  const backups = (await readdir(DATA_DIR)).filter(n => n.endsWith('.enc')); assert.equal(backups.length, 1);
  const backup = await readFile(join(DATA_DIR, backups[0]), 'utf8'); assert.equal(await decrypt(backup, await getMachineKey()), before);
  assert.ok(!backup.includes(other.privateKey)); assert.ok(!backup.includes(agent.privateKey));
});
test('cancel, no confirm, config mutation, revoked review and concurrent/replayed save cannot write', async t => {
  const f = await fixture(t);
  let p = await f.prepare(); assert.equal((await f.request('/api/cancel', { id: p.id })).status, 200); assert.equal((await f.request('/api/save', { id: p.id, confirm: true })).status, 409);
  p = await f.prepare(); assert.equal((await f.request('/api/save', { id: p.id, confirm: false })).status, 400); assert.equal((await f.request('/api/save', { id: p.id, confirm: true })).status, 409);
  p = await f.prepare(); await saveConfig({ language: 'ru' }); assert.equal((await f.request('/api/save', { id: p.id, confirm: true })).status, 409); assert.deepEqual(await loadConfig(), { language: 'ru' });
  p = await f.prepare(); f.state.revoked = true; assert.equal((await f.request('/api/save', { id: p.id, confirm: true })).status, 403); f.state.revoked = false;
  p = await f.prepare(); f.state.fail = true; assert.equal((await f.request('/api/save', { id: p.id, confirm: true })).status, 502); f.state.fail = false;
  p = await f.prepare(); const results = await Promise.all([f.request('/api/save', { id: p.id, confirm: true }), f.request('/api/save', { id: p.id, confirm: true })]); assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
});
test('review TTL and closing before confirmation leave no saved key', async t => {
  const f = await fixture(t); const p = await f.prepare();
  const now = Date.now; Date.now = () => now() + 6 * 60_000;
  try { assert.equal((await f.request('/api/save', { id: p.id, confirm: true })).status, 409); }
  finally { Date.now = now; }
  assert.equal((await loadConfig()).walletAddress, '');
  await f.prepare(); await f.app.close(); assert.equal((await loadConfig()).walletAddress, '');
});
test('host origin bearer body and request rate boundaries', async t => {
  const f = await fixture(t);
  const { request: httpRequest } = await import('node:http');
  const hostStatus = await new Promise((resolve, reject) => { const req = httpRequest(new URL('/api/session', f.app.url), { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(hostStatus, 403);
  for (const headers of [{ Origin: 'https://evil.example' }, { Authorization: 'Bearer invalid' }]) assert.equal((await f.request('/api/session', undefined, headers)).status, 403);
  assert.equal((await f.request('/api/prepare', payload, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.request('/api/prepare', { ...payload, privateKey: 'a'.repeat(5000) })).status, 413);
  let last; for (let i = 0; i < 32; i++) last = await f.request('/api/session'); assert.equal(last.status, 429);
});
test('CLI lock excludes bot and cleans up after occupied port and successful save', async t => {
  const f = await fixture(t);
  const { runPersistentAgentConnector } = await import('../../scripts/connect-api-wallet.js');
  const { acquireRuntimeLock } = await import('../../src/modules/process-lock.js');
  await assert.rejects(runPersistentAgentConnector({ port: Number(new URL(f.app.url).port), print: () => {} }), /EADDRINUSE/);
  const messages = []; const app = await runPersistentAgentConnector({ port: 0, fetchImpl: f.fetchImpl, print: s => messages.push(s) }); t.after(() => app.stop());
  await assert.rejects(acquireRuntimeLock(), /Another/);
  const url = new URL(app.url); const post = (path, body) => fetch(new URL(path, url), { method: 'POST', headers: { Origin: url.origin, Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const p = await (await post('/api/prepare', payload)).json(); assert.equal((await post('/api/save', { id: p.id, confirm: true })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 30)); assert.ok(messages.some(s => s.includes('npm start')));
  const release = await acquireRuntimeLock(); release();
});
