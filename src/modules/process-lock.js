import { mkdirSync, openSync, writeFileSync, fstatSync, lstatSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';
let held = false;
/** Local singleton shared by bot and connector. Never steal an existing lock:
 * dead PIDs can be reused, and stale-check/unlink races permit two owners.
 * After SIGKILL, an operator must verify no runtime exists before removing it.
 */
export async function acquireRuntimeLock() {
  if (held) throw new Error('Another bot/connector is running in this process');
  mkdirSync(DATA_DIR, { recursive: true });
  const path = join(DATA_DIR, 'runtime.lock');
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another bot/connector is running or runtime lock requires manual inspection');
    throw error;
  }
  const identity = fstatSync(fd);
  held = true;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    try {
      const current = lstatSync(path);
      // Keep the original inode open until comparison to prevent inode reuse.
      if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(path);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { closeSync(fd); held = false; }
  };
  process.once('exit', release);
  try { writeFileSync(fd, String(process.pid)); }
  catch (error) { release(); throw error; }
  return release;
}
