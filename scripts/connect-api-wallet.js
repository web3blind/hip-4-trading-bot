import { pathToFileURL } from 'node:url';
import { startPersistentAgentConnection } from '../src/modules/persistent-agent-connection.js';
import { acquireRuntimeLock } from '../src/modules/process-lock.js';
import { patchConsoleForRedaction } from '../src/modules/logger.js';

export async function runPersistentAgentConnector({ port = 8787, fetchImpl = fetch, print = console.log } = {}) {
  const release = await acquireRuntimeLock();
  let app, stopped = false, expiration;
  const handlers = new Map();
  const stop = async () => {
    if (stopped) return; stopped = true;
    clearTimeout(expiration);
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    try { await app?.close(); } finally { release(); }
  };
  try {
    app = await startPersistentAgentConnection({ port, fetchImpl });
    app.server.once('saved', () => {
      print('API wallet saved encrypted. Connector stops now. Start/restart the bot separately: npm start');
      void stop();
    });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => { void stop(); }; handlers.set(signal, handler); process.once(signal, handler);
    }
    expiration = setTimeout(() => { void stop(); }, 15 * 60_000); expiration.unref();
    print('Open this private local link; do not share it. Enter only a pre-authorized API wallet key, never the owner key:');
    print(app.url);
    return { ...app, stop };
  } catch (error) { await stop(); throw error; }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.includes('--help')) {
    console.log('npm run connect — persist an authorized Hyperliquid API wallet on http://127.0.0.1:8787. Owner public address + API wallet private key required. Stop the bot first. Use an SSH tunnel for a remote server. After saving run npm start; the connector never starts Telegram or trading.');
  } else {
    patchConsoleForRedaction();
    runPersistentAgentConnector().catch(() => { console.error('Connector could not start. Check runtime.lock and local port 8787.'); process.exitCode = 1; });
  }
}
