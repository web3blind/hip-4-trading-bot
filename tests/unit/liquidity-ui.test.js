import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiquidityFeature } from '../../src/modules/bot/features/liquidity.js';
import { handleCallbackQuery } from '../../src/modules/bot/routing/callback-router.js';
import { handleTextMessage } from '../../src/modules/bot/routing/text-router.js';
import { mainMenuKeyboard } from '../../src/modules/bot/ui/keyboards.js';
import { setAllowedUserId, setHLClient, userStates, consumeConfirmation, invalidateUserState } from '../../src/modules/bot/runtime.js';
import { setSessionConfig } from '../../src/modules/config.js';
import { getTranslator } from '../../src/modules/i18n.js';

const account = '0x' + 'a'.repeat(40), id = 'session_12345678';
const values = ['#1230', '30', '20', '20', '10', '0.2', '0.8', '0.02', '5', '10'];
function context(type = 'private', user = 123) {
  const messages = [];
  return { chat: { id: type === 'private' ? user : -100, type }, from: { id: user }, messages,
    editMessageText: async (text, extra) => messages.push({ text, extra }),
    reply: async (text, extra) => messages.push({ text, extra }),
    answerCallbackQuery: async () => {}, callbackQuery: { data: '' }, message: { text: '' } };
}
const buttons = ctx => ctx.messages.at(-1).extra.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
const policy = mode => ({ mode, coin: '#1230', account, network: 'testnet', durationMinutes: 30,
  budgetUsdc: 20, maxInventoryShares: 20, orderSizeShares: 10, minPrice: .2,
  maxPrice: .8, minSpread: .02, maxLossUsdc: 5, maxActions: 10 });

// The service double never places orders: this verifies UI authorization rather
// than pretending to test the exchange engine.
test('wizard gathers all bounded fields, exposes one-use private review, and shows stop uncertainty', async () => {
  setAllowedUserId(123); setHLClient({ address: account, network: 'testnet' });
  setSessionConfig({ language: 'en', hlNetwork: 'testnet' });
  const ctx = context(), sessions = new Map(), proposals = [], approvals = [], stops = [];
  const api = {
    listLiquiditySessions: async () => [...sessions.values()],
    getLiquiditySession: async key => sessions.get(key),
    proposeLiquiditySession: async (p, options) => { proposals.push({ p, options }); const s = { id, policy: p, status: 'draft' }; sessions.set(id, s); return s; },
    approveLiquiditySession: async (key, opts) => { approvals.push({ key, opts }); sessions.get(key).status = 'active'; return sessions.get(key); },
    stopLiquiditySession: async (key, opts) => { stops.push({ key, opts }); sessions.get(key).status = 'recovery_required'; sessions.get(key).reason = 'exchange_unavailable'; return sessions.get(key); },
    getLiquidityCampaigns: async () => ({ available: false }),
  };
  const feature = createLiquidityFeature({ service: async () => api });
  try {
    await feature.menu(ctx); assert(buttons(ctx).includes('liq:new:observe')); assert(buttons(ctx).includes('liq:new:live'));
    await feature.start(ctx, 'observe');
    assert.equal(userStates.get(123).policy.mode, 'observe');
    await feature.input(ctx, userStates.get(123), '#123abc');
    assert.equal(userStates.get(123).index, 0);
    await feature.input(ctx, userStates.get(123), values[0]);
    const back = buttons(ctx).find(b => b.startsWith('liq:back:'));
    await feature.stepBack(ctx, 'stale'); assert.equal(userStates.get(123).index, 1);
    await feature.stepBack(ctx, back.slice(9)); assert.equal(userStates.get(123).index, 0);
    for (const v of values) await feature.input(ctx, userStates.get(123), v);
    assert.equal(proposals.length, 1); assert.deepEqual(proposals[0].p, policy('observe'));
    assert.equal(typeof proposals[0].options.requestId, 'string');
    assert.match(ctx.messages.at(-1).text, /Observation makes no exchange orders/);
    assert.match(ctx.messages.at(-1).text, /selling does not replenish/);
    assert.equal(approvals.length, 0);
    const confirmation = buttons(ctx).find(b => b.startsWith('confirm_liquidity_session:'));
    assert(confirmation.length <= 64);
    assert.equal(consumeConfirmation(123, confirmation), 'confirm_liquidity_session');
    await feature.confirm(ctx); assert.deepEqual(approvals, [{ key: id, opts: { ownerId: 123 } }]);
    await feature.confirm(ctx); assert.equal(approvals.length, 1);
    await feature.stop(ctx, id); assert.deepEqual(stops, [{ key: id, opts: { ownerId: 123 } }]);
    assert.match(ctx.messages.at(-1).text, /Cleanup unresolved/);
    assert.match(ctx.messages.at(-1).text, /remaining inventory is not sold/);
    await feature.campaigns(ctx); assert.match(ctx.messages.at(-1).text, /unavailable/);
  } finally { await invalidateUserState(123); setHLClient(null); }
});

test('historical payout screen displays source amounts without claiming current eligibility',async()=>{
 setAllowedUserId(123);setSessionConfig({language:'en',hlNetwork:'testnet'});
 const ctx=context();const feature=createLiquidityFeature({service:async()=>({getLiquidityCampaigns:async()=>({available:false,history:{available:true,fetchedAt:'2026-09-29T08:00:00Z',source:'https://example.test/history',periods:[{marketId:'O6231',epochEndDate:'2026-09-28',awardedUsdc:'484.374985',paidUsdc:'484.374985'}]}})})});
 await feature.campaigns(ctx);const text=ctx.messages.at(-1).text;
 assert.match(text,/484\.374985/);assert.match(text,/O6231/);assert.match(text,/not active pools or your earnings/);assert.match(text,/not the full history/);assert.match(text,/example.test\/history/);
});

test('stale review, changed binding, group and foreign-user context cannot approve', async () => {
  setAllowedUserId(123); setHLClient({ address: account, network: 'testnet' });
  setSessionConfig({ language: 'ru', hlNetwork: 'testnet' });
  const s = { id, policy: policy('live'), status: 'draft' }; let approvals = 0;
  const feature = createLiquidityFeature({ service: async () => ({ getLiquiditySession: async () => s,
    approveLiquiditySession: async () => { approvals++; } }) });
  const owner = context(), group = context('supergroup'), stranger = context('private', 456);
  try {
    await feature.showReview(group, id); await feature.showReview(stranger, id);
    assert.equal(group.messages.length + stranger.messages.length, 0);
    await feature.showReview(owner, id);
    assert.match(owner.messages.at(-1).text, /Мейкерские/);
    const old = buttons(owner).find(b => b.startsWith('confirm_liquidity_session:'));
    await invalidateUserState(123);
    assert.equal(consumeConfirmation(123, old), null);
    await feature.confirm(owner); assert.equal(approvals, 0);
    await feature.showReview(owner, id);
    setHLClient({ address: '0x' + 'b'.repeat(40), network: 'testnet' });
    await feature.confirm(owner); assert.equal(approvals, 0);
  } finally { await invalidateUserState(123); setHLClient(null); }
});

test('real callback and text routers enforce owner/group, preserve wizard and reject abandoned review', async () => {
  setAllowedUserId(123); setHLClient({ address: account, network: 'testnet' });
  setSessionConfig({ language: 'en', hlNetwork: 'testnet' });
  const owner = context(), group = context('supergroup');
  const route = async (ctx, data) => { ctx.callbackQuery.data = data; await handleCallbackQuery(ctx); };
  try {
    const t = await getTranslator('en');
    assert(mainMenuKeyboard(t).inline_keyboard.flat().some(b => b.callback_data === 'liq:menu'));
    await route(group, 'liq:new:live'); assert.equal(group.messages.length, 0);
    await route(owner, 'liq:menu'); assert.match(owner.messages.at(-1).text, /Liquidity/);
    await route(owner, 'liq:new:live'); assert.equal(userStates.get(123).state, 'LIQUIDITY_INPUT');
    owner.message.text = '#1230'; await handleTextMessage(owner);
    assert.equal(userStates.get(123).index, 1);
    const back = buttons(owner).find(b => b.startsWith('liq:back:'));
    await route(owner, back); assert.equal(userStates.get(123).index, 0);
    await route(owner, 'back_menu'); assert.equal(userStates.has(123), false);
    await route(owner, back); assert.equal(userStates.has(123), false);
  } finally { await invalidateUserState(123); setHLClient(null); }
});
