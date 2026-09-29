import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function liquidityStorePath({ dataDir, account, network }) {
  if (typeof dataDir !== 'string' || !dataDir || !/^0x[0-9a-fA-F]{40}$/.test(account) || !['mainnet','testnet'].includes(network)) throw new Error('Invalid store scope');
  return join(resolve(dataDir), `liquidity-${network}-${account.toLowerCase()}.sqlite`);
}

export function createLiquidityStore(scope) {
  const path = liquidityStorePath(scope);
  mkdirSync(resolve(scope.dataDir), { recursive:true, mode:0o700 });
  const db = new Database(path);
  chmodSync(path, 0o600);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL)`);
  const read = db.prepare('SELECT payload FROM sessions WHERE id = ?');
  const all = db.prepare('SELECT payload FROM sessions ORDER BY rowid DESC');
  const byRequest = db.prepare('SELECT payload FROM sessions WHERE request_id = ?');
  const save = db.prepare('INSERT INTO sessions(id, request_id, payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload');
  const account = scope.account.toLowerCase(), network = scope.network;
  return {
    account, network, path,
    get(id) { const row=read.get(id); return row ? JSON.parse(row.payload) : null; },
    findRequest(id) { const row=byRequest.get(id); return row ? JSON.parse(row.payload) : null; },
    list() { return all.all().map(row=>JSON.parse(row.payload)); },
    save(session) {
      if (session.policy.account !== account || session.policy.network !== network) throw new Error('Store scope mismatch');
      save.run(session.id,session.requestId,JSON.stringify(session));
    },
    close() { db.close(); },
  };
}
