import test from 'node:test';
import assert from 'node:assert/strict';
import { saveConfig } from '../../src/modules/config.js';
import { setAllowedUserId, setHLClient, userStates } from '../../src/modules/bot/runtime.js';
import { handleCallbackQuery } from '../../src/modules/bot/routing/callback-router.js';

function context(data, type = 'private') {
  const messages = [];
  return { chat: { id: 7, type }, from: { id: 7 }, callbackQuery: { data }, messages,
    answerCallbackQuery: async () => {}, editMessageText: async (text, extra) => { messages.push({ text, extra }); },
    reply: async (text, extra) => { messages.push({ text, extra }); } };
}
for (const language of ['ru', 'en']) test(`API wallet guide is reachable from Wallet and Settings, ${language}`, async () => {
  setAllowedUserId(7); setHLClient(null);
  await saveConfig({ language, hlNetwork: 'testnet', walletAddress: '', encrypted: { privateKey: '' } });
  for (const page of ['wallet', 'settings']) {
    const ctx = context(page); await handleCallbackQuery(ctx);
    assert.ok(ctx.messages.at(-1).extra.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'wallet:connect_api'));
  }
  userStates.set(7, { state: 'AWAITING_EXPORT_CONFIRM' });
  const setup = context('wallet:connect_api'); await handleCallbackQuery(setup);
  const buttons = setup.messages.at(-1).extra.reply_markup.inline_keyboard.flat();
  assert.equal(buttons[0].text, language === 'ru' ? 'Кошелёк' : 'Wallet');
  assert.equal(buttons[1].text, language === 'ru' ? 'Приватник' : 'Private key');
  assert.equal(userStates.get(7).state, 'API_WALLET_MENU');
  const help = context('wallet:api_help'); await handleCallbackQuery(help);
  const text = help.messages.at(-1).text;
  assert.ok(text.length < 4096);
  for (const word of ['https://app.hyperliquid.xyz/API', 'Generate', 'Valid Until']) assert.ok(text.includes(word), word);
  assert.ok(text.includes(language === 'ru' ? 'Первая кнопка «Кошелёк»' : 'First button, Wallet'));
  assert.equal(text.includes('npm run connect'), false);
  assert.equal(help.messages.at(-1).extra.parse_mode, undefined);
  const denied = context('wallet:connect_api', 'group'); await handleCallbackQuery(denied); assert.equal(denied.messages.length, 0);
});
