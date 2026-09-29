import test from 'node:test';
import assert from 'node:assert/strict';
import { createCampaignMonitor, getCampaignSnapshot } from '../../src/modules/liquidity/campaigns.js';

const row = (extra = {}) => ({ market_id: 'O6231', epoch_end_date: '2026-09-28', market_name: 'HYPE above 92?', period_type: 'epoch', finalized_at: '2026-09-28T11:54:53.113Z', awarded_usdc: '484.374985', paid_usdc: '484.374985', wallets: 25, payments: 25, state: 'paid', ...extra });
const payload = (periods = [row()], page = {}) => ({ page: { limit: 2, offset: 0, returned: periods.length, total: 1161, has_more: true, ...page }, periods });
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('public history is bounded, cached, paginated and never asserts active eligibility', async () => {
  let time = Date.parse('2026-09-29T00:00:00Z');
  const urls = [];
  const monitor = createCampaignMonitor({ now: () => time, fetch: async url => { urls.push(url); return response(payload()); }, ttlMs: 1000 });
  const first = await monitor.getCampaignSnapshot({ limit: 2 });
  assert.equal(first.available, false);
  assert.equal(first.active.available, false);
  assert.equal(first.active.eligibility, 'unknown');
  assert.equal(first.history.available, true);
  assert.deepEqual(first.history.page, { limit: 2, offset: 0, returned: 1, total: 1161, hasMore: true });
  assert.equal(first.history.complete, false);
  assert.equal(first.history.periods[0].awardedUsdc, '484.374985');
  assert.deepEqual(first.history.changes, []);
  assert.equal(first.history.fetchedAt, '2026-09-29T00:00:00.000Z');
  assert.equal((await monitor.getCampaignSnapshot({ limit: 2 })).history.fetchedAt, first.history.fetchedAt);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/v1\/rewards\/periods\?limit=2&offset=0$/);
  time += 1001;
  assert.deepEqual((await monitor.getCampaignSnapshot({ limit: 2 })).history.changes, []);
  assert.equal(urls.length, 2);
});

test('historical changes are deduplicated by period identity and content, not invented campaigns', async () => {
  let time = 1000, n = 0;
  const monitor = createCampaignMonitor({ now: () => time, ttlMs: 100, fetch: async () => response(payload([row({ state: n++ ? 'paid' : 'partial', paid_usdc: n === 1 ? '0' : '484.374985' })], { limit: 50 })) });
  const first = await monitor.getCampaignSnapshot();
  assert.deepEqual(first.history.changes, []);
  time += 101;
  const second = await monitor.getCampaignSnapshot();
  assert.equal(second.history.changes.length, 1);
  assert.equal(second.history.changes[0].type, 'updated');
  assert.equal(second.history.changes[0].period.state, 'paid');
  assert.deepEqual((await monitor.getCampaignSnapshot()).history.changes, []);
  time += 101;
  assert.deepEqual((await monitor.getCampaignSnapshot()).history.changes, []);
});

test('failures and malformed data mean unavailable, never zero rewards', async () => {
  for (const result of [response({ ...payload(), periods: [row({ awarded_usdc: 0 })] }), response(payload([row()], { returned: 2 })), response(payload([row()], { has_more: false })), new Response('no', { status: 503 }), new Response('html', { headers: { 'Content-Type': 'text/html' } })]) {
    const snapshot = await createCampaignMonitor({ fetch: async () => result }).getCampaignSnapshot();
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.history.available, false);
    assert.deepEqual(snapshot.history.periods, []);
    assert.equal(snapshot.history.error, 'reward_history_unavailable');
  }
});

test('timeout and excessive body fail closed, options bounded before fetch', async () => {
  let calls = 0;
  const monitor = createCampaignMonitor({ fetch: async (_url, { signal }) => {
    calls++;
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  }, timeoutMs: 15 });
  assert.equal((await monitor.getCampaignSnapshot()).history.available, false);
  assert.equal(calls, 1);
  await assert.rejects(monitor.getCampaignSnapshot({ limit: 501 }), /limit/);
  assert.equal(calls, 1);
  const large = createCampaignMonitor({ fetch: async () => new Response('x'.repeat(200_000), { headers: { 'Content-Type': 'application/json' } }), maxBodyBytes: 1000 });
  assert.equal((await large.getCampaignSnapshot()).history.available, false);
});

test('entrypoint remains callable without wallet or credentials', async () => {
  const result = await getCampaignSnapshot({ fetch: async () => response(payload([row()], { limit: 50 })), now: () => 1000 });
  assert.equal(result.active.available, false);
  assert.equal(result.history.available, true);
});
