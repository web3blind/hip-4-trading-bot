import test from 'node:test';
import assert from 'node:assert/strict';
import { HLClient, orderStatuses } from '../../src/modules/hyperliquid.js';
import { setHLClient, userStates, busyLocks, consumeConfirmation } from '../../src/modules/bot/runtime.js';
import { createSplitBuyFeature } from '../../src/modules/bot/features/split-buy.js';
import { createWithdrawFeature } from '../../src/modules/bot/features/withdraw.js';
import { createTradeMarketFeature } from '../../src/modules/bot/features/trade-market.js';
import { createTradeLimitFeature } from '../../src/modules/bot/features/trade-limit.js';
const key = '0x' + '0'.repeat(63) + '1';
const owner = '0x0000000000000000000000000000000000000002';
const response = (statuses, type = 'order') => ({ status: 'ok', response: { type, data: { statuses } } });
function client() {
  const c = new HLClient(key);
  c.getOutcomeMeta = async () => ({ outcomes: [{ outcome: 30, quoteToken: 'USDC', szDecimals: 0 }] });
  c._infoRequest = async ({ type }) => { if (type === 'userFees') return { userSpotCrossRate: '0.001' }; throw new Error('Unexpected info: ' + type); };
  return c;
}
function context() {
  const messages = [];
  const ctx = { chat: { id: 123, type: 'private' }, messages, reply: async (text, extra) => messages.push({ text, extra }), editMessageText: async (text, extra) => messages.push({ text, extra }), answerCallbackQuery: async () => {} };
  userStates.clear(); busyLocks.clear(); return ctx;
}
test('strict statuses reject malformed, missing, mismatched and ambiguous responses', () => {
  for (const r of [{}, response([]), response([{}]), response([{ filled: { oid: 1, totalSz: '0', avgPx: '.4' } }]), response([{ resting: { oid: 1 }, error: 'x' }])]) assert.throws(() => orderStatuses(r, 1));
  assert.equal(orderStatuses(response([{ error: 'rejected' }]), 1)[0].error, 'rejected');
});
test('review caps and owner/signer, quote and alias boundaries', async () => {
  const c = client();
  const r = await c.prepareOrder({ coin: '#300', isBuy: true, price: .42, budget: 30 });
  assert.ok(r.maxSpend <= 30); assert.equal(r.size, 70);
  await assert.rejects(c._buildOrderWire({ ...r, price: .8 }), /budget/);
  await assert.rejects(c._resolveSpotAssetIndex('@300'), /ordinary spot/);
  c.getOutcomeMeta = async () => ({ outcomes: [{ outcome: 30, quoteToken: 'USDH' }] });
  await assert.rejects(c.prepareOrder({ coin: '#300', isBuy: true, price: .4, size: 100 }), /quoteToken/);
  const agent = new HLClient(key, 'testnet', { authMode: 'agent', accountAddress: owner });
  assert.equal(agent.address.toLowerCase(), owner); assert.notEqual(agent.wallet.address.toLowerCase(), owner);
  await assert.rejects(agent.withdraw(owner, 10), /Owner action/);
  await assert.rejects(agent.transferUsdClass(10, true), /Owner action/);
});
test('standard funding uses spot for outcomes and perp for withdrawal with exact readback', async () => {
  const c = client(); let spot = 3, perp = 30; const transfers = [];
  c.getAccountAbstraction = async () => 'disabled';
  c.getSpotUsdcBalance = async () => spot; c.getPerpBalance = async () => perp;
  c.transferUsdClass = async (amount, toPerp) => { transfers.push({ amount, toPerp }); spot += toPerp ? -amount : amount; perp += toPerp ? amount : -amount; };
  assert.equal(await c.ensureOutcomeFunding(10, '#300'), true);
  assert.deepEqual(transfers[0], { amount: 7, toPerp: false });
  assert.equal(await c.ensureWithdrawalFunding(30), true);
  assert.deepEqual(transfers[1], { amount: 7, toPerp: true });
  c.getAccountAbstraction = async () => 'unifiedAccount';
  assert.equal(await c.getAvailableUsdc(), 3);
});
test('cancel requires statuses AND absence on exact open-order readback', async () => {
  const c = client(); c._exchangeRequest = async () => response(['success'], 'cancel');
  c.getOpenOrders = async () => [{ coin: '#300', oid: 9 }];
  await assert.rejects(c.cancelOrder('#300', 9), /not fully verified/);
  c.getOpenOrders = async () => [];
  assert.deepEqual((await c.cancelOrder('#300', 9)).verifiedCancelled, [9]);
  c._exchangeRequest = async () => response([], 'cancel');
  await assert.rejects(c.cancelOrder('#300', 9), /incomplete/);
});
test('real split review binds frozen orders and reports resting/partial truth without profit', async () => {
  const ctx = context(), c = client(); setHLClient(c);
  const f = createSplitBuyFeature({});
  const state = { state: 'AWAITING_SPLIT_AMOUNT', outcomeId: 30, outcomeName: 'Synthetic', usdcBalance: 100, arb: { totalCost: .9, askYes: .4, askNo: .5, maxPairs: 100, profitPct: 11 } };
  userStates.set(123, state);
  await f.handleSplitAmount(ctx, state, '50');
  assert.match(ctx.messages.at(-1).text, /not atomic/);
  assert.match(ctx.messages.at(-1).text, /Maximum total including fee reserve/);
  const reviewed = structuredClone(userStates.get(123));
  const callback = ctx.messages.at(-1).extra.reply_markup.inline_keyboard[0][0].callback_data;
  assert.equal(consumeConfirmation(123, callback), 'confirm_split_buy');
  assert.equal(consumeConfirmation(123, callback), null);
  c.getOrderbook = async () => { throw new Error('Must not reprice'); };
  let calls = 0;
  c.ensureOutcomeFunding = async amount => { assert.equal(amount, reviewed.totalCost); return true; };
  c.placeOrders = async orders => { calls++; assert.deepEqual(orders, reviewed.reviewed); return response([{ filled: { oid: 7, totalSz: '10', avgPx: '.39' } }, { resting: { oid: 8 } }]); };
  await Promise.all([f.executeSplitBuy(ctx), f.executeSplitBuy(ctx)]);
  assert.equal(calls, 1); assert.ok(ctx.messages.some(m => /partially/.test(m.text))); assert.ok(ctx.messages.some(m => /OID: 8/.test(m.text)));
  assert.doesNotMatch(ctx.messages.at(-1).text, /profit|guaranteed/i); assert.equal(userStates.has(123), false);
});
test('near-break-even split review separates fee reserve from consistent before-fee result', async () => {
  const ctx = context(), c = client(); setHLClient(c);
  const state = { state: 'AWAITING_SPLIT_AMOUNT', outcomeId: 30, outcomeName: 'Near break even', usdcBalance: 200,
    arb: { totalCost: .995, askYes: .495, askNo: .5, maxPairs: 100, profitPct: 99 } };
  userStates.set(123, state);
  await createSplitBuyFeature({}).handleSplitAmount(ctx, state, '110');
  assert.match(ctx.messages.at(-1).text, /before fees: \$0\.50 \(0\.50%\)/);
  assert.match(ctx.messages.at(-1).text, /including fee reserve/);
  assert.doesNotMatch(ctx.messages.at(-1).text, /99\.00%|\$-0/);
});
test('real market execution preserves review and reports actual partial notional', async () => {
  const ctx = context(), c = client(); setHLClient(c);
  const reviewed = await c.prepareOrder({ coin: '#300', isBuy: true, price: .4, budget: 50, orderType: 'Market' });
  userStates.set(123, { state: 'CONFIRMING_MARKET_BUY', reviewed, coin: '#300', amount: reviewed.size, usdcAmount: reviewed.maxSpend, sideLabel: 'YES' });
  c.ensureOutcomeFunding = async amount => { assert.equal(amount, reviewed.maxSpend); return true; };
  c.placeMarketOrder = async (coin, buy, size, slip, options) => { assert.deepEqual(options.reviewed, reviewed); return response([{ filled: { oid: 6, totalSz: '10', avgPx: '.39' } }]); };
  await createTradeMarketFeature({}).executeConfirmedMarketBuy(ctx);
  assert.match(ctx.messages.at(-1).text, /3\.900000/); assert.equal(userStates.has(123), false);
});
test('real limit execution passes only frozen reviewed wire', async () => {
  const ctx = context(), c = client(); setHLClient(c);
  const reviewed = await c.prepareOrder({ coin: '#300', isBuy: true, price: .4, budget: 50 });
  userStates.set(123, { state: 'CONFIRMING_LIMIT_ORDER', reviewed, coin: '#300', isBuy: true, sideLabel: 'YES', size: reviewed.size, limitPrice: reviewed.price, outcomeId: 30 });
  c.ensureOutcomeFunding = async amount => { assert.equal(amount, reviewed.maxSpend); return true; };
  c.placeOrders = async orders => { assert.deepEqual(orders, [reviewed]); return response([{ resting: { oid: 19 } }]); };
  await createTradeLimitFeature({}).executeConfirmedLimit(ctx);
  assert.match(ctx.messages.at(-1).text, /19/); assert.equal(busyLocks.has(123), false);
});
test('real withdrawal uses funding helper, accepts request not receipt, cannot replay or use agent', async () => {
  const ctx = context(), c = client(); setHLClient(c);
  const f = createWithdrawFeature({}); let writes = 0;
  c.ensureWithdrawalFunding = async amount => { assert.equal(amount, 10); return true; };
  c.withdraw = async (destination, amount) => { writes++; assert.equal(destination, owner); assert.equal(amount, 10); return { status: 'ok', response: { type: 'default' } }; };
  userStates.set(123, { state: 'CONFIRMING_WITHDRAW', destination: owner, amount: 10 });
  await Promise.all([f.executeWithdraw(ctx), f.executeWithdraw(ctx)]);
  assert.equal(writes, 1); assert.match(ctx.messages.at(-1).text, /not yet confirmed/);
  c.authMode = 'agent'; await f.handleWithdrawStart(ctx); assert.match(ctx.messages.at(-1).text, /main wallet/); assert.equal(writes, 1);
});
