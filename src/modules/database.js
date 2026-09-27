import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { DATA_DIR } from './config.js';
const DB_DIR = DATA_DIR;
let DB_PATH = join(DB_DIR, 'cache-unconfigured.sqlite');
export function canonicalOid(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Unsafe OID');
  const oid = String(value ?? '');
  if (!/^[0-9]+$/.test(oid)) throw new Error('Invalid OID');
  return BigInt(oid).toString();
}

let db = null;

// Initialize database and create tables
export function initDatabase(scope = {}) {
  const network = scope.network || 'testnet';
  const account = String(scope.accountAddress || 'unconfigured').toLowerCase();
  if (!['testnet', 'mainnet'].includes(network) || !/^(0x[a-f0-9]{40}|unconfigured)$/.test(account)) throw new Error('Invalid database scope');
  closeDatabase();
  DB_PATH = join(DB_DIR, `cache-${network}-${account}.sqlite`);
  // Ensure data directory exists
  try {
    mkdirSync(DB_DIR, { recursive: true });
  } catch (err) {
    // Directory may already exist
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Create tables
  createTables();
  // Only the account/network-scoped cache is opened here; never migrate database.sqlite.
  // NULL on old rows preserves unknown historical delivery without replaying old fills.
  if (!db.pragma('table_info(orders)').some(column => column.name === 'fill_notification_status')) {
    db.exec('ALTER TABLE orders ADD COLUMN fill_notification_status TEXT');
  }
  createPriceAlertsTable();
  createCompleteSetAttemptsTable();
  createCompleteSetAlertsTable();
  createBundleTables();
  if (!db.pragma('table_info(complete_set_alerts)').some(column => column.name === 'last_net_floor')) {
    db.exec('ALTER TABLE complete_set_alerts ADD COLUMN last_net_floor REAL');
  }

  return db;
}

function createTables() {
  // Outcomes cache (HIP-4 outcome markets)
  db.exec(`
    CREATE TABLE IF NOT EXISTS outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outcome_id INTEGER UNIQUE NOT NULL,
      question TEXT,
      description TEXT,
      status TEXT DEFAULT 'active',
      updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_outcomes_outcome_id ON outcomes(outcome_id);
  `);

  // Outcome sides (YES/NO sides for each outcome)
  db.exec(`
    CREATE TABLE IF NOT EXISTS outcome_sides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outcome_id INTEGER NOT NULL,
      side INTEGER NOT NULL,
      coin TEXT,
      token TEXT,
      asset_id INTEGER,
      UNIQUE(outcome_id, side)
    );
    CREATE INDEX IF NOT EXISTS idx_outcome_sides_outcome ON outcome_sides(outcome_id);
    CREATE INDEX IF NOT EXISTS idx_outcome_sides_coin ON outcome_sides(coin);
  `);

  // Positions (HIP-4 outcome positions)
  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coin TEXT NOT NULL,
      side TEXT NOT NULL,
      size TEXT NOT NULL,
      entry_price TEXT NOT NULL,
      updated_at INTEGER,
      UNIQUE(coin)
    );
    CREATE INDEX IF NOT EXISTS idx_positions_coin ON positions(coin);
  `);

  // Orders (HIP-4 outcome orders)
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coin TEXT NOT NULL,
      side TEXT NOT NULL,
      order_type TEXT NOT NULL,
      price TEXT,
      size TEXT,
      oid TEXT UNIQUE,
      status TEXT DEFAULT 'open',
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_orders_coin ON orders(coin);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_oid ON orders(oid);
  `);


}

function createCompleteSetAttemptsTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS complete_set_attempts (
    id TEXT PRIMARY KEY,
    question_id INTEGER NOT NULL,
    budget TEXT NOT NULL,
    shares INTEGER NOT NULL,
    coins_json TEXT NOT NULL,
    account TEXT NOT NULL DEFAULT '',
    network TEXT NOT NULL DEFAULT '',
    rule_digest TEXT NOT NULL DEFAULT '',
    fee_digest TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL CHECK(state IN ('prepared','submitting','submitted_unknown','partial','filled','rejected','closed')),
    legs_json TEXT NOT NULL DEFAULT '[]',
    notified_state TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_complete_set_attempts_state ON complete_set_attempts(state, updated_at);`);
}

export function createCompleteSetAttempt({ id, questionId, budget, shares, coins, account, network, ruleDigest, feeDigest, legs }) {
  if (!/^[0-9a-f-]{36}$/.test(String(id)) || !Number.isSafeInteger(questionId) || questionId < 0 ||
      !Number.isSafeInteger(shares) || shares <= 0 || !Number.isFinite(Number(budget)) || Number(budget) <= 0 ||
      !/^0x[0-9a-fA-F]{40}$/.test(account || '') || !['mainnet','testnet'].includes(network) ||
      !/^[0-9a-f]{64}$/.test(ruleDigest || '') || !/^[0-9a-f]{64}$/.test(feeDigest || '') ||
      !Array.isArray(coins) || coins.length < 2 || coins.length > 8 ||
      !coins.every(coin => /^#[0-9]+0$/.test(coin)) || !Array.isArray(legs) || legs.length !== coins.length ||
      legs.some((leg,i) => leg.coin !== coins[i] || !/^0x[0-9a-f]{32}$/.test(leg.cloid || '') ||
        !Number.isFinite(leg.price) || leg.price <= 0 || leg.price >= 1 || leg.size !== shares) ||
      new Set(legs.map(leg=>leg.cloid)).size !== legs.length) throw new Error('Invalid complete set attempt');
  const now = Date.now();
  db.prepare(`INSERT INTO complete_set_attempts
    (id, question_id, budget, shares, coins_json, account, network, rule_digest, fee_digest, legs_json, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`).run(
      id, questionId, String(budget), shares, JSON.stringify(coins), account.toLowerCase(), network,
      ruleDigest, feeDigest, JSON.stringify(legs), now, now);
  return id;
}

export function updateCompleteSetAttempt(id, state, legs = null) {
  if (!['submitting','submitted_unknown','partial','filled','rejected','closed'].includes(state) ||
      (legs !== null && (!Array.isArray(legs) || !legs.every(x=>x && typeof x==='object')))) throw new Error('Invalid attempt update');
  const change = db.prepare(`UPDATE complete_set_attempts SET state = ?,
    legs_json = COALESCE(?, legs_json), updated_at = ? WHERE id = ? AND state IN ('prepared','submitting','submitted_unknown','partial','filled','rejected')`)
    .run(state, legs === null ? null : JSON.stringify(legs), Date.now(), id);
  if (change.changes !== 1) throw new Error('Attempt not found or already closed');
}

export function markCompleteSetAttemptNotified(id, state) {
  if (!['partial','filled','submitted_unknown','rejected'].includes(state)) throw new Error('Invalid notification state');
  return db.prepare('UPDATE complete_set_attempts SET notified_state = ?, updated_at = ? WHERE id = ? AND state = ?')
    .run(state, Date.now(), id, state).changes === 1;
}

export function getCompleteSetAttempts(states = ['submitting','submitted_unknown','partial'], {limit=null,unnotifiedFilled=false}={}) {
  if (!Array.isArray(states) || states.length === 0 || states.some(x => !['prepared','submitting','submitted_unknown','partial','filled','closed','rejected'].includes(x)) ||
      (limit!==null && (!Number.isSafeInteger(limit) || limit<1 || limit>1000))) throw new Error('Invalid states or limit');
  const placeholders=states.map(()=>'?').join(',');
  return db.prepare(`SELECT * FROM complete_set_attempts WHERE state IN (${placeholders})
    ${unnotifiedFilled ? "AND (state NOT IN ('filled','rejected') OR notified_state <> state)" : ''}
    ORDER BY CASE state WHEN 'submitted_unknown' THEN 0 WHEN 'submitting' THEN 1
      WHEN 'partial' THEN 2 WHEN 'rejected' THEN 3 WHEN 'filled' THEN 4 ELSE 5 END, created_at ASC
    ${limit===null?'':'LIMIT ?'}`)
    .all(...states,...(limit===null?[]:[limit])).map(row=>({...row, coins:JSON.parse(row.coins_json), legs:JSON.parse(row.legs_json)}));
}

export function getPendingCompleteSetQuestionIds(account, network) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(account || '') || !['mainnet','testnet'].includes(network))
    throw new Error('Invalid account or network');
  return new Set(db.prepare(`SELECT DISTINCT question_id FROM complete_set_attempts
    WHERE account = ? AND network = ? AND state IN ('submitting','submitted_unknown','partial')`)
    .all(account.toLowerCase(), network).map(row => row.question_id));
}

export function getBundleAttempts(account, network) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(account||'') || !['mainnet','testnet'].includes(network)) throw new Error('Invalid bundle scope');
  return db.prepare("SELECT * FROM complete_set_attempts WHERE account=? AND network=? AND state IN ('filled','partial','closed') ORDER BY created_at DESC")
    .all(account.toLowerCase(),network).map(row=>({...row,coins:JSON.parse(row.coins_json),legs:JSON.parse(row.legs_json)}));
}
function createBundleTables() {
  db.exec(`CREATE TABLE IF NOT EXISTS bundle_snapshots (
    attempt_id TEXT PRIMARY KEY, status TEXT NOT NULL, snapshot_json TEXT NOT NULL,
    alert_value REAL, alert_at INTEGER NOT NULL DEFAULT 0, final_notified INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bundle_close_requests (
    id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, account TEXT NOT NULL, network TEXT NOT NULL,
    state TEXT NOT NULL, legs_json TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bundle_fill_evidence (
    attempt_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL, fills_json TEXT NOT NULL
  )`);
}
export function getBundleFillEvidence(id) {
  const row=db.prepare('SELECT cursor,fills_json FROM bundle_fill_evidence WHERE attempt_id=?').get(id);
  return row && {cursor:row.cursor,fills:JSON.parse(row.fills_json)};
}
export function putBundleFillEvidence(id,cursor,fills) {
  if(!Number.isSafeInteger(cursor) || !Array.isArray(fills)) throw new Error('Invalid fill evidence');
  db.prepare(`INSERT INTO bundle_fill_evidence(attempt_id,cursor,fills_json) VALUES (?,?,?)
    ON CONFLICT(attempt_id) DO UPDATE SET cursor=excluded.cursor,fills_json=excluded.fills_json WHERE excluded.cursor>=bundle_fill_evidence.cursor`)
    .run(id,cursor,JSON.stringify(fills));
}
export function getBundleSnapshot(id) {
  const row=db.prepare('SELECT * FROM bundle_snapshots WHERE attempt_id=?').get(id);
  return row && {...row,snapshot:JSON.parse(row.snapshot_json)};
}
export function putBundleSnapshot(id,snapshot) {
  db.prepare(`INSERT INTO bundle_snapshots(attempt_id,status,snapshot_json,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(attempt_id) DO UPDATE SET status=excluded.status,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at`)
    .run(id,snapshot.status,JSON.stringify(snapshot),Date.now());
}
export function markBundleAlert(id,value,time) {
  db.prepare('UPDATE bundle_snapshots SET alert_value=?,alert_at=? WHERE attempt_id=?').run(value,time,id);
}
export function markBundleFinalNotified(id) {
  db.prepare('UPDATE bundle_snapshots SET final_notified=1 WHERE attempt_id=?').run(id);
}
export function createBundleCloseRequest({id,attemptId,account,network,legs}) {
  db.transaction(()=>{
    const last=getBundleCloseRequest(attemptId);
    if(last && last.state!=='reconciled') throw new Error('Previous close not reconciled');
    db.prepare("INSERT INTO bundle_close_requests VALUES (?,?,?,?, 'submitting', ?, ?)")
      .run(id,attemptId,account.toLowerCase(),network,JSON.stringify(legs),Date.now());
  })();
}
export function updateBundleCloseRequest(id,state,legs) {
  db.prepare('UPDATE bundle_close_requests SET state=?,legs_json=? WHERE id=?')
    .run(state,JSON.stringify(legs),id);
}
export function getBundleCloseRequest(attemptId) {
  const row=db.prepare('SELECT * FROM bundle_close_requests WHERE attempt_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(attemptId);
  return row && {...row,legs:JSON.parse(row.legs_json)};
}
export function getPendingBundleCloseRequests(account,network) {
  return db.prepare("SELECT * FROM bundle_close_requests WHERE account=? AND network=? AND state IN ('submitting','unknown','partial','filled')")
    .all(account.toLowerCase(),network).map(row=>({...row,legs:JSON.parse(row.legs_json)}));
}
export function getBundleCloseOids(account,network) {
  return db.prepare('SELECT legs_json FROM bundle_close_requests WHERE account=? AND network=?')
    .all(account.toLowerCase(),network).flatMap(row=>JSON.parse(row.legs_json).map(l=>String(l.oid||''))).filter(Boolean);
}

function createCompleteSetAlertsTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS complete_set_alerts (
    question_id INTEGER PRIMARY KEY,
    last_alert_at INTEGER NOT NULL DEFAULT 0,
    miss_count INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 0,
    last_net_floor REAL
  )`);
}

export function getCompleteSetAlertState(questionId) {
  return db.prepare('SELECT * FROM complete_set_alerts WHERE question_id = ?').get(questionId)
    ?? {question_id:questionId,last_alert_at:0,miss_count:0,active:0,last_net_floor:null};
}

export function updateCompleteSetAlertState(questionId, lastAlertAt, missCount, active, lastNetFloor=null) {
  if (!Number.isSafeInteger(questionId) || questionId<0 || !Number.isSafeInteger(lastAlertAt) || lastAlertAt<0 ||
      !Number.isSafeInteger(missCount) || missCount<0 || ![0,1].includes(active) ||
      (lastNetFloor!==null && (!Number.isFinite(lastNetFloor) || lastNetFloor<=0))) throw new Error('Invalid alert state');
  db.prepare(`INSERT INTO complete_set_alerts (question_id,last_alert_at,miss_count,active,last_net_floor) VALUES (?,?,?,?,?)
    ON CONFLICT(question_id) DO UPDATE SET last_alert_at=excluded.last_alert_at,
    miss_count=excluded.miss_count,active=excluded.active,last_net_floor=excluded.last_net_floor`)
    .run(questionId,lastAlertAt,missCount,active,lastNetFloor);
}

// ─── Outcomes ─────────────────────────────────────────────────

export function upsertOutcome(outcome) {
  const { outcomeId, question, description, status } = outcome;
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO outcomes (outcome_id, question, description, status, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(outcome_id) DO UPDATE SET
      question = excluded.question,
      description = excluded.description,
      status = excluded.status,
      updated_at = excluded.updated_at
  `);
  const result = stmt.run(outcomeId, question || null, description || null, status || 'active', now);

  // Upsert sides if provided
  if (outcome.sides) {
    const sideStmt = db.prepare(`
      INSERT INTO outcome_sides (outcome_id, side, coin, token, asset_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(outcome_id, side) DO UPDATE SET
        coin = excluded.coin,
        token = excluded.token,
        asset_id = excluded.asset_id
    `);
    for (const sideData of outcome.sides) {
      sideStmt.run(outcomeId, sideData.side, sideData.coin || null, sideData.token || null, sideData.assetId || null);
    }
  }

  return result;
}

export function getOutcomes(limit = 100, offset = 0) {
  const stmt = db.prepare(`
    SELECT o.*, 
      json_group_array(json_object(
        'side', os.side,
        'coin', os.coin,
        'token', os.token,
        'asset_id', os.asset_id
      )) as sides_json
    FROM outcomes o
    LEFT JOIN outcome_sides os ON o.outcome_id = os.outcome_id
    GROUP BY o.outcome_id
    ORDER BY o.outcome_id ASC
    LIMIT ? OFFSET ?
  `);
  const rows = stmt.all(limit, offset);
  return rows.map(row => ({
    ...row,
    sides: row.sides_json ? JSON.parse(row.sides_json).filter(s => s.side !== null) : []
  }));
}

export function getOutcomeById(outcomeId) {
  const stmt = db.prepare(`
    SELECT o.*,
      json_group_array(json_object(
        'side', os.side,
        'coin', os.coin,
        'token', os.token,
        'asset_id', os.asset_id
      )) as sides_json
    FROM outcomes o
    LEFT JOIN outcome_sides os ON o.outcome_id = os.outcome_id
    WHERE o.outcome_id = ?
    GROUP BY o.outcome_id
  `);
  const row = stmt.get(outcomeId);
  if (!row) return null;
  return {
    ...row,
    sides: row.sides_json ? JSON.parse(row.sides_json).filter(s => s.side !== null) : []
  };
}

export function getOutcomeCount() {
  const stmt = db.prepare('SELECT COUNT(*) as count FROM outcomes');
  return stmt.get().count;
}

// ─── Positions ────────────────────────────────────────────────

export function upsertPosition(position) {
  const { coin, side, size, entryPrice } = position;
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO positions (coin, side, size, entry_price, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(coin) DO UPDATE SET
      side = excluded.side,
      size = excluded.size,
      entry_price = excluded.entry_price,
      updated_at = excluded.updated_at
  `);
  return stmt.run(coin, side, String(size), String(entryPrice), now);
}

export function getPositions() {
  const stmt = db.prepare('SELECT * FROM positions ORDER BY updated_at DESC');
  return stmt.all();
}

export function deletePosition(coin) {
  const stmt = db.prepare('DELETE FROM positions WHERE coin = ?');
  return stmt.run(coin);
}

// ─── Orders ───────────────────────────────────────────────────

export function upsertOrder(order) {
  const { coin, side, orderType, price, size, oid, status, fillNotificationStatus } = order;
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO orders (coin, side, order_type, price, size, oid, status, created_at, updated_at, fill_notification_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(oid) DO UPDATE SET
      coin = excluded.coin,
      side = excluded.side,
      order_type = excluded.order_type,
      price = excluded.price,
      size = excluded.size,
      status = excluded.status,
      fill_notification_status = COALESCE(orders.fill_notification_status, excluded.fill_notification_status),
      updated_at = excluded.updated_at
  `);
  return stmt.run(coin, side, orderType, String(price || ''), String(size || ''), canonicalOid(oid), status || 'open', now, now, fillNotificationStatus || null);
}

export function markOrderFillNotificationDelivered(oid) {
  return db.prepare("UPDATE orders SET fill_notification_status = 'delivered' WHERE oid = ? AND fill_notification_status = 'pending'").run(canonicalOid(oid));
}

export function getOrders(status = null) {
  if (status) {
    const stmt = db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY updated_at DESC');
    return stmt.all(status);
  }
  const stmt = db.prepare('SELECT * FROM orders ORDER BY updated_at DESC');
  return stmt.all();
}

export function getOrderByOid(oid) {
  const stmt = db.prepare('SELECT * FROM orders WHERE oid = ?');
  return stmt.get(canonicalOid(oid)) || null;
}

export function deleteOrder(oid) {
  const stmt = db.prepare('DELETE FROM orders WHERE oid = ?');
  return stmt.run(canonicalOid(oid));
}

// ─── Outcome by Coin ─────────────────────────────────────────

export function getOutcomeByCoin(coin) {
  const sideStmt = db.prepare('SELECT * FROM outcome_sides WHERE coin = ? LIMIT 1');
  const sideRow = sideStmt.get(coin);
  if (!sideRow) return null;
  return getOutcomeById(sideRow.outcome_id);
}

// ─── Price alert state (for automatic position monitoring) ────

function createPriceAlertsTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS price_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coin TEXT NOT NULL,
    last_price TEXT,
    last_alert_time INTEGER,
    UNIQUE(coin)
  )`);
}

export function getPriceAlertState(coin) {
  const stmt = db.prepare('SELECT * FROM price_alerts WHERE coin = ?');
  return stmt.get(coin) || null;
}

export function updatePriceAlertState(coin, lastPrice, lastAlertTime) {
  const stmt = db.prepare(`INSERT INTO price_alerts (coin, last_price, last_alert_time)
    VALUES (?, ?, ?)
    ON CONFLICT(coin) DO UPDATE SET last_price = ?, last_alert_time = ?`);
  stmt.run(coin, String(lastPrice), lastAlertTime, String(lastPrice), lastAlertTime);
}

// ─── Database lifecycle ───────────────────────────────────────

export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

export function getDb() {
  return db;
}
