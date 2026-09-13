import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DATA_DIR, saveConfig } from '../../src/modules/config.js';
import { importWallet } from '../../src/modules/auth.js';
test('expired API credential leaves real startup in private Telegram recovery without trading', async () => {
  const imported=await importWallet('0x'+'2'.padStart(64,'0'));
  await saveConfig({authMode:'agent',walletAddress:'0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',agentAddress:imported.walletAddress,encrypted:{privateKey:imported.encryptedPrivateKey},hlNetwork:'testnet',agentValidUntil:1,language:'en'});
  const grammy = new URL('../../node_modules/grammy/out/mod.js',import.meta.url).href;
  const runtime = new URL('../../src/modules/bot/runtime.js',import.meta.url).href;
  const preload=join(DATA_DIR,'recovery-preload.mjs');
  await writeFile(preload,`import assert from 'node:assert/strict'; import {Bot} from ${JSON.stringify(grammy)}; globalThis.fetch=async()=>{throw new Error('Unexpected network')}; Bot.prototype.start=async function(options){ const runtime=await import(${JSON.stringify(runtime)}); assert.equal(runtime.hlClient,null); this.botInfo={id:9,is_bot:true,first_name:'QA',username:'qa_bot'}; const messages=[]; this.api.config.use(async(prev,method,payload)=>{if(method==='sendMessage')messages.push(payload.text);return {ok:true,result:{message_id:1}}}); await options.onStart(this.botInfo); await this.handleUpdate({update_id:1,message:{message_id:2,date:1,chat:{id:7,type:'private'},from:{id:7,is_bot:false,first_name:'QA'},text:'/start',entities:[{offset:0,length:6,type:'bot_command'}]}}); assert.ok(messages.length); console.log('RECOVERY_PRIVATE_MENU_OK'); };`,{mode:0o600});
  try {
    const result=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,new URL('../../src/index.js',import.meta.url).pathname],{env:{...process.env,TELEGRAM_BOT_TOKEN:'123:synthetic',TELEGRAM_ALLOWED_USER_ID:'7'},encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/RECOVERY_PRIVATE_MENU_OK/);
  } finally {await unlink(preload);}
});
