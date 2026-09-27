import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {initDatabase,closeDatabase,createCompleteSetAttempt,updateCompleteSetAttempt,putBundleSnapshot,getBundleSnapshot,markBundleFinalNotified,upsertOutcome} from '../../src/modules/database.js';
import {loadBundlePortfolio,monitorBundlePortfolio} from '../../src/modules/bundle-portfolio.js';
import {bundleEventLabel,localizeBundleLabel} from '../../src/modules/bundle-label.js';
import {notifyBundlePortfolio} from '../../src/modules/bot/notifications.js';
import {setSessionConfig} from '../../src/modules/config.js';

const coins=['#44830','#44840','#44850'];
const account='0x'+'a'.repeat(40);
const cached=[
  {question:'Contest participant — participant: Czechia',description:'participant:Czechia'},
  {question:'Contest draw',description:''},
  {question:'Contest participant — participant: Croatia',description:'participant:Croatia'},
];

test('event naming uses question metadata or cached participants, never a lone outcome',()=>{
  const snapshot={questionId:325,coins,label:cached[0].question};
  assert.equal(bundleEventLabel(snapshot,cached),'Czechia — Croatia');
  assert.equal(localizeBundleLabel('Czechia — Croatia','ru'),'Чехия — Хорватия');
  assert.equal(bundleEventLabel(snapshot,[],{questions:[{question:325,name:'template:sportsContestResult',description:'participantA:Czechia|participantB:Croatia',namedOutcomes:[4483,4484,4485]}],outcomes:[]}), 'Czechia — Croatia');
  assert.equal(bundleEventLabel({questionId:91,coins:['#910'],label:'First leg'},[{question:'First leg',description:''}]),'#91');
  assert.equal(bundleEventLabel({questionId:92,coins:['#920'],label:'Saved event'},[]),'Saved event');
  assert.equal(bundleEventLabel({questionId:93,coins:['#930']},[],{questions:[{question:93,name:'Election results',namedOutcomes:[93]}],outcomes:[]}), 'Election results');
});

test('closed saved snapshot is enriched without changing final notification state',async()=>{
  initDatabase({accountAddress:account,network:'mainnet'});
  try {
    const id=randomUUID();
    const legs=coins.map((coin,i)=>({coin,size:39,filledSize:39,oid:'1',price:.3,cloid:'0x'+String(i+1).repeat(32)}));
    createCompleteSetAttempt({id,questionId:325,budget:40,shares:39,coins,account,network:'mainnet',ruleDigest:'a'.repeat(64),feeDigest:'b'.repeat(64),legs});
    updateCompleteSetAttempt(id,'filled',legs);
    coins.forEach((coin,i)=>upsertOutcome({outcomeId:Number(coin.slice(1))/10,question:cached[i].question,description:cached[i].description,sides:[{side:0,coin}]}));
    putBundleSnapshot(id,{id,questionId:325,coins,label:cached[0].question,status:'closed',cost:38.65524,net:.2949648,remaining:[]});
    markBundleFinalNotified(id);
    const before=getBundleSnapshot(id);
    const client={address:account,network:'mainnet',getOutcomeMeta:async()=>{throw Error('should not fetch metadata with cached participants');},getUserBalances:async()=>{throw Error('should not fetch balances for closed snapshot');}};
    const [snapshot]=await loadBundlePortfolio(client);
    assert.equal(snapshot.label,'Czechia — Croatia');
    assert.equal(getBundleSnapshot(id).final_notified,1);
    assert.deepEqual(getBundleSnapshot(id),before);
    let retry=0;
    await monitorBundlePortfolio(client,async()=>{retry++;return true;});
    assert.equal(retry,0);
    assert.equal(getBundleSnapshot(id).final_notified,1);
    assert.equal(getBundleSnapshot(id).snapshot.label,'Czechia — Croatia');
    const sent=[],bot={api:{sendMessage:async(_chat,text)=>sent.push(text)}};
    setSessionConfig({language:'ru'});
    assert.equal(await notifyBundlePortfolio(bot,'123',snapshot,'closed'),true);
    assert.deepEqual(sent,['Набор завершён: Чехия — Хорватия\nЧистая прибыль: +0,295 USDC (+0,76%)']);
    setSessionConfig({language:'en'});
    await notifyBundlePortfolio(bot,'123',{...snapshot,net:-.295},'closed');
    await notifyBundlePortfolio(bot,'123',{...snapshot,net:0},'closed');
    assert.equal(sent[1],'Bundle completed: Czechia — Croatia\nNet loss: -0.295 USDC (-0.76%)');
    assert.equal(sent[2],'Bundle completed: Czechia — Croatia\nBreak-even result: 0.000 USDC (0.00%)');
    setSessionConfig({language:'ru'});
    await notifyBundlePortfolio(bot,'123',{...snapshot,indicativePnl:-.295},'active');
    assert.match(sent[3],/^Наборы: Чехия — Хорватия\nОценка общей прибыли\/убытка: -0,295 USDC \(-0,76%\)\n/);
  } finally {closeDatabase();}
});
