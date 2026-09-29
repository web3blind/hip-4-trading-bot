import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLiquidityCoordinator} from '../../src/modules/liquidity/coordinator.js';
import {createLiquidityMcp} from '../../src/modules/liquidity/mcp.js';
import {createLiquidityFeature} from '../../src/modules/bot/features/liquidity.js';
import {setSessionConfig} from '../../src/modules/config.js';
import * as runtime from '../../src/modules/bot/runtime.js';

test('MCP proposal reaches real SQLite and private owner review; observation ticks and stops without signing',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'liq-connected-'));
 const account='0x'+'1'.repeat(40),owner=77,messages=[];
 const expiry=Date.now()+86400000;
 const client={address:account,network:'testnet',
  getOutcomeMeta:async()=>({outcomes:[{outcome:30,quoteToken:'USDC',name:'Event',expiry,deployerFeeScale:1}],questions:[]}),
  getOrderbook:async()=>({time:Date.now(),levels:[[{px:'0.4'}],[{px:'0.6'}]]}),
  placeMakerOrders:async()=>assert.fail('No exchange write'),cancelOrder:async()=>assert.fail('No cancel')};
 const key={id:'1234567890abcdef',generation:'1234567890abcdef12345678',scope:'trade'};
 const c=createLiquidityCoordinator({getClient:()=>client,getOwner:()=>owner,dataDir:dir,locks:new Map(),conflicts:()=>false,credentialCurrent:async()=>true});
 const api={listLiquiditySessions:()=>c.list(),getLiquiditySession:id=>c.get(id),proposeLiquiditySession:(p,o)=>c.propose(p,o),
  approveLiquiditySession:(id,o)=>c.approve(id,o),stopLiquiditySession:(id,o)=>c.stop(id,o)};
 const ui=createLiquidityFeature({service:async()=>api});
 const ctx={chat:{id:owner,type:'private'},from:{id:owner},editMessageText:async(t,o)=>messages.push({t,o}),reply:async(t,o)=>messages.push({t,o})};
 runtime.setAllowedUserId(owner);runtime.setHLClient(client);setSessionConfig({language:'en',hlNetwork:'testnet'});
 const mcp=createLiquidityMcp({api,getClient:()=>client,getOwner:()=>owner,currentCredential:async()=>true,deliver:id=>ui.showReview(ctx,id)});
 const args={request_id:'request_123456',mode:'observe',coin:'#300',durationMinutes:30,budgetUsdc:100,maxInventoryShares:100,orderSizeShares:20,minPrice:.2,maxPrice:.8,minSpread:.1,maxLossUsdc:30,maxActions:2};
 try{
  const response=await mcp('liquidity_request_session',args,key),id=response.session.id;
  assert.equal((await c.get(id)).status,'draft');assert.equal((await c.list()).length,1);
  const callback=messages.at(-1).o.reply_markup.inline_keyboard.flat().find(b=>b.callback_data.startsWith('confirm_liquidity_session:')).callback_data;
  assert.equal(runtime.consumeConfirmation(owner,callback),'confirm_liquidity_session');
  await ui.confirm(ctx);assert.equal((await c.get(id)).status,'observing');
  await c.tick();assert.equal((await c.get(id)).proposals.length,1);
  const status=await mcp('liquidity_session_status',{session_id:id},key);assert.equal(status.proposals.length,1);
  await ui.stop(ctx,id);assert.equal((await c.get(id)).status,'stopped');
  await ui.confirm(ctx);assert.equal((await c.get(id)).status,'stopped');
 }finally{await c.shutdown();await runtime.invalidateUserState(owner);runtime.setHLClient(null);rmSync(dir,{recursive:true,force:true});}
});
