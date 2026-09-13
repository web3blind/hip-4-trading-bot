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
