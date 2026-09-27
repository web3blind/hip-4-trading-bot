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
    const first=messages.at(-1).extra.reply_markup.inline_keyboard.flat().find(b=>b.callback_data?.endsWith(':min'))?.callback_data;
    assert(first);
    await route(first);assert.equal(userStates.get(123)?.state,'CONFIRMING_SET_BUY');
    const confirm=messages.at(-1).extra?.reply_markup?.inline_keyboard.flat().find(b=>b.callback_data?.startsWith('confirm_set_buy:'))?.callback_data;
    assert(confirm);assert.equal(writes,0);
    await route('set_open:325');await route(first);assert.equal(userStates.get(123)?.state,'AWAITING_SET_AMOUNT');
    await route(confirm);assert.equal(writes,0);
    ctx.chat.type='group';await route('set_open:325');assert.equal(userStates.get(123)?.state,'AWAITING_SET_AMOUNT');
    ctx.chat.type='private';setSessionConfig({language:'ru',hlNetwork:'mainnet',notifications:{}});
    await route('set_open:325');
    const buttons=messages.at(-1).extra.reply_markup.inline_keyboard.flat();
    assert.equal(buttons.at(-1).text,'Отмена');
    assert.equal(buttons.at(-1).callback_data,'back_menu');
    const stale=buttons[0].callback_data;
    await route(buttons.at(-1).callback_data);
    assert.equal(userStates.has(123),false);
    await route(stale);await route(confirm);
    assert.equal(userStates.has(123),false);assert.equal(writes,0);
  } finally { Date.now=realNow;await invalidateUserState(123);setHLClient(null); }
});
