import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const names = (await readdir(join(root, 'tests/unit'))).filter(n => n.endsWith('.test.js')).sort();
const requested = process.argv.slice(2);
const selected = requested.length ? names.filter(n => requested.some(arg => n.includes(arg))) : names;
if (!selected.length) throw new Error('No test files matched');
let failed = 0;
for (const name of selected) {
 const dir = await mkdtemp(join(tmpdir(), 'hip4-test-'));
 try {
  const env = { ...process.env, HIP4_DATA_DIR: resolve(dir), LOG_TO_FILE: 'false', NODE_ENV: 'test', DOTENV_CONFIG_PATH: join(dir,'.env') };
  delete env.TELEGRAM_BOT_TOKEN; delete env.TELEGRAM_ALLOWED_USER_ID; delete env.HL_PRIVATE_KEY;
  console.log(`\n=== ${name} ===`);
  const result = spawnSync(process.execPath, ['--import', join(root,'tests/offline-network.js'), '--test', join(root,'tests/unit',name)], { cwd: dir, env, stdio: 'inherit', timeout: 120000 });
  if (result.status !== 0) { failed++; if (result.error) console.error(result.error.message); }
 } finally { await rm(dir, { recursive:true, force:true }); }
}
console.log(`\nTest files: ${selected.length}; failed files: ${failed}`);
process.exitCode = failed ? 1 : 0;
