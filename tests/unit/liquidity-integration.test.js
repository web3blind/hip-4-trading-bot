import test from 'node:test';
import assert from 'node:assert/strict';
import {createLiquidityMcp} from '../../src/modules/liquidity/mcp.js';
import {createLiquidityCoordinator} from '../../src/modules/liquidity/coordinator.js';
import * as runtime from '../../src/modules/bot/runtime.js';

const address='0x'+'1'.repeat(40);
const credential={id:'trade-key',generation:'generation-1',scope:'trade'};
const args={request_id:'proposal-12345',mode:'live',event:{type:'standalone',id:10},durationMinutes:60,budgetUsdc:100,
 maxInventoryShares:50,orderSizeShares:20,minPrice:.3,maxPrice:.7,minSpread:.02,maxLossUsdc:10,maxActions:10};
function fixture(){
 const rows=new Map(),calls=[];let valid=true;
 const api={getLiquidityCampaigns:async()=>({status:'unavailable'}),listLiquiditySessions:async()=>[...rows.values()],getLiquiditySession:async id=>rows.get(id),
 proposeLiquiditySession:async(policy,o)=>{calls.push('propose');const s={id:'session-1',status:'draft',policy,...o};rows.set(s.id,s);return s;},
 stopLiquiditySession:async(id,o)=>{calls.push(['stop',id,o]);return {...rows.get(id),status:'stopping'};}};
 const client={address,network:'mainnet'};
 const call=createLiquidityMcp({api,getClient:()=>client,getOwner:()=>77,currentCredential:async()=>valid,deliver:async id=>{calls.push(['review',id]);return true;}});
 return {call,rows,calls,set valid(v){valid=v}};
}
test('MCP proposes immutable scoped session, idempotent retries only deliver one owner review',async()=>{
 runtime.userStates.clear();const h=fixture();const a=await h.call('liquidity_request_session',args,credential);
 assert.equal(a.session.status,'draft');assert.equal(a.requires_owner_confirmation,true);
 assert.equal(a.session.policy.account,address);assert.equal(a.session.policy.network,'mainnet');
 assert.deepEqual(h.calls,['propose',['review','session-1']]);
 await h.call('liquidity_request_session',args,credential);assert.equal(h.calls.length,2);
 await assert.rejects(h.call('liquidity_request_session',{...args,budgetUsdc:200},credential),/reused/);
 assert.equal(h.calls.length,2);
});
test('read/revoked credentials cannot grant or stop sessions; foreign trade key cannot stop',async()=>{
 const h=fixture();
 await assert.rejects(h.call('liquidity_request_session',args,{...credential,scope:'read'}),/Trade scope/);
 await h.call('liquidity_request_session',args,credential);
 await assert.rejects(h.call('liquidity_stop_session',{session_id:'session-1'},{...credential,id:'other'}),/not owned/);
 await assert.rejects(h.call('liquidity_stop_session',{session_id:'session-1'},{...credential,scope:'read'}),/Trade scope/);
 h.valid=false;await assert.rejects(h.call('liquidity_stop_session',{session_id:'session-1'},credential),/revoked/);
 h.valid=true;assert.equal((await h.call('liquidity_stop_session',{session_id:'session-1'},credential)).status,'stopping');
});
test('no session proposal overwrites pending ordinary Telegram confirmation or accepts arbitrary account fields',async()=>{
 const h=fixture();runtime.userStates.set(77,{state:'CONFIRMING_MARKET_BUY'});
 try{await assert.rejects(h.call('liquidity_request_session',args,credential),/current Telegram/);assert.equal(h.calls.length,0);}
 finally{runtime.userStates.delete(77);}
 await assert.rejects(h.call('liquidity_request_session',{...args,account:'0x'+'2'.repeat(40)},credential),/Invalid session/);
});
test('owner grant remains private and applies to event observation and live modes',async()=>{
 const policy={...args,account:address,network:'mainnet'};delete policy.request_id;
 const s={id:'s',policy,status:'draft'};let approved=0;
 const c=createLiquidityCoordinator({getClient:()=>({address,network:'mainnet'}),getOwner:()=>77,locks:new Map(),conflicts:()=>false,
 loadModules:async()=>({createLiquidityStore:()=>({}),createLiquidityService:()=>({get:()=>s,recover:async()=>{},approve:async()=>{approved++;return s;}})})});
 await assert.rejects(c.approve('s',{ownerId:88}),/Owner/);assert.equal(approved,0);
 await c.approve('s',{ownerId:77});assert.equal(approved,1);
 s.policy.mode='observe';await c.approve('s',{ownerId:77});assert.equal(approved,2);
});

test('inactive coordinator shutdown neither opens storage nor calls exchange; owner guard remains module-only',async()=>{
 let opened=0;const c=createLiquidityCoordinator({getClient:()=>({address,network:'mainnet'}),getOwner:()=>null,
 loadModules:async()=>({liquidityStorePath:()=>`${process.env.HIP4_DATA_DIR}/absent`,createLiquidityStore:()=>{opened++;throw Error('must not open');}})});
 await c.shutdown();assert.equal(opened,0);
 await assert.rejects(c.approve('unknown',{ownerId:77}),/Owner approval/);
});
test('coordinator binds owner/account and refuses activation when bundle conflicts',async()=>{
 const calls=[],locks=new Map(),client={address,network:'mainnet'};
 const policy={...args,account:address,network:'mainnet'};delete policy.request_id;
 const s={id:'s',policy,status:'draft'};
 const engine={list:()=>[s],get:()=>s,propose:()=>s,recover:async()=>calls.push('recover'),approve:async()=>calls.push('approve'),
 shutdown:async()=>calls.push('shutdown'),hasUnresolved:()=>true};
 const c=createLiquidityCoordinator({getClient:()=>client,getOwner:()=>77,locks,conflicts:()=>true,
 loadModules:async()=>({liquidityStorePath:()=>process.env.HIP4_DATA_DIR,createLiquidityStore:()=>({close:()=>calls.push('close')}),createLiquidityService:()=>engine})});
 await assert.rejects(c.approve('s',{ownerId:88}),/Owner/);
 await assert.rejects(c.approve('s',{ownerId:77}),/another bundle/);assert(!calls.includes('approve'));assert.equal(locks.size,0);
 await assert.rejects(c.propose({...policy,network:'testnet'}),/mismatch/);
 await assert.rejects(c.shutdown(),/reconciliation/);assert(!calls.includes('close'));
});
