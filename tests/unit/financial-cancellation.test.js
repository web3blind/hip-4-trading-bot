import test from 'node:test';
import assert from 'node:assert/strict';
import { HLClient } from '../../src/modules/hyperliquid.js';
import { handleCallbackQuery } from '../../src/modules/bot/routing/callback-router.js';
import { createWithdrawFeature } from '../../src/modules/bot/features/withdraw.js';
import { setHLClient, setAllowedUserId, userStates, busyLocks, confirmationLocks, invalidateUserState, CONFIRMATION_TTL_MS } from '../../src/modules/bot/runtime.js';
const key = '0x' + '0'.repeat(63) + '1';
async function setup() {
  await invalidateUserState(123); busyLocks.clear(); confirmationLocks.clear(); setAllowedUserId(123);
  const c = new HLClient(key, 'testnet'); setHLClient(c);
  const messages = []; const ctx = { chat: { id: 123, type: 'private' }, from: { id: 123 }, callbackQuery: {}, messages,
    editMessageText: async (text, extra) => messages.push({ text, extra }), reply: async (text, extra) => messages.push({ text, extra }), answerCallbackQuery: async text => { if (text) messages.push({ text }); } };
  const route = async data => { ctx.callbackQuery.data = data; await handleCallbackQuery(ctx); };
  let open = [{ coin: '#300', oid: 9 }, { coin: '#301', oid: 10 }]; const writes = [];
  c.getOpenOrders = async () => structuredClone(open);
  c._resolveSpotAssetIndex = async coin => 100000000 + Number(coin.slice(1));
  c._exchangeRequest = async ({ action }) => { writes.push(action); open = open.filter(o => !action.cancels.some(x => x.o === o.oid)); return { status: 'ok', response: { type: 'cancel', data: { statuses: action.cancels.map(() => 'success') } } }; };
  const token = () => messages.flatMap(m => m.extra?.reply_markup?.inline_keyboard?.flat() || []).filter(b => b.callback_data.startsWith('confirm_cancel_orders:')).at(-1)?.callback_data;
  return { c, ctx, route, token, writes, setOpen: value => { open = value; } };
}
test('router single cancellation reviews first, valid confirmation executes once, replay rejected', async () => {
  const s = await setup(); await s.route('order:cancel:9'); assert.equal(s.writes.length, 0); assert.ok(s.token());
  await s.route(s.token()); await s.route(s.token()); assert.equal(s.writes.length, 1);
  assert.deepEqual(s.writes[0].cancels.map(o => o.o), [9]); assert.ok(s.ctx.messages.some(m => /cancellation verified/.test(m.text)));
  assert.equal(userStates.has(123), false); assert.equal(busyLocks.size, 0);
});
test('router all cancellation freezes exact OIDs and excludes new orders', async () => {
  const s = await setup(); await s.route('orders:cancelall'); s.setOpen([{ coin: '#300', oid: 9 }, { coin: '#301', oid: 10 }, { coin: '#300', oid: 11 }]);
  await s.route(s.token()); assert.deepEqual(s.writes.flatMap(w => w.cancels.map(o => o.o)), [9, 10]); assert.deepEqual((await s.c.getOpenOrders()).map(o => o.oid), [11]);
});
for (const reason of ['network', 'account', 'expired', 'navigation', 'cancel', 'stale']) {
  test(`router rejects ${reason} cancellation`, async () => {
    const s = await setup(); await s.route('orders:cancelall'); const token = s.token(); const now = Date.now;
    try {
      if (reason === 'network') s.c.network = 'mainnet';
      if (reason === 'account') s.c.address = '0x' + '2'.repeat(40);
      if (reason === 'expired') Date.now = () => now() + CONFIRMATION_TTL_MS + 1;
      if (reason === 'navigation') await s.route('back_menu');
      if (reason === 'cancel') await s.route('cancel_confirmation');
      if (reason === 'stale') await s.route('order:cancel:9');
      await s.route(token); assert.equal(s.writes.length, 0);
    } finally { Date.now = now; }
  });
}
test('router preserves per-OID failures and failed readback, never fake all success', async () => {
  const s = await setup(); await s.route('orders:cancelall');
  let calls = 0; s.c._exchangeRequest = async ({ action }) => { s.writes.push(action); calls++; return { status: 'ok', response: { type: 'cancel', data: { statuses: calls === 1 ? [{ error: 'rejected' }] : ['success'] } } }; };
  // First rejected OID remains open; second request has unavailable readback.
  s.c.getOpenOrders = async () => { if (calls > 1) throw new Error('readback offline'); return [{ coin: '#300', oid: 9 }]; };
  await s.route(s.token()); const text = s.ctx.messages.at(-1).text;
  assert.match(text, /OID: 9 — cancellation rejected/); assert.match(text, /OID: 10 — cancellation not verified/); assert.doesNotMatch(text, /cancellation verified|all orders cancelled/i); assert.equal(s.writes.length, 2);
});
test('withdraw percentage router fails closed on refresh error despite old balance', async () => {
  const s = await setup(); userStates.set(123, { state: 'AWAITING_WITHDRAW_AMOUNT', totalBal: 100, spotBal: 100, perpBal: 0, destination: '0x' + '2'.repeat(40) });
  s.c.getSpotUsdcBalance = async () => { throw new Error('offline'); };
  await s.route('withdraw_pct:100'); assert.equal(userStates.has(123), false); assert.match(s.ctx.messages.at(-1).text, /Balance refresh failed/);
  await s.route('confirm_withdraw'); assert.equal(s.writes.length, 0);
});
test('withdraw typed amount and address refresh fail closed, no cached fallback', async () => {
  for (const stateName of ['AWAITING_WITHDRAW_AMOUNT', 'AWAITING_WITHDRAW_ADDRESS']) {
    const s = await setup(), f = createWithdrawFeature({});
    const state = { state: stateName, totalBal: 100, spotBal: 100, perpBal: 0, destination: '0x' + '2'.repeat(40) }; userStates.set(123, state);
    s.c.getAvailableUsdc = s.c.getSpotUsdcBalance = async () => { throw new Error('offline'); };
    if (stateName.endsWith('AMOUNT')) await f.handleWithdrawAmount(s.ctx, state, '10'); else await f.handleWithdrawAddress(s.ctx, state, state.destination);
    assert.equal(userStates.has(123), false); assert.match(s.ctx.messages.at(-1).text, /Balance refresh failed/);
  }
});
