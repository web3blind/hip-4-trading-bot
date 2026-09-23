import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'hip4-filter-'));
process.env.HIP4_DATA_DIR = dir;
process.env.LOG_TO_FILE = 'false';
const { saveConfig } = await import('../../src/modules/config.js');
const catalog = await import('../../src/modules/bot/features/outcomes.js');
const { handleCallbackQuery } = await import('../../src/modules/bot/routing/callback-router.js');
const runtime = await import('../../src/modules/bot/runtime.js');
const owner = '0x1111111111111111111111111111111111111111';

const item = (id, name, venue) => ({ outcome: id, name, description: 'time:20990101-0000', venue, quoteToken: 'USDC', sideSpecs: [{ name: 'Yes' }, { name: 'No' }] });
const metadata = {
  deployers: [
    { venue: 'out', deployer: '0x2222222222222222222222222222222222222222' },
    { venue: 'skew', deployer: '0x3333333333333333333333333333333333333333' },
  ],
  outcomes: [
    item(1, 'template:sportsContestWinner', 'out'),
    item(2, 'template:sportsContestDraw2', 'out'),
    item(3, 'template:binaryPrice', 'skew'),
    item(4, 'template:policyRateIncrease', 'out'),
    item(5, 'Other format', null),
    item(6, 'template:sportsContestWinner', 'skew'),
    item(7, 'template:sportsContestParticipant2', 'out'),
    item(8, 'template:sportsContestParticipant2', 'out'),
    item(9, 'template:sportsContestParticipant2', 'out'),
    item(11, 'template:sportsContestParticipant2', 'out'),
  ],
  questions: [{ question: 10, name: 'template:sportsContestResult', description: 'time:20990101-0000', namedOutcomes: [1, 6], settledNamedOutcomes: [] }],
};
function client() {
  return { network: 'mainnet', calls: 0, async getOutcomeMeta() { this.calls++; return metadata; }, async getAllMids() { return {}; } };
}
function context(data) {
  const messages = [];
  return { chat: { id: 7, type: 'private' }, from: { id: 7 }, callbackQuery: { data }, messages,
    async answerCallbackQuery() {}, async editMessageText(text, extra) { messages.push({ text, extra }); }, async reply(text, extra) { messages.push({ text, extra }); } };
}
const buttons = ctx => ctx.messages.at(-1).extra.reply_markup.inline_keyboard.flat();
const cb = ctx => buttons(ctx).map(b => b.callback_data);
test.before(async () => { await saveConfig({ language: 'ru' }); runtime.setAllowedUserId(7); });
test.after(async () => { catalog.resetOutcomeCache(); runtime.setHLClient(null); await rm(dir, { recursive: true, force: true }); });

test('categories are explicitly inferred, not treated as exchange-supplied tags; venue maps to a deployer', async () => {
  catalog.resetOutcomeCache(); const c = client(); const events = await catalog.fetchAndCacheOutcomes(c);
  assert.equal(events.find(e => e.questionId === 10).category, 'sports');
  assert.equal(events.find(e => e.outcomeId === 3).category, 'prices');
  assert.equal(events.find(e => e.outcomeId === 4).category, 'economy');
  assert.equal(events.find(e => e.outcomeId === 5).category, 'other');
  assert.equal(events.find(e => e.outcomeId === 3).venue, 'skew');
});

test('Filters opens first; category then markets; venue refines and pagination retains both filters', async () => {
  catalog.resetOutcomeCache(); const c = client(); runtime.setHLClient(c);
  const filters = context('outcomes:filters:all:all'); await handleCallbackQuery(filters);
  assert.match(filters.messages.at(-1).text, /Категори/);
  assert.ok(cb(filters).includes('outcomes:page:1:sports:all'));
  assert.ok(cb(filters).includes('outcomes:page:1:all:out'));
  const sports = context('outcomes:page:1:sports:all'); await handleCallbackQuery(sports);
  assert.match(sports.messages.at(-1).text, /sports|Sport/i);
  assert.equal(cb(sports)[0], 'outcomes:filters:sports:all');
  assert.ok(cb(sports).includes('event:10:1:sports:all'));
  assert.ok(cb(sports).includes('outcomes:page:2:sports:all'));
  const refined = context('outcomes:filters:sports:all'); await handleCallbackQuery(refined);
  assert.ok(cb(refined).includes('outcomes:page:1:sports:out'));
  const list = context('outcomes:page:1:sports:out'); await handleCallbackQuery(list);
  assert.ok(cb(list).includes('event:10:1:sports:out'));
  assert.ok(!cb(list).includes('outcome:6:sports:out'));
  const event = context('event:10:1:sports:out'); await handleCallbackQuery(event);
  assert.ok(cb(event).includes('outcome:1:sports:out'));
  assert.ok(!cb(event).includes('outcome:6:sports:out'));
  assert.ok(cb(event).includes('outcomes:page:1:sports:out'));
  assert.equal(c.calls, 1);
});

test('real Grammy /markets command begins with category filters', async () => {
  const { initBot } = await import('../../src/modules/bot/bot.js');
  catalog.resetOutcomeCache();
  runtime.rateLimits.clear();
  runtime.setHLClient(client());
  const bot = await initBot('123456:synthetic-test-token', 7);
  bot.botInfo = { id: 123456, is_bot: true, first_name: 'Test', username: 'test_bot' };
  const sent = [];
  bot.api.config.use(async (prev, method, payload) => {
    sent.push({ method, ...payload });
    return { ok: true, result: { message_id: 10, chat: { id: 7, type: 'private' }, date: 1, text: payload.text } };
  });
  const message = { message_id: 1, date: 1, chat: { id: 7, type: 'private' }, from: { id: 7, is_bot: false, first_name: 'User' }, text: '/markets', entities: [{ offset: 0, length: 8, type: 'bot_command' }] };
  await bot.handleUpdate({ update_id: 10, message });
  assert.ok(sent.some(m => m.text?.includes('Категория')), JSON.stringify(sent.map(m => [m.method, m.text])));
  assert.ok(sent.flatMap(m => m.reply_markup?.inline_keyboard?.flat() || []).some(b => b.callback_data === 'outcomes:page:1:sports:all'));
});

test('catalog metadata refreshes after five minutes, coalesces simultaneous requests and rejects invalid filters', async t => {
  catalog.resetOutcomeCache(); const c = client(); let now = 100_000; t.mock.method(Date, 'now', () => now);
  await Promise.all([catalog.fetchAndCacheOutcomes(c), catalog.fetchAndCacheOutcomes(c)]);
  assert.equal(c.calls, 1);
  now += 299_999; await catalog.fetchAndCacheOutcomes(c); assert.equal(c.calls, 1);
  now += 2; await catalog.fetchAndCacheOutcomes(c); assert.equal(c.calls, 2);
  runtime.setHLClient(c);
  const bad = context('outcomes:page:1:../../foo:evil'); await handleCallbackQuery(bad);
  assert.ok(cb(bad).every(x => x.length <= 64));
  assert.ok(cb(bad).includes('outcomes:filters:all:all'));
});
