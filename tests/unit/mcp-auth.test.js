import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'hip4-mcp-keys-'));
process.env.HIP4_DATA_DIR = dir;
process.env.LOG_TO_FILE = 'false';
const { loadConfig, updateConfig, saveConfig } = await import('../../src/modules/config.js');
const { issueMcpKey, revokeMcpKey, listMcpKeys, authenticateMcp } = await import('../../src/modules/mcp/key-store.js');
const { redactSensitive } = await import('../../src/modules/logger.js');
test.after(async () => { await rm(dir, { recursive: true, force: true }); });

test('keys are independently scoped, persisted as hashes, rotated and revoked', async () => {
  const read = await issueMcpKey('read');
  const trade = await issueMcpKey('trade');
  assert.ok(!JSON.stringify(redactSensitive({ message: `Failed for ${read}` })).includes(read));
  assert.match(read, /^hip4mcp_[A-Za-z0-9_-]{43}$/);
  assert.equal((await authenticateMcp(`Bearer ${read}`)).scope, 'read');
  assert.equal((await authenticateMcp(`Bearer ${trade}`)).scope, 'trade');
  assert.equal((await listMcpKeys()).length, 2);
  const stored = JSON.stringify(await loadConfig());
  assert.ok(!stored.includes(read) && !stored.includes(trade));
  assert.equal((await loadConfig()).mcp.keys.every(k => /^[a-f0-9]{64}$/.test(k.hash)), true);
  const nextRead = await issueMcpKey('read');
  assert.equal(await authenticateMcp(`Bearer ${read}`), null);
  assert.equal((await authenticateMcp(`Bearer ${trade}`)).scope, 'trade');
  assert.notEqual(nextRead, read);
  await revokeMcpKey('trade');
  assert.equal(await authenticateMcp(`Bearer ${trade}`), null);
  assert.equal((await authenticateMcp(`Bearer ${nextRead}`)).scope, 'read');
});

test('key rotation and settings updates are serializable; stale full writes fail closed', async () => {
  for (let i = 0; i < 12; i++) {
    const [token] = await Promise.all([issueMcpKey('read'), updateConfig('language', i % 2 ? 'en' : 'ru')]);
    assert.equal((await loadConfig()).language, i % 2 ? 'en' : 'ru');
    assert.ok(await authenticateMcp(`Bearer ${token}`));
  }
  const old = await loadConfig();
  await issueMcpKey('trade');
  await assert.rejects(() => saveConfig({ ...old, language: 'stale' }, { expectedConfig: old }), /changed/);
  assert.equal((await listMcpKeys()).length, 2);
});

test('fail closed on malformed token and scope', async () => {
  await assert.rejects(() => issueMcpKey('admin'), /scope/);
  assert.equal(await authenticateMcp('Bearer hip4mcp_not_a_key'), null);
  assert.equal(await authenticateMcp('Basic abc'), null);
  assert.equal(await authenticateMcp(null), null);
});
