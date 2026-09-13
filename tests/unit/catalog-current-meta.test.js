import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const temp = await mkdtemp(join(tmpdir(), 'hip4-catalog-'));
process.env.HIP4_DATA_DIR = temp;
process.env.LOG_TO_FILE = 'false';
const { fetchAndCacheOutcomes, resetOutcomeCache, getCachedOutcome, OUTCOME_CACHE_TTL_MS, showEventOutcomes } = await import('../../src/modules/bot/features/outcomes.js');
const { fetchOutcomeDetails } = await import('../../src/modules/bot/features/outcome-details.js');
const { formatOutcomeDetail, formatTemplateTitle } = await import('../../src/modules/bot/ui/formatters.js');
const { saveConfig } = await import('../../src/modules/config.js');
const entry = (id, extra = {}) => ({ outcome:id, name:'template:priceTouch', description:'perp:HYPE|priceDescription:HYPE-USDC perp mark |seconds:1|target:100|time:20991001-0000', quoteToken:'USDC', sideSpecs:[{name:'template:Above'},{name:'Below'}], ...extra });
const client = meta => ({ network:'testnet', calls:0, async getOutcomeMeta(){this.calls++;return meta;}, async getAllMids(){return {'#12090':'0.3','#12091':'0.7'};}, async getOrderbook(){return {levels:[[],[]]};} });
test.after(async()=>{ resetOutcomeCache(); await rm(temp,{recursive:true,force:true}); });
test('cold detail uses current outcomes, retains quote token/raw meaning/side names', async()=>{
 resetOutcomeCache(); const c=client({outcomes:[entry(1209)], questions:[]});
 const d=await fetchOutcomeDetails(c,1209);
 assert.equal(d.outcome.quoteToken,'USDC');assert.equal(d.outcome.side0Name,'Above');
 assert.equal(d.outcome.sides[0].token,'+12090'); assert.match(d.outcome.name,/HYPE touches 100/);
 const text=formatOutcomeDetail(d.outcome,d.orderbook,d.prices);
 assert.match(text,/Above:/);assert.match(text,/priceDescription:HYPE-USDC perp mark/);assert.match(text,/Quote: USDC/);
 assert.equal(await fetchOutcomeDetails(c,404),null);
});
test('TTL, reset, client/network separation, failed refresh never serves stale metadata', async(t)=>{
 resetOutcomeCache(); const a=client({outcomes:[entry(1)],questions:[]});
 let now=100000; t.mock.method(Date,'now',()=>now);
 await fetchAndCacheOutcomes(a);await fetchAndCacheOutcomes(a);assert.equal(a.calls,1);
 now=100000+OUTCOME_CACHE_TTL_MS+1;
 await fetchAndCacheOutcomes(a);assert.equal(a.calls,2);
 a.network='mainnet';await fetchAndCacheOutcomes(a);assert.equal(a.calls,3);
 const b=client({outcomes:[entry(2)],questions:[]});await fetchAndCacheOutcomes(b);
 assert.equal(getCachedOutcome(1),null);assert.ok(getCachedOutcome(2));
 resetOutcomeCache();assert.equal(getCachedOutcome(2),null);
 b.getOutcomeMeta=async()=>{throw Error('offline');};await assert.rejects(fetchAndCacheOutcomes(b));assert.equal(getCachedOutcome(2),null);
});
test('parent deadlines and settled children cannot reappear standalone or in details',async()=>{
 resetOutcomeCache();const c=client({outcomes:[entry(1),entry(2),entry(3),entry(4)],questions:[
 {question:1,name:'expired',description:'decisionDeadline:20000101-0000',namedOutcomes:[1],fallbackOutcome:2},
 {question:2,name:'active',description:'scheduledDecision:20000101-0000|decisionDeadline:20990101-0000',namedOutcomes:[3,4],settledNamedOutcomes:[3]}
 ]});
 const events=await fetchAndCacheOutcomes(c);assert.equal(events.length,1);assert.deepEqual(events[0].outcomes.map(o=>o.outcomeId),[4]);
 assert.equal(await fetchOutcomeDetails(c,1),null);assert.equal(await fetchOutcomeDetails(c,3),null);
});
test('event pagination uses existing event route and bounds message/keyboard',async()=>{
 resetOutcomeCache();await saveConfig({language:'en'});
 const c=client({outcomes:Array.from({length:25},(_,i)=>entry(i)),questions:[{question:7,name:'Many',namedOutcomes:Array.from({length:25},(_,i)=>i)}]});
 const sent=[]; const ctx={callbackQuery:{data:'event:7:2'},async editMessageText(text,options){sent.push({text,options});},async reply(text,options){sent.push({text,options});}};
 await showEventOutcomes(ctx,c,7);assert.equal(sent.length,1);assert.ok(sent[0].text.length<4096);
 const buttons=sent[0].options.reply_markup.inline_keyboard.flat();assert.ok(buttons.some(b=>b.callback_data==='event:7:3'));assert.ok(buttons.some(b=>b.callback_data==='event:7:1'));
 assert.ok(buttons.filter(b=>b.callback_data.startsWith('outcome:')).length<=5);
});
test('parent expiry applies during TTL and stale network refresh cannot publish', async(t)=>{
 resetOutcomeCache();
 const deadline=Date.parse('2099-01-01T00:00:00Z');
 let now=deadline-1000; t.mock.method(Date,'now',()=>now);
 const c=client({outcomes:[entry(9)],questions:[{question:1,name:'Soon',description:'decisionDeadline:20990101-0000',namedOutcomes:[9]}]});
 await fetchAndCacheOutcomes(c);assert.ok(getCachedOutcome(9));
 now=deadline;
 assert.equal(getCachedOutcome(9),null);assert.deepEqual(await fetchAndCacheOutcomes(c),[]);
 resetOutcomeCache();let release;
 const slow=client(null);slow.getOutcomeMeta=()=>new Promise(resolve=>{release=resolve;});
 const pending=fetchAndCacheOutcomes(slow);
 slow.network='mainnet';release({outcomes:[entry(8)],questions:[]});
 await assert.rejects(pending,/superseded/);assert.equal(getCachedOutcome(8),null);
});
test('binary threshold and other templates do not invent comparison semantics',()=>{
 assert.match(formatTemplateTitle('template:binaryPrice','perp:BTC|threshold:100000|time:20991001-0000'),/BTC — threshold 100000/);
 assert.match(formatTemplateTitle('template:policyRateDecision','institution:Fed|policyMeasure:upper bound'),/Policy rate decision.*Fed.*upper bound/);
});
