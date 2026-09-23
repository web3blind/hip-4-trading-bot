import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'hip4-attempt-'));process.env.HIP4_DATA_DIR=root;
const db=await import('../../src/modules/database.js');
const scope={network:'mainnet',accountAddress:'0x'+'3'.repeat(40)};
test('prepared attempt survives restart and records independent legs without writing live data',()=>{
  try {
    db.initDatabase(scope);
    const id='ae4a1a89-f987-429b-bfe3-498defe54c03';
    const legs=['#44830','#44840','#44850'].map((coin,i)=>({coin,cloid:'0x'+String(i+1).repeat(32),price:0.3,size:39,status:'prepared'}));
    db.createCompleteSetAttempt({id,questionId:325,budget:40,shares:39,coins:legs.map(x=>x.coin),legs,account:scope.accountAddress,network:'mainnet',ruleDigest:'a'.repeat(64),feeDigest:'b'.repeat(64)});
    assert.equal(db.getCompleteSetAttempts(['prepared']).length,1);
    db.closeDatabase();db.initDatabase(scope);
    assert.equal(db.getCompleteSetAttempts(['prepared'])[0].state,'prepared');
    db.updateCompleteSetAttempt(id,'submitting');
    db.updateCompleteSetAttempt(id,'partial',legs.map((x,i)=>i===0?{...x,oid:'101',filledSize:39}:{...x,status:'rejected'}));
    assert.equal(db.getCompleteSetAttempts()[0].legs[0].oid,'101');
    db.closeDatabase();db.initDatabase(scope);
    assert.equal(db.getCompleteSetAttempts()[0].state,'partial');
    db.updateCompleteSetAttempt(id,'closed',[]);
    assert.equal(db.getCompleteSetAttempts().length,0);
  } finally {db.closeDatabase();rmSync(root,{recursive:true,force:true});}
});
