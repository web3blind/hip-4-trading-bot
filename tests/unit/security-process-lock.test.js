import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = mkdtempSync(join(tmpdir(), 'hip4-lock-'));
process.env.HIP4_DATA_DIR = root;
const moduleUrl = new URL('../../src/modules/process-lock.js', import.meta.url).href;
const { acquireRuntimeLock } = await import(moduleUrl);
const path = join(root, 'runtime.lock');
after(() => rmSync(root, { recursive: true, force: true }));
function child(code) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `const { acquireRuntimeLock } = await import(${JSON.stringify(moduleUrl)}); ${code}`], {
    env: { ...process.env, HIP4_DATA_DIR: root, LOG_TO_FILE: 'false' }, encoding: 'utf8', timeout: 10000,
  });
}
test('exclusive across processes and within process; idempotent release never releases later owner', async () => {
  const release = await acquireRuntimeLock();
  await assert.rejects(acquireRuntimeLock(), /Another/);
  assert.notEqual(child('await acquireRuntimeLock();').status, 0);
  release(); release();
  assert.equal(existsSync(path), false);
  const next = await acquireRuntimeLock(); release();
  assert.equal(existsSync(path), true); next();
});
test('normal exit releases ownership; existing stale/malformed locks are never stolen', async () => {
  assert.equal(child('await acquireRuntimeLock();').status, 0);
  assert.equal(existsSync(path), false);
  for (const text of ['2147483647', '', 'invalid']) {
    writeFileSync(path, text);
    await assert.rejects(acquireRuntimeLock(), /manual inspection/);
    assert.equal(readFileSync(path, 'utf8'), text);
    unlinkSync(path);
  }
});
test('release does not remove a replaced lock inode', async () => {
  const release = await acquireRuntimeLock();
  unlinkSync(path); writeFileSync(path, 'replacement');
  release();
  assert.equal(readFileSync(path, 'utf8'), 'replacement'); unlinkSync(path);
});
