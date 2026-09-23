import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'hip4-security-'));
process.env.HIP4_DATA_DIR = root;
process.env.LOG_TO_FILE = 'false';
const config = await import('../../src/modules/config.js');
const auth = await import('../../src/modules/auth.js');
const rt = await import('../../src/modules/bot/runtime.js');
const { handleCallbackQuery } = await import('../../src/modules/bot/routing/callback-router.js');
const { handleTextMessage } = await import('../../src/modules/bot/routing/text-router.js');
const { HLClient } = await import('../../src/modules/hyperliquid.js');
const db = await import('../../src/modules/database.js');
const workers = await import('../../src/modules/workers.js');
const { ethers } = await import('ethers');
const key = '0x' + '11'.repeat(32);
const owner = new ethers.Wallet(key).address;
let lastId = 100;
function context(data, text) {
  const messages = [], deleted = [], answers = [];
  return { chat: { id: 7, type: 'private' }, from: { id: 7 },
    callbackQuery: { data, message: { message_id: 55 } }, message: { text, message_id: 56 },
    messages, deleted, answers,
    api: { async deleteMessage(chat, id) { deleted.push(id); } },
    async editMessageText(text, extra) { messages.push({ text, ...extra }); return { message_id: 55 }; },
    async reply(text, extra) { const message_id = ++lastId; messages.push({ text, message_id, ...extra }); return { message_id }; },
    async answerCallbackQuery(text) { answers.push(text); },
  };
}
function button(ctx, prefix) {
  return ctx.messages.flatMap(m => m.reply_markup?.inline_keyboard?.flat() || []).find(b => b.callback_data?.startsWith(prefix))?.callback_data;
}
async function stored() {
  const imported = await auth.importWallet(key);
  return { walletAddress: owner, encrypted: { privateKey: imported.encryptedPrivateKey }, language: 'en', hlNetwork: 'testnet', authMode: 'wallet', notifications: { priceChangePercent: 10 } };
}
beforeEach(async () => {
  await workers.stopWorkers();
  for (const id of rt.userStates.keys()) await rt.invalidateUserState(id);
  rt.busyLocks.clear(); rt.confirmationLocks.clear(); rt.rateLimits.clear();
  rt.setAllowedUserId(7); rt.setHLClient({ address: owner, network: 'testnet' });
  config.setSessionConfig(null);
  await config.saveConfig(await stored());
});
after(async () => { await workers.stopWorkers(); await rt.invalidateUserState(7); db.closeDatabase(); rmSync(root, { recursive: true, force: true }); });

test('wallet setup refuses encrypted-only/address-only/existing and preserves settings', async () => {
  for (const current of [await stored(), { walletAddress: owner }, { encrypted: { privateKey: 'present' } }]) {
    await config.saveConfig(current);
    await assert.rejects(auth.initializeWallet(), /refusing to overwrite/);
    assert.deepEqual(await config.loadConfig(), current);
  }
  const original = { language: 'ru', hlNetwork: 'mainnet', notifications: { priceChangePercent: 27 }, custom: 'retained' };
  await config.saveConfig(original);
  const results = await Promise.allSettled([auth.initializeWallet(), auth.initializeWallet()]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const saved = await config.loadConfig();
  assert.equal(saved.language, 'ru'); assert.equal(saved.hlNetwork, 'mainnet'); assert.equal(saved.custom, 'retained');
  assert.deepEqual(saved.notifications, original.notifications);
  await auth.validateWalletConfig(saved);
});

test('bootstrap validator verifies actual stored signer versus owner/agent identity', async () => {
  const value = await stored();
  assert.equal(await auth.validateWalletConfig(value), key);
  await assert.rejects(auth.validateWalletConfig({ ...value, walletAddress: '0x' + '22'.repeat(20) }), /identity/);
  assert.equal(await auth.validateWalletConfig({ ...value, authMode: 'agent', agentAddress: owner, walletAddress: '0x' + '22'.repeat(20) }), key);
  await assert.rejects(auth.validateWalletConfig({ ...value, encrypted: { privateKey: 'corrupt' } }));
});

test('real bootstrap subprocess decrypts stored config and rejects corrupt/partial signer without network', async () => {
  const run = () => spawnSync(process.execPath, ['--import', fileURLToPath(new URL('../offline-network.js', import.meta.url)), fileURLToPath(new URL('../../src/index.js', import.meta.url)), '--bootstrap'], {
    cwd: root, env: { ...process.env, HIP4_DATA_DIR: root, DOTENV_CONFIG_PATH: join(root, '.env'), LOG_TO_FILE: 'false' }, encoding: 'utf8', timeout: 10000,
  });
  const original = readFileSync(join(root, 'config.json'), 'utf8');
  const valid = run(); assert.equal(valid.status, 0, valid.stderr);
  assert.equal(readFileSync(join(root, 'config.json'), 'utf8'), original);
  for (const value of [{ ...(await stored()), encrypted: { privateKey: 'corrupt' } }, { agentAddress: owner }]) {
    await config.saveConfig(value);
    const invalid = run(); assert.equal(invalid.status, 1); assert.doesNotMatch(invalid.stdout, /Bootstrap OK/);
  }
});

test('session config never persists ephemeral agent or overwrites base wallet', async () => {
  const original = readFileSync(join(root, 'config.json'), 'utf8');
  config.setSessionConfig({ ...(await config.loadConfig()), authMode: 'agent', encrypted: { privateKey: '' } });
  await config.updateConfig('language', 'ru');
  assert.equal((await config.ensureConfigFileExists()).language, 'ru');
  assert.equal(readFileSync(join(root, 'config.json'), 'utf8'), original);
  config.setSessionConfig(null); assert.equal((await config.loadConfig()).language, 'en');
});

test('ephemeral agent /start and settings use configured menu and never overwrite disk wallet', async () => {
  const original = readFileSync(join(root, 'config.json'), 'utf8');
  config.setSessionConfig({ ...(await config.loadConfig()), authMode: 'agent', agentAddress: owner, encrypted: { privateKey: '' } });
  assert.equal(await config.isWalletConfigured(), true);
  const { initBot } = await import('../../src/modules/bot/bot.js');
  const bot = await initBot('123456:synthetic-test-token', 7);
  bot.botInfo = { id: 123456, is_bot: true, first_name: 'Test', username: 'synthetic_test_bot' };
  const sent = [];
  bot.api.config.use(async (prev, method, payload) => {
    sent.push({ method, ...payload });
    return { ok: true, result: { message_id: 1, chat: { id: 7, type: 'private' }, date: 1, text: payload.text } };
  });
  await bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 7, type: 'private' }, from: { id: 7, is_bot: false, first_name: 'Owner' }, text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] } });
  assert.ok(sent.some(m => m.text?.includes(owner)));
  assert.ok(sent.every(m => !m.reply_markup?.inline_keyboard?.flat().some(b => b.callback_data === 'init_wallet')));
  await handleCallbackQuery(context('init_wallet'));
  await handleCallbackQuery(context('start_export_pk'));
  await handleCallbackQuery(context('settings:network'));
  assert.equal(rt.userStates.has(7), false);
  await config.updateConfig('language', 'ru');
  assert.equal(readFileSync(join(root, 'config.json'), 'utf8'), original);
  config.setSessionConfig(null);
  await config.saveConfig({ walletAddress: owner, agentAddress: owner, authMode: 'agent' });
  assert.equal(await config.isWalletConfigured(), false);
});

test('activation invalidates reviews and secret cleanup even without active input, fails closed on persistence error', async () => {
  const token = rt.confirmationCallback(7, 'confirm_fund_predictions', { state: 'CONFIRMING_FUND_PREDICTIONS', amount: 2 });
  const ctx = context(''); rt.scheduleMessageDeletion(ctx, [999]);
  rt.userStates.delete(7);
  await assert.rejects(rt.activateHLClient({ address: owner, network: 'mainnet' }, { persist: async () => { throw new Error('disk unavailable'); } }), /disk unavailable/);
  assert.equal(rt.hlClient, null);
  assert.equal(rt.consumeConfirmation(7, token), null);
  assert.deepEqual(ctx.deleted, [999]);
  assert.equal(workers.getWorkersHealthSnapshot().workersStarted, false);
  assert.equal(rt.runtimeTransitioning, false);
});

test('router rejects stale A without destroying B, bare callbacks and replay', async () => {
  const a = rt.confirmationCallback(7, 'confirm_fund_predictions', { state: 'CONFIRMING_FUND_PREDICTIONS', amount: 1 });
  const b = rt.confirmationCallback(7, 'confirm_fund_predictions', { state: 'CONFIRMING_FUND_PREDICTIONS', amount: 2 });
  const transfers = [];
  rt.setHLClient({ address: owner, network: 'testnet', async getAccountAbstraction() { return 'disabled'; }, async transferUsdClass(amount) { transfers.push(amount); } });
  await handleCallbackQuery(context(a));
  assert.equal(rt.userStates.get(7).amount, 2);
  await handleCallbackQuery(context('confirm_fund_predictions'));
  await handleCallbackQuery(context(b));
  await handleCallbackQuery(context(b));
  assert.deepEqual(transfers, [2]);
  assert.equal(rt.confirmationLocks.size, 0); assert.equal(rt.busyLocks.size, 0);
});

test('funding screen is review only; confirmation uses frozen amount not increased live balance', async () => {
  const transferred = [];
  let balance = 10.129;
  rt.setHLClient({ address: owner, network: 'testnet', async getAccountAbstraction() { return 'disabled'; }, async getSpotUsdcBalance() { return balance; }, async transferUsdClass(n) { transferred.push(n); } });
  const ctx = context('wallet:fund_predictions'); await handleCallbackQuery(ctx);
  const callback = button(ctx, 'confirm_fund_predictions:'); assert.ok(callback); assert.deepEqual(transferred, []);
  balance = 500;
  await handleCallbackQuery(context(callback)); assert.deepEqual(transferred, [10.12]);
});

test('unified wallet displays spot outcome funds, hides perp transfer, and rejects stale transfer callback', async () => {
  const transfers = [];
  const fake = {
    address: owner, network: 'mainnet',
    async getAccountAbstraction() { return 'unifiedAccount'; },
    async getSpotUsdcBalance() { return 255.5; },
    async getPerpBalance() { throw new Error('perp state is not meaningful'); },
    async refreshOutcomeBuilderStatus() { return { status: 'approved' }; },
    async transferUsdClass(...args) { transfers.push(args); },
  };
  rt.setHLClient(fake);
  await config.saveConfig({ ...(await stored()), hlNetwork: 'mainnet', language: 'ru' });
  const wallet = context('wallet'); await handleCallbackQuery(wallet);
  assert.match(wallet.messages.at(-1).text, /255\.50/);
  assert.match(wallet.messages.at(-1).text, /Единый счёт/);
  assert.doesNotMatch(wallet.messages.at(-1).text, /Средства предсказаний: \$0/);
  assert.equal(button(wallet, 'wallet:fund_predictions'), undefined);
  const stale = context('wallet:fund_predictions'); await handleCallbackQuery(stale);
  assert.match(stale.messages.at(-1).text, /перевод USDC в перп.*не нужен/);
  const token = rt.confirmationCallback(7, 'confirm_fund_predictions', { state: 'CONFIRMING_FUND_PREDICTIONS', amount: 10 });
  const confirmed = context(token); await handleCallbackQuery(confirmed);
  assert.match(confirmed.messages.at(-1).text, /не нужен/);
  assert.deepEqual(transfers, []);
});

test('menu/cancel/new flow invalidate confirmation; account and network binding reject stale', async () => {
  for (const navigation of ['back_menu', 'cancel_confirmation', 'start_export_pk', 'settings']) {
    const token = rt.confirmationCallback(7, 'confirm_fund_predictions', { state: 'CONFIRMING_FUND_PREDICTIONS', amount: 2 });
    await handleCallbackQuery(context(navigation));
    assert.equal(rt.consumeConfirmation(7, token), null);
  }
  const token = rt.confirmationCallback(7, 'confirm_fund_predictions', { state: 'x' });
  rt.setHLClient({ address: owner, network: 'mainnet' }); assert.equal(rt.consumeConfirmation(7, token), null);
  rt.setHLClient({ address: '0x' + '22'.repeat(20), network: 'testnet' }); assert.equal(rt.consumeConfirmation(7, token), null);
});

test('private-chat guards stop callback and text handlers even for allowed sender in group', async () => {
  for (const type of ['group', 'supergroup', 'channel']) {
    const ctx = context('start_export_pk', 'CONFIRM'); ctx.chat.type = type;
    await handleCallbackQuery(ctx); await handleTextMessage(ctx);
    assert.equal(ctx.messages.length, 0);
  }
  const ctx = context('init_wallet'); ctx.from.id = 8;
  await handleCallbackQuery(ctx); assert.equal(ctx.messages.length, 0);
});

async function exportPrompt() {
  const start = context('start_export_pk'); await handleCallbackQuery(start);
  const token = button(start, 'confirm_export_pk:'); assert.ok(token);
  const confirm = context(token); await handleCallbackQuery(confirm);
  assert.equal(rt.userStates.get(7).state, 'AWAITING_EXPORT_CONFIRMATION');
  return confirm;
}

test('export rejects arbitrary text, exact-case mismatch, expiration; one-time exact CONFIRM deletes prompts', async () => {
  for (const text of ['password', 'confirm', 'CONFIRM ', 'anything']) {
    await exportPrompt(); const input = context('', text); await handleTextMessage(input);
    assert.ok(input.messages.every(m => !m.text.includes(key))); assert.equal(rt.userStates.has(7), false);
  }
  await exportPrompt(); rt.userStates.get(7).expiresAt = Date.now() - 1;
  const expired = context('', 'CONFIRM'); await handleTextMessage(expired); assert.ok(expired.messages.every(m => !m.text.includes(key)));
  const prompt = await exportPrompt();
  const input = context('', 'CONFIRM'); await handleTextMessage(input);
  assert.equal(input.messages.filter(m => m.text.includes(key)).length, 1);
  assert.ok(input.deleted.includes(56)); assert.ok(prompt.deleted.includes(55));
  await handleTextMessage(input); assert.equal(input.messages.filter(m => m.text.includes(key)).length, 1);
  await handleCallbackQuery(context('back_menu'));
  assert.ok(input.deleted.includes(input.messages.find(m => m.text.includes(key)).message_id));
});

test('message secret cleanup TTL actually deletes key message', async () => {
  const ctx = context(''); rt.scheduleMessageDeletion(ctx, [91, 92], 5);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.deepEqual(ctx.deleted, [91, 92]);
});

test('network toggle reviews before persistence, confirms through shared activation, agent must reconnect', async () => {
  const oldCreate = HLClient.create;
  HLClient.create = async (pk, network, opts) => ({ address: opts.accountAddress, network,
    async getUserBalances() { return { balances: [] }; }, async getOpenOrders() { return []; }, async getUserFills() { return []; } });
  try {
    const ctx = context('settings:network'); await handleCallbackQuery(ctx);
    assert.equal((await config.loadConfig()).hlNetwork, 'testnet');
    const token = button(ctx, 'confirm_network:'); assert.ok(token);
    await handleCallbackQuery(context(token));
    assert.equal((await config.loadConfig()).hlNetwork, 'mainnet'); assert.equal(rt.hlClient.network, 'mainnet');
    assert.ok(workers.getWorkersHealthSnapshot().workersStarted);
    await workers.stopWorkers();
    config.setSessionConfig({ ...(await config.loadConfig()), authMode: 'agent', encrypted: { privateKey: '' } });
    const agent = context('settings:network'); await handleCallbackQuery(agent);
    assert.equal(button(agent, 'confirm_network:'), undefined);
  } finally { HLClient.create = oldCreate; }
});

test('concurrent double confirm cannot duplicate financial operation or unlock running handler', async () => {
  let release; const waiting = new Promise(resolve => { release = resolve; }); let calls = 0;
  rt.setHLClient({ network: 'testnet', address: owner, async getAccountAbstraction() { return 'disabled'; }, async transferUsdClass() { calls++; await waiting; } });
  const token = rt.confirmationCallback(7, 'confirm_fund_predictions', { state: 'CONFIRMING_FUND_PREDICTIONS', amount: 1 });
  const first = handleCallbackQuery(context(token));
  while (!calls) await new Promise(resolve => setImmediate(resolve));
  await handleCallbackQuery(context(token)); await handleCallbackQuery(context('cancel_confirmation'));
  assert.equal(calls, 1); assert.equal(rt.busyLocks.get(7), true);
  release(); await first; assert.equal(rt.busyLocks.has(7), false);
});
