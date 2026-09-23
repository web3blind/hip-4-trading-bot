import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'hip4-mcp-settings-'));
process.env.HIP4_DATA_DIR = dir;
process.env.LOG_TO_FILE = 'false';
const { saveConfig, loadConfig } = await import('../../src/modules/config.js');
const runtime = await import('../../src/modules/bot/runtime.js');
const { showMcpSettings, handleMcpKeyAction } = await import('../../src/modules/bot/features/mcp-settings.js');
const { listMcpKeys } = await import('../../src/modules/mcp/key-store.js');
runtime.setAllowedUserId(7);
const out = [], deleted = [];
const ctx = (id = 7, type = 'private') => ({ chat: { id, type }, from: { id }, api: { async deleteMessage(chatId, messageId) { deleted.push([chatId, messageId]); return true; } }, async editMessageText(text, extra) { out.push({ text, extra }); }, async reply(text) { out.push({ text }); return { message_id: out.length }; } });
test.before(async () => saveConfig({ language: 'ru' }));
test.after(async () => { await runtime.invalidateUserState(7); await rm(dir, { recursive: true, force: true }); });
const confirmation = () => out.at(-1).extra.reply_markup.inline_keyboard.flat().find(b => b.callback_data.startsWith('confirm_mcp_')).callback_data;

test('only owner private chat can issue hash-only read key; copy disappears from bot after deletion', async () => {
  await showMcpSettings(ctx(8));
  await handleMcpKeyAction(ctx(7, 'group'), 'mcp:key:issue:read');
  assert.equal(out.length, 0);
  await showMcpSettings(ctx());
  assert.match(out.at(-1).text, /Доступ MCP/);
  await handleMcpKeyAction(ctx(), 'mcp:key:issue:read');
  const callback = confirmation();
  assert.equal(runtime.consumeConfirmation(7, callback), 'confirm_mcp_issue_read');
  await handleMcpKeyAction(ctx(), 'confirm_mcp_issue_read');
  const message = out.at(-1).text;
  assert.match(message, /hip4mcp_[A-Za-z0-9_-]{43}/);
  assert.equal((await listMcpKeys())[0].scope, 'read');
  assert.ok(!JSON.stringify(await loadConfig()).includes(message.match(/hip4mcp_[A-Za-z0-9_-]{43}/)[0]));
  assert.equal(runtime.consumeConfirmation(7, callback), null);
  await runtime.invalidateUserState(7);
  assert.equal(deleted.length, 1);
});

test('trade key requires two confirmations and remains independent from read key', async () => {
  out.length = 0;
  await handleMcpKeyAction(ctx(), 'mcp:key:issue:trade');
  const first = confirmation();
  assert.equal(runtime.consumeConfirmation(7, first), 'confirm_mcp_issue_trade');
  await handleMcpKeyAction(ctx(), 'confirm_mcp_issue_trade');
  assert.equal((await listMcpKeys()).length, 1);
  const second = confirmation();
  assert.equal(runtime.consumeConfirmation(7, second), 'confirm_mcp_issue_trade_final');
  await handleMcpKeyAction(ctx(), 'confirm_mcp_issue_trade_final');
  assert.deepEqual((await listMcpKeys()).map(k => k.scope).sort(), ['read', 'trade']);
});
