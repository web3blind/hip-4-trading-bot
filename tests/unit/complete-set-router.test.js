import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleCallbackQuery } from '../../src/modules/bot/routing/callback-router.js';
import { setAllowedUserId, setHLClient, userStates, invalidateUserState } from '../../src/modules/bot/runtime.js';
import { setSessionConfig } from '../../src/modules/config.js';
import {meta,templates,fees,account,fixedNow} from '../fixtures/complete-set.js';

test('real router: owner-only open, amount step, review, stale replay rejected',async()=>{
  const realNow=Date.now; Date.now=()=>Date.parse('2026-09-23T16:00:00Z');
  try {
    await invalidateUserState(123); setAllowedUserId(123); setSessionConfig({language:'en',hlNetwork:'mainnet',notifications:{}});
    let writes=0;
    const client={network:'mainnet',address:account,getOutcomeMeta:async()=>meta,getOutcomeTemplates:async()=>templates,getUserFees:async()=>fees,
      getOrderbook:async coin=>({levels:[[],[{px:{'#44830':'0.28','#44840':'0.26','#44850':'0.44'}[coin],sz:'1000'}]]}),
      prepareOrder:async order=>({...order,maxSpend:order.price*order.size*1.01}),getAvailableUsdc:async()=>500,
      placeOrders:async()=>{writes++;throw Error('mock call blocked')}
    };setHLClient(client);
    const messages=[];
    const ctx={chat:{id:123,type:'private'},from:{id:123},callbackQuery:{},
      answerCallbackQuery:async()=>{},editMessageText:async(text,extra)=>messages.push({text,extra}),reply:async(text,extra)=>messages.push({text,extra})};
    const route=async data=>{ctx.callbackQuery.data=data;await handleCallbackQuery(ctx)};
    await route('set_open:325');assert.equal(userStates.get(123)?.state,'AWAITING_SET_AMOUNT');
    await route('set_amount:325:40');assert.equal(userStates.get(123)?.state,'CONFIRMING_SET_BUY');
    const confirm=messages.at(-1).extra?.reply_markup?.inline_keyboard.flat().find(b=>b.callback_data?.startsWith('confirm_set_buy:'))?.callback_data;
    assert(confirm);assert.equal(writes,0);
    await route('set_open:325');await route(confirm);assert.equal(writes,0);
    ctx.chat.type='group';await route('set_open:325');assert.equal(userStates.get(123)?.state,'AWAITING_SET_AMOUNT');
  } finally { Date.now=realNow;await invalidateUserState(123);setHLClient(null); }
});
