import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
const root = mkdtempSync(join(tmpdir(), 'hip4-tg-api-'));
process.env.HIP4_DATA_DIR = root;
process.env.LOG_TO_FILE = 'false';
const { initBot } = await import('../../src/modules/bot/bot.js');
const rt = await import('../../src/modules/bot/runtime.js');
const cfg = await import('../../src/modules/config.js');
const workers = await import('../../src/modules/workers.js');
const db = await import('../../src/modules/database.js');
const owner = new ethers.Wallet('0x' + '11'.repeat(32));
const agent = new ethers.Wallet('0x' + '22'.repeat(32));
let bot, sent, events, failDelete, revoked, id = 0;
const originalFetch = globalThis.fetch;
beforeEach(async () => {
  await workers.stopWorkers(); db.closeDatabase();
  rt.userStates.clear(); rt.busyLocks.clear(); rt.rateLimits.clear(); rt.setHLClient(null);
  cfg.setSessionConfig(null); await cfg.saveConfig({ language: 'ru', hlNetwork: 'testnet' });
  sent = []; events = []; failDelete = false; revoked = false;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); events.push(body.type);
    if (body.type === 'spotClearinghouseState') return new Response(JSON.stringify({ balances: [] }));
    if (body.type === 'clearinghouseState') return new Response(JSON.stringify({ assetPositions: [], marginSummary: { accountValue: '0' } }));
    if (body.type === 'openOrders') return new Response('[]');
    assert.equal(body.type, 'extraAgents');
    return new Response(JSON.stringify(revoked ? [] : [{ address: agent.address, validUntil: Date.now() + 86400000 }]));
  };
  bot = await initBot('123456:synthetic-test-token', 7);
  bot.botInfo = { id: 123456, is_bot: true, first_name: 'Test', username: 'synthetic_test_bot' };
  bot.api.config.use(async (prev, method, payload) => {
    events.push(method); sent.push({ method, ...payload });
    if (method === 'deleteMessage' && failDelete) throw new Error('denied');
    return { ok: true, result: method === 'deleteMessage' ? true : { message_id: ++id, chat: { id: 7, type: 'private' }, date: 1, text: payload.text } };
  });
});
after(async () => { await workers.stopWorkers(); db.closeDatabase(); globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); });
function update(data, text, chat = { id: 7, type: 'private' }, user = 7) {
  const message = { message_id: ++id, date: 1, chat, from: { id: user, is_bot: false, first_name: 'User' }, text };
  return { update_id: ++id, ...(data ? { callback_query: { id: String(id), chat_instance: '1', from: message.from, message: { ...message, text: 'Menu' }, data } } : { message }) };
}
async function callback(data) { rt.rateLimits.clear(); await bot.handleUpdate(update(data)); }
async function prompt() {
  await callback('wallet:connect_api'); await callback('wallet:api_owner');
  await bot.handleUpdate(update(null, owner.address));
  await callback('wallet:api_key');
}
const lastKeyboard = () => sent.filter(m => m.reply_markup).at(-1).reply_markup.inline_keyboard.flat();
test('actual Grammy dialogue preserves owner, primary button order, deletes rapid key before API, saves and activates once', async () => {
  await callback('wallet:connect_api');
  assert.deepEqual(lastKeyboard().slice(0, 2).map(b => b.callback_data), ['wallet:api_owner', 'wallet:api_key']);
  assert.deepEqual(lastKeyboard().slice(0, 2).map(b => b.text), ['Кошелёк', 'Приватник']);
  await callback('wallet:api_owner'); await bot.handleUpdate(update(null, owner.address));
  await callback('wallet:api_key');
  assert.ok(sent.some(m => m.text?.includes(owner.address) && m.text.includes('testnet') && m.text.includes('Отправьте только')));
  events.length = 0;
  await Promise.all([bot.handleUpdate(update(null, agent.privateKey)), bot.handleUpdate(update(null, agent.privateKey))]);
  assert.equal(events[0], 'deleteMessage'); assert.equal(events.filter(x => x === 'deleteMessage').length, 2);
  const saved = await cfg.loadConfig(); assert.equal(saved.walletAddress, owner.address); assert.equal(saved.agentAddress, agent.address);
  assert.equal(rt.hlClient.address, owner.address); assert.equal(rt.hlClient.wallet.address, agent.address);
  assert.equal(rt.busyLocks.size, 0); assert.equal(rt.runtimeTransitioning, false);
  assert.equal(sent.filter(m => m.text?.startsWith('API-кошелёк сохранён и подключён.')).length, 1);
  assert.ok(!JSON.stringify(sent).includes(agent.privateKey)); assert.ok(!readFileSync(join(root, 'config.json'), 'utf8').includes(agent.privateKey.slice(2)));
  assert.equal(statSync(join(root, 'config.json')).mode & 0o777, 0o600);
  assert.equal((await rt.createConfiguredHLClient(saved)).wallet.address, agent.address);
});
test('deletion failure refuses saving and warns without secret echo', async () => {
  await prompt(); failDelete = true; events.length = 0;
  await bot.handleUpdate(update(null, agent.privateKey));
  assert.equal(events.includes('extraAgents'), false); assert.equal((await cfg.loadConfig()).walletAddress, undefined);
  assert.ok(sent.some(m => m.text?.includes('Удалите его вручную'))); assert.ok(!JSON.stringify(sent).includes(agent.privateKey));
});
test('malformed command-looking secret is deleted before command interception', async () => {
  await prompt(); events.length = 0;
  const u = update(null, '/start malformed'); u.message.entities = [{ type: 'bot_command', offset: 0, length: 6 }];
  await bot.handleUpdate(u); assert.equal(events[0], 'deleteMessage'); assert.equal(events.includes('extraAgents'), false);
  assert.equal(rt.userStates.has(7), false); assert.equal(rt.hlClient, null);
});
test('cancel, TTL, runtime identity and disk changes reject keys, while still deleting them', async () => {
  for (const change of [async () => callback('back_menu'), async () => { rt.userStates.get(7).expiresAt = 0; }, async () => rt.setHLClient({ address: owner.address, network: 'testnet' }), async () => cfg.saveConfig({ language: 'ru', hlNetwork: 'mainnet' })]) {
    rt.setHLClient(null); await cfg.saveConfig({ language: 'ru', hlNetwork: 'testnet' });
    await prompt(); await change(); events.length = 0;
    await bot.handleUpdate(update(null, agent.privateKey));
    assert.equal(events[0], 'deleteMessage'); assert.equal(events.includes('extraAgents'), false); assert.equal((await cfg.loadConfig()).encrypted, undefined);
  }
});
test('group and unauthorized messages cannot enter or mutate setup', async () => {
  for (const [chat, user] of [[{ id: -1, type: 'group' }, 7], [{ id: 8, type: 'private' }, 8]]) {
    await bot.handleUpdate(update('wallet:connect_api', null, chat, user));
    await bot.handleUpdate(update(null, agent.privateKey, chat, user));
  }
  assert.equal(rt.userStates.size, 0); assert.equal(events.includes('extraAgents'), false); assert.ok(!JSON.stringify(sent).includes(agent.privateKey));
});
test('revoked agent refuses saving and releases busy lock', async () => {
  await prompt(); revoked = true; await bot.handleUpdate(update(null, agent.privateKey));
  assert.equal((await cfg.loadConfig()).encrypted, undefined); assert.equal(rt.busyLocks.size, 0); assert.equal(rt.hlClient, null);
});

test('replacement warning and encrypted backup precede automatic renewal from disabled runtime', async () => {
  const { importWallet } = await import('../../src/modules/auth.js');
  const old = await importWallet(owner.privateKey);
  await cfg.saveConfig({ language: 'ru', hlNetwork: 'testnet', walletAddress: owner.address, encrypted: { privateKey: old.encryptedPrivateKey } });
  await prompt();
  assert.ok(sent.some(m => m.text?.includes('заменит сохранённое подключение') && m.text.includes('резервная копия')));
  await callback('wallet:api_help');
  assert.equal(rt.userStates.get(7).owner, owner.address);
  await bot.handleUpdate(update(null, agent.privateKey));
  assert.equal(rt.hlClient.wallet.address, agent.address);
  const { readdirSync } = await import('node:fs');
  assert.ok(readdirSync(root).some(n => n.endsWith('.enc')));
});
