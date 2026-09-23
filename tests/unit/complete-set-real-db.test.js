import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {meta,templates,fees,account,fixedNow} from '../fixtures/complete-set.js';
const root=mkdtempSync(join(tmpdir(),'hip4-set-integration-'));
process.env.HIP4_DATA_DIR=root;
const db=await import('../../src/modules/database.js');
const runtime=await import('../../src/modules/bot/runtime.js');
const {setSessionConfig}=await import('../../src/modules/config.js');
const {createCompleteSetFeature}=await import('../../src/modules/bot/features/complete-set.js');
test('confirmed route writes actual scoped SQLite attempt with fee digest and cloids before mocked exchange call',async()=>{
 db.initDatabase({network:'mainnet',accountAddress:account});
 setSessionConfig({language:'en',hlNetwork:'mainnet',notifications:{}});
 let writes=0;
 const client={network:'mainnet',address:account,getOutcomeMeta:async()=>meta,getOutcomeTemplates:async()=>templates,getUserFees:async()=>fees,
  getOrderbook:async coin=>({levels:[[],[{px:{'#44830':'.283','#44840':'.263','#44850':'.444'}[coin],sz:'500'}]]}),
  prepareOrder:async r=>({...r,maxSpend:r.price*r.size*1.01}),getAvailableUsdc:async()=>500,
  placeOrders:async orders=>{writes++;const rows=db.getCompleteSetAttempts(['submitting']);assert.equal(rows.length,1);
    assert.deepEqual(rows[0].legs.map(x=>x.cloid),orders.map(x=>x.cloid));
    return {status:'ok',response:{type:'order',data:{statuses:orders.map((o,i)=>({filled:{oid:100+i,totalSz:o.size,avgPx:o.price}}))}}};}};
 runtime.setHLClient(client);
 const feature=createCompleteSetFeature({client,now:()=>fixedNow});
 const messages=[],ctx={chat:{id:77},editMessageText:async(text,opts)=>messages.push({text,opts}),reply:async(text,opts)=>messages.push({text,opts})};
 try {
  await feature.open(ctx,'325');
  await feature.inputAmount(ctx,runtime.userStates.get(77),'100');
  const callback=messages.at(-1).opts.reply_markup.inline_keyboard[0][0].callback_data;
  assert.equal(runtime.consumeConfirmation(77,callback),'confirm_set_buy');
  await feature.confirm(ctx);
  assert.equal(writes,1);
  const row=db.getCompleteSetAttempts(['filled'])[0];
  assert.match(row.fee_digest,/^[0-9a-f]{64}$/);
  assert.equal(row.legs.length,3);
  db.closeDatabase();db.initDatabase({network:'mainnet',accountAddress:account});
  assert.equal(db.getCompleteSetAttempts(['filled'])[0].legs.length,3);
  for(let i=0;i<30;i++) {
    const id=randomUUID(),legs=[0,1].map(j=>({coin:`#${i*2+j+100}0`,cloid:`0x${String(i*2+j+100).padStart(32,'0')}`,size:40,price:.4}));
    db.createCompleteSetAttempt({id,questionId:400+i,budget:100,shares:40,coins:legs.map(x=>x.coin),legs,account,network:'mainnet',ruleDigest:'a'.repeat(64),feeDigest:'b'.repeat(64)});
    db.updateCompleteSetAttempt(id,'filled');db.markCompleteSetAttemptNotified(id,'filled');
  }
  const pending=randomUUID(),legs=[0,1].map(j=>({coin:`#${j+500}0`,cloid:`0x${String(j+500).padStart(32,'0')}`,size:40,price:.4}));
  db.createCompleteSetAttempt({id:pending,questionId:999,budget:100,shares:40,coins:legs.map(x=>x.coin),legs,account,network:'mainnet',ruleDigest:'a'.repeat(64),feeDigest:'b'.repeat(64)});
  db.updateCompleteSetAttempt(pending,'submitted_unknown');
  const queue=db.getCompleteSetAttempts(['submitted_unknown','filled'],{limit:30,unnotifiedFilled:true});
  assert.equal(queue[0].id,pending);assert.equal(queue.length,2);
 } finally {db.closeDatabase();runtime.userStates.delete(77);runtime.setHLClient(null);setSessionConfig(null);rmSync(root,{recursive:true,force:true});}
});
