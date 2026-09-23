import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'hip4-position-pnl-'));
process.env.HIP4_DATA_DIR = dir;
process.env.LOG_TO_FILE = 'false';
const { saveConfig } = await import('../../src/modules/config.js');
const db = await import('../../src/modules/database.js');
const { createPositionsFeature } = await import('../../src/modules/bot/features/positions.js');
const address = '0x' + '11'.repeat(20);
const balance = (coin, total, entryNtl) => ({ coin, total, ...(entryNtl === undefined ? {} : { entryNtl }) });
const messages = [];
const context = () => ({ chat: { id: 7 }, async editMessageText(text, options) { messages.push({ text, options }); } });
test.before(async () => { db.initDatabase({ network: 'mainnet', accountAddress: address }); await saveConfig({ language: 'ru' }); });
test.after(async () => { db.closeDatabase(); await rm(dir, { recursive: true, force: true }); });

test('shows signed unrealized mid-price percentage for outcome balances without changing position actions', async () => {
  messages.length = 0;
  const rows = [balance('+100', '10', '4'), balance('#101', '10', '5'), balance('+200', '10', '5')];
  const hlClient = { address, async getUserBalances() { return { balances: rows }; }, async getAllMids() { return { '#100': '0.6', '#101': '0.2', '#200': '0.5' }; } };
  await createPositionsFeature({ hlClient }).showPositions(context());
  const text = messages.at(-1).text;
  assert.match(text, /Нереализованный результат: \+50\.00%/);
  assert.match(text, /Нереализованный результат: -60\.00%/);
  assert.match(text, /Нереализованный результат: 0\.00%/);
  assert.match(text, /без комиссий/);
  assert.equal((text.match(/Нереализованный результат:/g) || []).length, 3);
  const buttons = messages.at(-1).options.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
  assert.ok(buttons.includes('pos:sell:%23100'));
  assert.ok(buttons.includes('positions:refresh'));
});

test('missing/zero/nonfinite basis or missing/invalid mids must not fabricate percentage', async () => {
  messages.length = 0;
  const rows = [balance('+100', '10'), balance('+101', '10', '0'), balance('+200', '10', 'NaN'), balance('+201', '10', '5'), balance('+300', '10', '5')];
  const hlClient = { address, async getUserBalances() { return { balances: rows }; }, async getAllMids() { return { '#100': '0.6', '#101': '0.4', '#200': '0.2', '#201': 'Infinity', '#300': '-0.1' }; } };
  await createPositionsFeature({ hlClient }).showPositions(context());
  const text = messages.at(-1).text;
  assert.equal((text.match(/Нереализованный результат: Н\/Д/g) || []).length, rows.length);
  assert.doesNotMatch(text, /NaN|Infinity|\$NaN|\$Infinity/);
  assert.doesNotMatch(text, /результат: (?:0\.00%|\+0\.00%)/);
});

test('English copy and unavailable mid on read-only API failure', async () => {
  messages.length = 0;
  await saveConfig({ language: 'en' });
  const hlClient = { address, async getUserBalances() { return { balances: [balance('+100', '10', '4')] }; }, async getAllMids() { throw new Error('offline'); } };
  await createPositionsFeature({ hlClient }).showPositions(context());
  assert.match(messages.at(-1).text, /Unrealized return: N\/A/);
  assert.match(messages.at(-1).text, /Mid-price estimate/);
});
