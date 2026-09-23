import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'hip4-mcp-actions-'));
process.env.HIP4_DATA_DIR = dir;
process.env.LOG_TO_FILE = 'false';
const { issueMcpKey, authenticateMcp } = await import('../../src/modules/mcp/key-store.js');
const runtime = await import('../../src/modules/bot/runtime.js');
const { mcpOperation, handleMcpApproval, clearMcpActions } = await import('../../src/modules/mcp/operations.js');
const { resetOutcomeCache } = await import('../../src/modules/bot/features/outcomes.js');
const messages = [];
let writes = 0, transfers = 0;
const client = {
  address: '0x' + '11'.repeat(20), network: 'mainnet',
  async prepareOrder({ coin, isBuy, price, size }) { return { coin, isBuy, price, size, orderType: 'Limit', maxSpend: isBuy ? price * size * 1.01 : null }; },
  async getSpotUsdcBalance() { return 100; },
  async placeOrders(requests) { writes++; assert.equal(requests[0].coin, '#100'); return { response: { data: { statuses: [{ filled: { oid: 17 } }] } } }; },
  async transferUsdClass() { transfers++; throw new Error('Should not transfer'); }
};
runtime.setAllowedUserId(7);
runtime.setHLClient(client);
runtime.setBot({ api: { async sendMessage(_chatId, text, extra) { messages.push({ text, extra }); return { message_id: messages.length }; } } });
const ctx = () => ({ chat: { id: 7, type: 'private' }, from: { id: 7 }, async reply(text) { messages.push({ text }); } });
test.after(async () => { runtime.setHLClient(null); runtime.setBot(null); clearMcpActions(); await rm(dir, { recursive: true, force: true }); });

test('read key cannot request trades; trade key only queues one review until private Telegram approval', async () => {
  const read = await authenticateMcp(`Bearer ${await issueMcpKey('read')}`);
  const trade = await authenticateMcp(`Bearer ${await issueMcpKey('trade')}`);
  const args = { coin: '#100', is_buy: true, price: 0.5, size: 20, request_id: 'first-order-1' };
  await assert.rejects(() => mcpOperation('request_limit_order', args, read), /scope/);
  assert.equal(messages.length, 0);
  const first = await mcpOperation('request_limit_order', args, trade);
  assert.equal(first.status, 'pending');
  assert.equal(writes, 0);
  assert.equal(transfers, 0);
  assert.equal((await mcpOperation('request_limit_order', args, trade)).action_id, first.action_id);
  assert.equal(messages.length, 1);
  await assert.rejects(() => mcpOperation('request_limit_order', { ...args, size: 30 }, trade), /reused/);
  const button = messages[0].extra.reply_markup.inline_keyboard.flat().find(b => b.text === 'Approve trade');
  assert.equal(runtime.consumeConfirmation(7, button.callback_data), 'confirm_mcp_action');
  await handleMcpApproval(ctx());
  assert.equal(writes, 1);
  assert.equal(transfers, 0);
  const status = await mcpOperation('get_action_status', { action_id: first.action_id }, trade);
  assert.equal(status.status, 'done');
  assert.equal(status.result.execution, 'filled');
  assert.equal(runtime.consumeConfirmation(7, button.callback_data), null);
  await assert.rejects(() => mcpOperation('request_limit_order', args, read), /scope/);
});

test('rotation invalidates pending approval before exchange submission', async () => {
  const old = await authenticateMcp(`Bearer ${await issueMcpKey('trade')}`);
  const pending = await mcpOperation('request_limit_order', { coin: '#100', is_buy: true, price: 0.5, size: 20, request_id: 'second-order-2' }, old);
  const button = messages.at(-1).extra.reply_markup.inline_keyboard.flat().find(b => b.text === 'Approve trade');
  await issueMcpKey('trade');
  assert.equal(runtime.consumeConfirmation(7, button.callback_data), 'confirm_mcp_action');
  await handleMcpApproval(ctx());
  assert.equal(writes, 1);
  assert.equal(transfers, 0);
  assert.equal(pending.status, 'pending');
});

test('concurrent retries of one request_id share one Telegram review and one action', async () => {
  const original = client.prepareOrder;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  client.prepareOrder = async (...params) => { await gate; return original(...params); };
  try {
    const trade = await authenticateMcp(`Bearer ${await issueMcpKey('trade')}`);
    const args = { coin: '#100', is_buy: true, price: 0.5, size: 20, request_id: 'concurrent-order-1' };
    const before = messages.length;
    const first = mcpOperation('request_limit_order', args, trade);
    const second = mcpOperation('request_limit_order', args, trade);
    const conflicting = mcpOperation('request_limit_order', { ...args, request_id: 'concurrent-order-2' }, trade);
    release();
    await assert.rejects(conflicting, /pending MCP action/);
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.action_id, b.action_id);
    assert.equal(messages.length, before + 1);
    assert.equal(writes, 1);
    const button = messages.at(-1).extra.reply_markup.inline_keyboard.flat().find(b => b.text === 'Approve trade');
    assert.equal(runtime.consumeConfirmation(7, button.callback_data), 'confirm_mcp_action');
    await Promise.all([handleMcpApproval(ctx()), handleMcpApproval(ctx())]);
    assert.equal(writes, 2);
    assert.equal(runtime.consumeConfirmation(7, button.callback_data), null);
    await assert.rejects(() => mcpOperation('request_limit_order', { ...args, size: 21 }, trade), /reused/);
  } finally { client.prepareOrder = original; }
});

test('MCP market filtering uses the same five-minute category catalog as Telegram', async () => {
  resetOutcomeCache();
  client.getOutcomeMeta = async () => ({ questions: [], deployers: [{ venue: 'outcome', deployer: '0x' + '22'.repeat(20) }], outcomes: [
    { outcome: 10, name: 'template:sports:sample', description: 'sports', venue: 'outcome', sideSpecs: [{ name: 'Yes' }, { name: 'No' }] },
    { outcome: 11, name: 'template:binaryPrice:sample', description: 'class:priceBinary|underlying:BTC|targetPrice:10', venue: 'outcome', sideSpecs: [{ name: 'Yes' }, { name: 'No' }] }
  ] });
  client.getAllMids = async () => ({ '#100': '0.3', '#101': '0.7' });
  const read = await authenticateMcp(`Bearer ${await issueMcpKey('read')}`);
  const list = await mcpOperation('list_markets', { page: 1, category: 'sports', venue: 'outcome' }, read);
  assert.equal(list.total, 1);
  assert.equal(list.items[0].yes_coin, '#100');
  assert.equal(list.cached_prices_not_executable, true);
  const market = await mcpOperation('get_market', { outcome_id: 10 }, read);
  assert.equal(market.yes_price_cached, 0.3);
  resetOutcomeCache();
});
