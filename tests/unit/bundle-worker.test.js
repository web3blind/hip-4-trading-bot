import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {initDatabase,closeDatabase,createCompleteSetAttempt,updateCompleteSetAttempt,getBundleSnapshot} from '../../src/modules/database.js';
import {startWorkers,stopWorkers} from '../../src/modules/workers.js';
import {setSessionConfig} from '../../src/modules/config.js';

test('connected worker persists aggregate alert and deduplicates retry',async()=>{
 const address='0x'+'8'.repeat(40),coins=['#710','#720'];
 initDatabase({accountAddress:address,network:'testnet'});
 setSessionConfig({language:'en',walletAddress:address,hlNetwork:'testnet',notifications:{priceChangePercent:10}});
 const id=randomUUID(),legs=coins.map((coin,i)=>({coin,size:30,filledSize:30,oid:String(i+41),price:.2,cloid:'0x'+String(i+1).repeat(32)}));
 createCompleteSetAttempt({id,questionId:71,budget:30,shares:30,coins,account:address,network:'testnet',ruleDigest:'a'.repeat(64),feeDigest:'b'.repeat(64),legs});
 updateCompleteSetAttempt(id,'filled',legs);
 const time=Date.now(),fills=coins.map((coin,i)=>({coin,oid:String(i+41),side:'B',tid:i+1,time,sz:'30',px:'.2',fee:0,feeToken:'USDC',startPosition:'0'}));
 const client={address,network:'testnet',getUserFillsByTime:async(start,end)=>fills.filter(f=>f.time>=start&&f.time<=end),getUserFills:async()=>fills,
   getUserBalances:async()=>({balances:coins.map(coin=>({coin,total:'30',hold:'0'}))}),getAllMids:async()=>({'#710':'.5','#720':'.5'}),getOpenOrders:async()=>[],getOrderStatus:async()=>({status:'unknownOid'})};
 const sent=[],bot={api:{sendMessage:async(_id,text)=>sent.push(text)}};
 const prior=process.env.TELEGRAM_ALLOWED_USER_ID;process.env.TELEGRAM_ALLOWED_USER_ID='712';
 try {
  startWorkers({hlClient:client,bot,chatId:'712'});
  await stopWorkers();
  startWorkers({hlClient:client,bot,chatId:'712'});
  await stopWorkers();
  assert.equal(sent.filter(text=>text.startsWith('Bundles #71')).length,1);
  assert(getBundleSnapshot(id)?.alert_at>0);
 } finally {await stopWorkers();closeDatabase();if(prior===undefined) delete process.env.TELEGRAM_ALLOWED_USER_ID;else process.env.TELEGRAM_ALLOWED_USER_ID=prior;}
});
