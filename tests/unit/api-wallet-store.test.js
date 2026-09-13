import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { DATA_DIR, saveConfig, loadConfig } from '../../src/modules/config.js';
import { getPrivateKey, decrypt, getMachineKey } from '../../src/modules/auth.js';
import { saveApiWalletConnection } from '../../src/modules/api-wallet-store.js';
const owner = new ethers.Wallet('0x' + '1'.padStart(64,'0'));
const agent = new ethers.Wallet('0x' + '2'.padStart(64,'0'));
const authorization = async () => new Response(JSON.stringify([{address:agent.address,validUntil:Date.now()+86400000}]));
const input = {accountAddress:owner.address,privateKey:agent.privateKey,network:'testnet',fetchImpl:authorization};
test('store uses encrypted restricted canonical file and preserves settings', async () => {
  const previous={language:'ru',notifications:{priceChangePercent:17}}; await saveConfig(previous);
  const config=await saveApiWalletConnection({...input,expectedConfig:previous});
  assert.equal(config.walletAddress,owner.address); assert.equal(config.agentAddress,agent.address);
  assert.equal(config.notifications.priceChangePercent,17); assert.equal(await getPrivateKey(config),agent.privateKey);
  const path=join(DATA_DIR,'config.json'); const raw=await readFile(path,'utf8');
  assert.equal(raw.includes(agent.privateKey.slice(2)),false); assert.equal((await stat(path)).mode&0o777,0o600);
});
test('replacement makes decryptable encrypted backup; failed activation restores old config',async()=>{
  const previous=await loadConfig(); const raw=await readFile(join(DATA_DIR,'config.json'),'utf8');
  await assert.rejects(saveApiWalletConnection({...input,expectedConfig:previous,persist:async next=>{await saveConfig(next);throw new Error('activation failed');}}),/not activated/);
  assert.deepEqual(await loadConfig(),previous);
  const backups=(await readdir(DATA_DIR)).filter(name=>name.endsWith('.enc'));
  assert.ok(backups.length); const key=await getMachineKey(); let matched=false;
  for(const name of backups) if(await decrypt(await readFile(join(DATA_DIR,name),'utf8'),key)===raw)matched=true;
  assert.equal(matched,true);
});
test('stale config, owner key, rejected permission never overwrite',async()=>{
  const previous=await loadConfig();
  await assert.rejects(saveApiWalletConnection({...input,expectedConfig:{}}),/changed/);
  await assert.rejects(saveApiWalletConnection({...input,privateKey:owner.privateKey,expectedConfig:previous}),/main wallet/);
  await assert.rejects(saveApiWalletConnection({...input,expectedConfig:previous,fetchImpl:async()=>new Response('[]')}),/not authorized/);
  assert.deepEqual(await loadConfig(),previous);
});
