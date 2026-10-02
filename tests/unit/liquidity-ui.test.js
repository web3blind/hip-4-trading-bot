import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiquidityFeature } from '../../src/modules/bot/features/liquidity.js';
import { handleCallbackQuery } from '../../src/modules/bot/routing/callback-router.js';
import { handleTextMessage } from '../../src/modules/bot/routing/text-router.js';
import { mainMenuKeyboard } from '../../src/modules/bot/ui/keyboards.js';
import { setAllowedUserId, setHLClient, userStates, consumeConfirmation, invalidateUserState } from '../../src/modules/bot/runtime.js';
import { setSessionConfig } from '../../src/modules/config.js';
import { getTranslator } from '../../src/modules/i18n.js';
import { resetOutcomeCache } from '../../src/modules/bot/features/outcomes.js';
import { OUTCOMES_PAGE_SIZE } from '../../src/modules/bot/constants.js';
import { getLiquiditySession, shutdownLiquidity } from '../../src/modules/liquidity/coordinator.js';

const account = '0x' + 'a'.repeat(40), id = 'session_12345678';
const values = ['30', '20', '20', '10', '0.2', '0.8', '0.02', '5', '10'];
const meta = () => ({ outcomes: [{ outcome: 123, name: 'Canned tuna', description: '', sideSpecs: [{name:'Yes'}, {name:'No'}] }], questions: [] });
const client = () => ({ address: account, network: 'testnet', getOutcomeMeta: async () => meta(), getAllMids: async () => ({}) });
async function pick(feature, ctx, label) {
  const button = keyboard(ctx).find(b => b.text.toLowerCase().includes(label.toLowerCase()));
  assert(button, `Missing ${label}`);
  await feature.choose(ctx, button.callback_data);
}
function context(type = 'private', user = 123) {
  const messages = [];
  return { chat: { id: type === 'private' ? user : -100, type }, from: { id: user }, messages,
    editMessageText: async (text, extra) => messages.push({ text, extra }),
    reply: async (text, extra) => messages.push({ text, extra }),
    answerCallbackQuery: async () => {}, callbackQuery: { data: '' }, message: { text: '' } };
}
const keyboard = ctx => ctx.messages.findLast(m => m.extra?.reply_markup).extra.reply_markup.inline_keyboard.flat();
const buttons = ctx => keyboard(ctx).map(b => b.callback_data);
const policy = mode => ({ mode, coin: '#1230', account, network: 'testnet', durationMinutes: 30,
  budgetUsdc: 20, maxInventoryShares: 20, orderSizeShares: 10, minPrice: .2,
  maxPrice: .8, minSpread: .02, maxLossUsdc: 5, maxActions: 10 });

test('expired session with unresolved owned order still offers Stop',async()=>{
 setAllowedUserId(123);setSessionConfig({language:'en',hlNetwork:'testnet'});
 const ctx=context(),s={id,policy:policy('live'),status:'expired',orders:[{state:'open'}]};
 const feature=createLiquidityFeature({service:async()=>({getLiquiditySession:async()=>s})});
 await feature.session(ctx,id);assert(buttons(ctx).includes(`liq:stop:${id}`));
});

// The service double never places orders: this verifies UI authorization rather
// than pretending to test the exchange engine.
test('wizard gathers all bounded fields, exposes one-use private review, and shows stop uncertainty', async () => {
  setAllowedUserId(123); setHLClient(client());
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
    assert.equal(userStates.get(123).policy.coin, undefined);
    await pick(feature, ctx, 'Canned tuna');
    await pick(feature, ctx, 'Yes');
    const back = buttons(ctx).find(b => b.startsWith('liq:back:'));
    await feature.stepBack(ctx, 'stale'); assert.equal(userStates.get(123).index, 0);
    await feature.stepBack(ctx, back.slice(9)); assert.equal(userStates.get(123).state, 'LIQUIDITY_CATALOG');
    await pick(feature, ctx, 'Canned tuna'); await pick(feature, ctx, 'Yes');
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
  setAllowedUserId(123); setHLClient(client());
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
  setAllowedUserId(123); setHLClient(client());
  setSessionConfig({ language: 'en', hlNetwork: 'testnet' });
  const owner = context(), group = context('supergroup');
  const route = async (ctx, data) => { ctx.callbackQuery.data = data; await handleCallbackQuery(ctx); };
  try {
    const t = await getTranslator('en');
    assert(mainMenuKeyboard(t).inline_keyboard.flat().some(b => b.callback_data === 'liq:menu'));
    await route(group, 'liq:new:live'); assert.equal(group.messages.length, 0);
    await route(owner, 'liq:menu'); assert.match(owner.messages.at(-1).text, /Liquidity/);
    await route(owner, 'liq:new:live'); assert.equal(userStates.get(123).state, 'LIQUIDITY_CATALOG');
    owner.message.text = '#1230'; await handleTextMessage(owner);
    assert.equal(userStates.get(123).policy.coin, undefined);
    const choose = async label => { const b = keyboard(owner).find(b => b.text.toLowerCase().includes(label.toLowerCase())); await route(owner, b.callback_data); };
    await choose('Canned tuna'); await choose('Yes');
    assert.equal(userStates.get(123).index, 0);
    const back = buttons(owner).find(b => b.startsWith('liq:back:'));
    await route(owner, back); assert.equal(userStates.get(123).state, 'LIQUIDITY_CATALOG');
    await route(owner, 'back_menu'); assert.equal(userStates.has(123), false);
    await route(owner, back); assert.equal(userStates.has(123), false);
  } finally { await invalidateUserState(123); setHLClient(null); }
});

const route = async (ctx, data) => { ctx.callbackQuery.data = data; await handleCallbackQuery(ctx); };
const click = async (ctx, label) => {
  const b = keyboard(ctx).find(b => b.text === label);
  assert(b, `Missing button ${label}: ${keyboard(ctx).map(b => b.text)}`);
  assert(Buffer.byteLength(b.callback_data) <= 64);
  await route(ctx, b.callback_data);
};
function catalogFixture() {
  const count = OUTCOMES_PAGE_SIZE + 2;
  const outcomes = Array.from({length: count}, (_, i) => ({outcome: 200 + i, name: `Runner ${i}`, description: ''}));
  outcomes.push({outcome: 999, name: 'Settled'}, {outcome: 998, name: 'Expired', description:'expiry:20000101-0000'});
  for (let i = 0; i < count; i++) outcomes.push({outcome: 300 + i, name: `Single ${i}`});
  outcomes.push({outcome: 400, name:'index:0',description:'index:0'}, {outcome:401,name:'index:1',description:'index:1'});
  return {outcomes, questions:[
    {question: 20, name: 'Championship', namedOutcomes: [...Array.from({length:count},(_,i)=>200+i),999,998], settledNamedOutcomes:[999]},
    {question: 21, name: 'BTC range', description:'class:priceBucket|underlying:BTC|priceThresholds:50000', namedOutcomes:[400,401]},
  ]};
}
for (const language of ['en', 'ru']) test(`connected catalog grouping, pagination, both sides and readable full review (${language})`, async () => {
  setAllowedUserId(123); setSessionConfig({language,hlNetwork:'testnet'}); resetOutcomeCache();
  const c = {...client(), getOutcomeMeta: async () => catalogFixture(),
    placeMakerOrders: async () => assert.fail('No orders'), cancelOrder: async () => assert.fail('No cancels')};
  setHLClient(c);
  const ctx = context(), t = await getTranslator(language);
  try {
    await route(ctx, 'liq:new:observe');
    const abandoned = buttons(ctx)[0];
    assert.match(ctx.messages.at(-1).text, new RegExp(t('liq_select_event')));
    await click(ctx, 'Championship');
    assert(!keyboard(ctx).some(b => /Settled|Expired/.test(b.text)));
    assert.equal(keyboard(ctx).filter(b => /^Runner/.test(b.text)).length, OUTCOMES_PAGE_SIZE);
    await click(ctx, t('liq_next'));
    assert(keyboard(ctx).some(b => b.text === `Runner ${OUTCOMES_PAGE_SIZE}`));
    await click(ctx, `Runner ${OUTCOMES_PAGE_SIZE}`);
    assert.equal(keyboard(ctx).filter(b => [t('yes'),t('no')].includes(b.text)).length,2);
    await click(ctx, t('back'));
    assert(keyboard(ctx).some(b => b.text === `Runner ${OUTCOMES_PAGE_SIZE}`));
    await click(ctx, t('liq_previous')); await click(ctx, 'Runner 0');
    const oldSide = buttons(ctx)[0];
    await click(ctx, t('yes')); assert.equal(userStates.get(123).policy.coin,'#2000');
    const state = userStates.get(123);
    await route(ctx, oldSide); assert.equal(userStates.get(123), state);
    await route(ctx, buttons(ctx).find(b => b.startsWith('liq:back:')) || `liq:back:${state.token}`);
    assert.equal(userStates.get(123).state, 'LIQUIDITY_CATALOG');
    await click(ctx, 'BTC range');
    assert(keyboard(ctx).some(b => /50,000/.test(b.text)));
    await click(ctx, t('back'));
    await click(ctx, t('liq_next'));
    const single = keyboard(ctx).find(b => /^Single/.test(b.text)); assert(single);
    await route(ctx, single.callback_data); await click(ctx, t('no'));
    assert.match(userStates.get(123).policy.coin, /^#\d+1$/);
    const selected = userStates.get(123).policy.coin;
    for (const value of values) { ctx.message.text = value; await handleTextMessage(ctx); }
    const reviewState = userStates.get(123);
    assert.equal(reviewState.state,'CONFIRMING_LIQUIDITY_SESSION');
    assert.match(ctx.messages.at(-1).text, /Single/);
    assert(ctx.messages.at(-1).text.includes(t('no')));
    assert(ctx.messages.at(-1).text.includes(selected));
    const draft = await getLiquiditySession(reviewState.sessionId);
    assert.equal(draft.status,'draft'); assert.equal(draft.policy.coin,selected);
    assert.deepEqual(Object.keys(draft.policy).sort(),Object.keys(policy('observe')).sort());
    const confirmation = buttons(ctx).find(b=>b.startsWith('confirm_liquidity_session:'));
    await route(ctx, abandoned); assert.equal(userStates.get(123),reviewState);
    await route(ctx, 'liq:cancel'); await route(ctx, confirmation);
    assert.equal((await getLiquiditySession(reviewState.sessionId)).status,'draft');
    assert.equal(userStates.has(123),false);
  } finally { await shutdownLiquidity(c); await invalidateUserState(123); setHLClient(null); resetOutcomeCache(); }
});

test('catalog callbacks reject foreign users, groups, tampering, cancelled, changed account/network and expired wizard',async()=>{
  setAllowedUserId(123);setSessionConfig({language:'en',hlNetwork:'testnet'});setHLClient(client());resetOutcomeCache();
  let at = 1000; const f=createLiquidityFeature({now:()=>at}),ctx=context();
  try {
    await f.start(ctx,'live'); const original=userStates.get(123), cb=buttons(ctx)[0];
    await f.choose(context('private',456),cb); await f.choose(context('supergroup'),cb);
    await f.choose(ctx,cb+'x'); assert.equal(userStates.get(123),original);assert.equal(original.policy.coin,undefined);
    await f.cancel(ctx); await f.choose(ctx,cb);assert.equal(userStates.has(123),false);
    await f.start(ctx,'live');const fresh=buttons(ctx)[0];
    setHLClient({...client(),address:'0x'+'b'.repeat(40)}); await f.choose(ctx,fresh);assert.equal(userStates.get(123).policy.coin,undefined);
    setHLClient({...client(),network:'mainnet'}); await f.choose(ctx,fresh);assert.equal(userStates.get(123).policy.coin,undefined);
    setHLClient(client()); await f.start(ctx,'live'); const exp=buttons(ctx)[0];at+=15*60_000;
    await f.choose(ctx,exp);assert.equal(userStates.get(123).policy.coin,undefined);
  }finally{await invalidateUserState(123);setHLClient(null);resetOutcomeCache();}
});

test('empty/error catalog, root Back and custom sides on outcome zero are safe', async () => {
  setAllowedUserId(123); setSessionConfig({language:'en',hlNetwork:'testnet'}); resetOutcomeCache();
  const c=client(),ctx=context(),f=createLiquidityFeature({service:async()=>({listLiquiditySessions:async()=>[]})}); setHLClient(c);
  try {
    c.getOutcomeMeta=async()=>({outcomes:[],questions:[]});
    await f.start(ctx,'live');assert.match(ctx.messages.at(-1).text,/No active/i);
    assert.equal(keyboard(ctx).length,2);
    await pick(f,ctx,'Back');assert.equal(userStates.has(123),false);assert(buttons(ctx).includes('liq:new:live'));
    resetOutcomeCache();c.getOutcomeMeta=async()=>{throw Error('offline');};await f.start(ctx,'live');
    assert.equal(userStates.has(123),false);assert.match(ctx.messages.at(-1).text,/unavailable/i);
    resetOutcomeCache();c.getOutcomeMeta=async()=>({outcomes:[{outcome:0,name:'Election',sideSpecs:[{name:'Alice'},{name:'Bob'}]}],questions:[]});
    await f.start(ctx,'live');await pick(f,ctx,'Election');await pick(f,ctx,'Bob');
    assert.equal(userStates.get(123).policy.coin,'#1');
  } finally {await invalidateUserState(123);setHLClient(null);resetOutcomeCache();}
});

const deferred = () => { let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}; };
for (const abandon of ['cancel', 'menu']) test(`existing draft review cannot resurrect after ${abandon} during catalog refresh`, async () => {
  setAllowedUserId(123); setSessionConfig({language:'en',hlNetwork:'testnet'}); resetOutcomeCache();
  const entered=deferred(), pending=deferred(), c={...client(),getOutcomeMeta:async()=>{entered.resolve();return pending.promise;}};
  setHLClient(c); const ctx=context();
  const f=createLiquidityFeature({service:async()=>({getLiquiditySession:async()=>({id,policy:policy('live'),status:'draft'})})});
  try {
    await invalidateUserState(123);
    const review=f.showReview(ctx,id); await entered.promise;
    if(abandon==='cancel') await f.cancel(ctx); else await route(ctx,'back_menu');
    const count=ctx.messages.length;
    pending.resolve(meta()); await review;
    assert.equal(userStates.has(123),false);
    assert.equal(ctx.messages.length,count);
    assert(!buttons(ctx).some(b=>b.startsWith('confirm_liquidity_session:')));
  } finally {await invalidateUserState(123);setHLClient(null);resetOutcomeCache();}
});
test('async catalog load cannot resurrect a cancelled wizard or overwrite a newer start',async()=>{
  setAllowedUserId(123);setSessionConfig({language:'en',hlNetwork:'testnet'});resetOutcomeCache();
  const d=deferred(), entered=deferred(),c={...client(),getOutcomeMeta:async()=>{entered.resolve();return d.promise;}};
  setHLClient(c);const ctx=context(),f=createLiquidityFeature();
  try{
    const pending=f.start(ctx,'live'); await entered.promise;
    await f.cancel(ctx); const count=ctx.messages.length;d.resolve(meta());await pending;
    assert.equal(ctx.messages.length,count);assert.equal(userStates.has(123),false);
    resetOutcomeCache();const d2=deferred(),e2=deferred();c.getOutcomeMeta=async()=>{e2.resolve();return d2.promise;};
    const old=f.start(ctx,'live');await e2.promise;const newer=f.start(ctx,'observe');
    // Coalesced catalog fetch serves the newer wizard only.
    await new Promise(r=>setImmediate(r)); d2.resolve(meta());await Promise.all([old,newer]);
    assert.equal(userStates.get(123).policy.mode,'observe');
    assert.equal(ctx.messages.filter(m=>m.text.includes('Choose an event')).length,1);
  }finally{await invalidateUserState(123);setHLClient(null);resetOutcomeCache();}
});

test('refresh races: cancelled side, replaced account and disappeared outcome cannot select or propose',async()=>{
  setAllowedUserId(123);setSessionConfig({language:'en',hlNetwork:'testnet'});resetOutcomeCache();
  const c=client(),ctx=context();setHLClient(c);const f=createLiquidityFeature();
  try{
    await f.start(ctx,'observe');await pick(f,ctx,'Canned tuna');const cb=buttons(ctx)[0];
    resetOutcomeCache();const d=deferred(),entered=deferred();c.getOutcomeMeta=async()=>{entered.resolve();return d.promise;};
    const pending=f.choose(ctx,cb);await entered.promise;await f.cancel(ctx);d.resolve(meta());await pending;
    assert.equal(userStates.has(123),false);
    c.getOutcomeMeta=async()=>meta();resetOutcomeCache();await f.start(ctx,'observe');await pick(f,ctx,'Canned tuna');
    const changedSide=buttons(ctx)[0], d2=deferred(),e2=deferred();resetOutcomeCache();
    c.getOutcomeMeta=async()=>{e2.resolve();return d2.promise;};
    const changed=f.choose(ctx,changedSide);await e2.promise;setHLClient({...client(),address:'0x'+'b'.repeat(40)});
    d2.resolve(meta());await changed;assert.equal(userStates.get(123).policy.coin,undefined);
    setHLClient(c);
    c.getOutcomeMeta=async()=>meta();resetOutcomeCache();await f.start(ctx,'observe');await pick(f,ctx,'Canned tuna');const side=buttons(ctx)[0];
    c.getOutcomeMeta=async()=>({outcomes:[],questions:[]});resetOutcomeCache();await f.choose(ctx,side);
    assert.equal(userStates.get(123).policy.coin,undefined);
  }finally{await invalidateUserState(123);setHLClient(null);resetOutcomeCache();}
});

test('cancel during proposal cannot create a new confirmation; invalid numbers and bounds retain coin',async()=>{
 setAllowedUserId(123);setSessionConfig({language:'en',hlNetwork:'testnet'});setHLClient(client());resetOutcomeCache();
 const d=deferred(),entered=deferred(),ctx=context();let proposals=0;
 const f=createLiquidityFeature({service:async()=>({proposeLiquiditySession:async()=>{proposals++;entered.resolve();return d.promise;},getLiquiditySession:async()=>assert.fail('Abandoned review')})});
 try{
  await f.start(ctx,'live');await pick(f,ctx,'Canned tuna');await pick(f,ctx,'Yes');
  for(const value of ['#1230','0','1e2','2abc','1.123456']) await f.input(ctx,userStates.get(123),value);
  assert.equal(userStates.get(123).index,0);assert.equal(userStates.get(123).policy.coin,'#1230');
  const inconsistent=[...values];inconsistent[4]='0.9';
  for(const v of inconsistent)await f.input(ctx,userStates.get(123),v);
  assert.equal(proposals,0);assert.equal(userStates.get(123).index,0);assert.equal(userStates.get(123).policy.coin,'#1230');
  for(const v of values.slice(0,-1))await f.input(ctx,userStates.get(123),v);
  const pending=f.input(ctx,userStates.get(123),values.at(-1));await entered.promise;
  await f.cancel(ctx);d.resolve({id});await pending;assert.equal(proposals,1);assert.equal(userStates.has(123),false);
 }finally{await invalidateUserState(123);setHLClient(null);resetOutcomeCache();}
});
