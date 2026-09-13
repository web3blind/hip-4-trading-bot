import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = mkdtempSync(join(tmpdir(), 'hip4-workers-'));
process.env.HIP4_DATA_DIR = root; process.env.LOG_TO_FILE = 'false';
const db = await import('../../src/modules/database.js');
const workers = await import('../../src/modules/workers.js');
const rt = await import('../../src/modules/bot/runtime.js');
const { saveConfig } = await import('../../src/modules/config.js');
const owner = '0x' + '11'.repeat(20);
const other = '0x' + '22'.repeat(20);
function client(overrides = {}) { return { address: owner, network: 'testnet',
  async getUserBalances() { return { balances: [] }; }, async getOpenOrders() { return []; },
  async getUserFills() { return []; }, async getOrderStatus() { return { status: 'unknownOid' }; }, ...overrides }; }
async function settle() { while (workers.getWorkersHealthSnapshot().running.length) await new Promise(r => setTimeout(r, 2)); }
function tracked(oid = '42', size = '10') { db.upsertOrder({ oid, coin: '#100', side: 'BUY', orderType: 'Limit', price: '.4', size, status: 'open' }); }
beforeEach(async () => {
  await workers.stopWorkers(); db.closeDatabase(); rmSync(root, { recursive: true, force: true });
  await saveConfig({ walletAddress: owner, language: 'en', hlNetwork: 'testnet' });
  db.initDatabase({ network: 'testnet', accountAddress: owner });
  rt.busyLocks.clear(); rt.confirmationLocks.clear(); rt.setAllowedUserId(7);
});
after(async () => { await workers.stopWorkers(); db.closeDatabase(); rmSync(root, { recursive: true, force: true }); });

test('scoped caches isolate networks/accounts, retain legacy file unchanged and canonicalize OIDs', () => {
  writeFileSync(join(root, 'database.sqlite'), 'legacy-retained');
  tracked(42); assert.equal(db.getOrderByOid('00042').oid, '42');
  db.initDatabase({ network: 'mainnet', accountAddress: owner }); assert.deepEqual(db.getOrders(), []);
  tracked('99');
  db.initDatabase({ network: 'testnet', accountAddress: other }); assert.deepEqual(db.getOrders(), []);
  db.initDatabase({ network: 'testnet', accountAddress: owner }); assert.equal(db.getOrders()[0].oid, '42');
  assert.equal(readFileSync(join(root, 'database.sqlite'), 'utf8'), 'legacy-retained');
  assert.throws(() => db.canonicalOid(Number.MAX_SAFE_INTEGER + 1), /Unsafe/);
  assert.throws(() => db.canonicalOid('42bad'), /Invalid/);
});

test('live numeric OID matches stored text and is not falsely reported filled', async () => {
  tracked();
  const c = client({ async getOpenOrders() { return [{ oid: 42, coin: '#100', side: 'B', sz: '10', limitPx: '.4' }]; } });
  workers.startWorkers({ hlClient: c }); await settle();
  assert.equal(db.getOrderByOid('42').status, 'open');
});

test('outage and malformed API results retain orders and positions; missing order becomes unknown not deleted', async () => {
  tracked(); db.upsertPosition({ coin: '#100', side: 'YES', size: '10', entryPrice: '.4' });
  const c = client({ async getOpenOrders() { throw new Error('offline'); }, async getUserBalances() { return {}; } });
  workers.startWorkers({ hlClient: c }); await settle();
  assert.equal(db.getOrderByOid('42').status, 'open'); assert.equal(db.getPositions().length, 1);
  c.getUserBalances = async () => ({ balances: [{ coin: '+100', total: 'malformed' }] });
  await workers.syncPositionsWorker();
  assert.equal(db.getPositions()[0].size, '10');
  c.getOpenOrders = async () => [];
  c.getUserFills = async () => { throw new Error('offline'); };
  await workers.monitorOrdersWorker(); assert.equal(db.getOrderByOid('42').status, 'unknown');
});

test('partial fill remains tracked until authoritative cancellation, never pretends full original size filled', async () => {
  tracked();
  const c = client({ async getUserFills() { return [{ oid: 42, sz: '3', px: '.4', tid: 1 }]; } });
  workers.startWorkers({ hlClient: c }); await settle();
  assert.equal(db.getOrderByOid('42').status, 'partial'); assert.equal(db.getOrderByOid('42').size, '10');
  c.getOrderStatus = async () => ({ status: 'order', order: { status: 'canceled' } });
  await workers.monitorOrdersWorker(); assert.equal(db.getOrderByOid('42').status, 'cancelled');
});

test('filled notification reports actual aggregate fill size and weighted price once', async () => {
  tracked(); const notifications = [];
  const c = client({ async getUserFills() { return [{ oid: 42, sz: '2', px: '.4', tid: 1 }, { oid: '42', sz: '3', px: '.6', tid: 2 }]; },
    async getOrderStatus() { return { status: 'order', order: { status: 'filled' } }; } });
  workers.startWorkers({ hlClient: c, chatId: 7, bot: { api: { async sendMessage(id, text) { notifications.push(text); } } } });
  await settle(); await workers.monitorOrdersWorker();
  assert.equal(db.getOrderByOid('42').status, 'filled'); assert.equal(notifications.length, 1);
  assert.match(notifications[0], /5/); assert.match(notifications[0], /0\.52|52/);
});

for (const failure of ['fills throws', 'fills missing', 'fills malformed', 'send fails']) {
  test(`filled notification stays pending through ${failure}, restart and recovery without duplicates`, async () => {
    tracked(); let recovered = false; let attempts = 0; const sent = [];
    const c = client({
      async getOrderStatus() { return { status: 'order', order: { status: 'filled' } }; },
      async getUserFills() {
        if (!recovered && failure === 'fills throws') throw new Error('offline');
        if (!recovered && failure === 'fills missing') return [];
        if (!recovered && failure === 'fills malformed') return [{ oid: 42, sz: '5', px: 'bad' }];
        return [{ oid: 42, sz: '5', px: '.52', tid: 1 }, { oid: 42, sz: '5', px: '.52', tid: 1 }];
      },
    });
    const bot = { api: { async sendMessage(id, text) {
      attempts++;
      if (!recovered && failure === 'send fails') throw new Error('Telegram unavailable');
      sent.push(text);
    } } };
    workers.startWorkers({ hlClient: c, bot, chatId: 7 }); await settle();
    assert.equal(db.getOrderByOid('42').status, 'filled');
    assert.equal(db.getOrderByOid('42').fill_notification_status, 'pending');
    assert.equal(sent.length, 0);
    await workers.stopWorkers(); db.closeDatabase();
    db.initDatabase({ network: 'testnet', accountAddress: owner });
    assert.equal(db.getOrderByOid('42').fill_notification_status, 'pending');
    recovered = true;
    // A terminal exchange status must survive later status endpoint outages.
    c.getOrderStatus = async () => { throw new Error('status unavailable'); };
    c.getOpenOrders = async () => [{ oid: 42, coin: '#100', side: 'B', sz: '10', limitPx: '.4' }];
    workers.startWorkers({ hlClient: c, bot, chatId: 7 }); await settle();
    assert.equal(db.getOrderByOid('42').status, 'filled');
    assert.equal(db.getOrderByOid('42').fill_notification_status, 'delivered');
    assert.equal(sent.length, 1); assert.match(sent[0], /Size: 5/); assert.match(sent[0], /0\.52/);
    await workers.monitorOrdersWorker();
    await workers.stopWorkers(); db.closeDatabase();
    db.initDatabase({ network: 'testnet', accountAddress: owner });
    workers.startWorkers({ hlClient: c, bot, chatId: 7 }); await settle();
    assert.equal(sent.length, 1);
    assert.equal(attempts, failure === 'send fails' ? 2 : 1);
  });
}

test('scoped cache additive notification migration preserves old rows and legacy database', () => {
  writeFileSync(join(root, 'database.sqlite'), 'legacy-retained');
  tracked();
  db.getDb().exec('ALTER TABLE orders DROP COLUMN fill_notification_status');
  db.initDatabase({ network: 'testnet', accountAddress: owner });
  const order = db.getOrderByOid('42');
  assert.equal(order.status, 'open'); assert.equal(order.size, '10');
  assert.equal(order.fill_notification_status, null);
  assert.equal(readFileSync(join(root, 'database.sqlite'), 'utf8'), 'legacy-retained');
});

test('position entry derives entryNtl / total and unknown entry remains explicitly empty', async () => {
  const c = client({ async getUserBalances() { return { balances: [
    { coin: '+100', total: '10', entryNtl: '4' }, { coin: '#101', total: '5' }, { coin: '@100', total: '30' },
  ] }; } });
  workers.startWorkers({ hlClient: c }); await settle();
  const positions = db.getPositions(); assert.equal(positions.length, 2);
  assert.equal(positions.find(p => p.coin === '#100').entry_price, '0.4');
  assert.equal(positions.find(p => p.coin === '#101').entry_price, '');
});

test('activation drains in-flight old workers before switching DB/client; no overlap, starts new wallet workers', async () => {
  let release; let calls = 0; const blocked = new Promise(r => { release = r; });
  const old = client({ async getUserBalances() { calls++; await blocked; return { balances: [{ coin: '#100', total: '10', entryNtl: '4' }] }; } });
  await rt.activateHLClient(old, { workers: { syncPositionsMs: 5 } });
  while (!calls) await new Promise(r => setImmediate(r));
  await new Promise(r => setTimeout(r, 20)); assert.equal(calls, 1);
  const next = client({ network: 'mainnet' }); let switched = false;
  const switching = rt.activateHLClient(next).then(() => { switched = true; });
  await new Promise(r => setTimeout(r, 10)); assert.equal(switched, false); assert.equal(rt.hlClient, old);
  release(); await switching; await settle(); assert.equal(rt.hlClient, next);
  assert.equal(db.getPositions().length, 0);
  await workers.stopWorkers(); assert.deepEqual(workers.getWorkersHealthSnapshot().running, []);
  assert.equal(workers.getWorkersHealthSnapshot().workersStarted, false);
  db.initDatabase({ network: 'testnet', accountAddress: owner }); assert.equal(db.getPositions().length, 1);
});
