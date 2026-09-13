import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../../', import.meta.url));
function run(cwd, data, args) {
  return spawnSync(process.execPath, args, { cwd, env: { ...process.env, HIP4_DATA_DIR: data, LOG_TO_FILE: 'false' }, encoding: 'utf8', timeout: 30000 });
}
function ok(result) { assert.equal(result.status, 0, result.stderr); return result; }
for (const mode of ['wallet', 'agent']) test(`synthetic ${mode} migration prepare/export/apply reads disk and deletes one-time key`, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'hip4-migration-'));
  const source = join(temp, 'source'), target = join(temp, 'target');
  const moduleUrl = name => new URL(`../../src/modules/${name}.js`, import.meta.url).href;
  try {
    // Fixed public test key only. Never import application .env or real data.
    ok(run(temp, source, ['--input-type=module', '-e', `
      import { encrypt, getMachineKey } from '${moduleUrl('auth')}';
      import { saveConfig } from '${moduleUrl('config')}';
      const privateKey = '0x' + '11'.repeat(32);
      const signer = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';
      await saveConfig({authMode:'${mode}', walletAddress:'${mode === 'agent' ? '0x2222222222222222222222222222222222222222' : '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'}', agentAddress:'${mode === 'agent' ? '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A' : ''}', hlNetwork:'testnet',outcomeBuilderEnabled:true,language:'en',encrypted:{privateKey:await encrypt(privateKey,await getMachineKey())}});
    `]));
    const request = join(temp, 'request.json'), bundle = join(temp, 'bundle.json');
    ok(run(temp, target, [resolve(root, 'scripts/prepare-migration-request.js'), '--request', request]));
    const req = JSON.parse(await readFile(request, 'utf8'));
    const pem = join(temp, req.privateKeyFile);
    assert.equal((await stat(pem)).mode & 0o777, 0o600);
    ok(run(temp, source, [resolve(root, 'scripts/export-migration-bundle.js'), '--request', request, '--fingerprint', req.publicKeyFingerprint, '--output', bundle]));
    const result = ok(run(temp, target, [resolve(root, 'scripts/apply-migration-bundle.js'), '--request', request, '--bundle', bundle]));
    assert.match(result.stdout, /private key file was removed/);
    await assert.rejects(stat(pem), { code: 'ENOENT' });
    const saved = JSON.parse(await readFile(join(target, 'config.json'), 'utf8'));
    assert.equal(saved.authMode, mode); assert.equal(saved.hlNetwork, 'testnet'); assert.equal(saved.outcomeBuilderEnabled, true);
    assert.equal(saved.walletAddress, mode === 'agent' ? '0x2222222222222222222222222222222222222222' : '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A');
    assert.equal(saved.encrypted.l2Credentials, undefined);
    ok(run(temp, target, ['--input-type=module', '-e', `import {getDecryptedPrivateKey} from '${moduleUrl('auth')}'; if(await getDecryptedPrivateKey() !== '0x'+'11'.repeat(32)) process.exit(2);`]));
    assert.notEqual(run(temp, target, [resolve(root, 'scripts/apply-migration-bundle.js'), '--request', request, '--bundle', bundle]).status, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
