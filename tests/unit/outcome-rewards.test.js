import test from 'node:test';
import assert from 'node:assert/strict';
import { getOutcomeRewards } from '../../src/modules/outcome-rewards.js';
const address='0x0000000000000000000000000000000000000001';
const raw={wallet:address,paid_usdc:'1.123456',pending_usdc:'0.500000',awarded_usdc:'1.623456',payments:1};
test('rewards preserve exact USDC strings and bind returned owner',async()=>{
 let target;
 const got=await getOutcomeRewards(address,{fetchImpl:async(url)=>{target=url;return new Response(JSON.stringify(raw));}});
 assert.equal(target.endsWith('/v1/rewards/'+address),true);assert.equal(got.paid,'1.123456');assert.equal(got.pending,'0.500000');
 await assert.rejects(getOutcomeRewards(address,{fetchImpl:async()=>new Response(JSON.stringify({...raw,wallet:'0x'+'2'.repeat(40)}))}),/mismatch/);
});
test('unavailable or malformed rewards never become zero balances',async()=>{
 await assert.rejects(getOutcomeRewards(address,{fetchImpl:async()=>new Response('{}',{status:503})}),/unavailable/);
 await assert.rejects(getOutcomeRewards(address,{fetchImpl:async()=>new Response(JSON.stringify({...raw,paid_usdc:null}))}),/totals/);
 let called=false;await assert.rejects(getOutcomeRewards('../invalid',{fetchImpl:async()=>{called=true;}}),/address/);assert.equal(called,false);
});
