import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertLiveTestnet } from '../../scripts/ops-probe-safety.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
test('all retired financial probes refuse even explicit flag without touching data',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'hip4-probe-'));
 try {
 const files=(await readdir(join(root,'scripts'))).filter(f=>/^(test-|debug-)/.test(f)||f==='claim-faucet.js');
 for(const f of files){const r=spawnSync(process.execPath,[join(root,'scripts',f),'--allow-live-testnet'],{cwd:temp,env:{...process.env,HL_NETWORK:'mainnet',HIP4_DATA_DIR:temp,LOG_TO_FILE:'false'},encoding:'utf8'});assert.equal(r.status,1,f);assert.match(r.stderr,/Retired unsafe legacy probe/,f);}
 assert.deepEqual(await readdir(temp),[]);
 assert.throws(()=>assertLiveTestnet('mainnet',['--allow-live-testnet']));assert.throws(()=>assertLiveTestnet('testnet',[]));assert.doesNotThrow(()=>assertLiveTestnet('testnet',['--allow-live-testnet']));
 }finally{await rm(temp,{recursive:true,force:true});}
});
test('structured stderr and disk redact strings, nested errors and unpatched console input',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'hip4-logger-'));const log=join(temp,'log.jsonl');
 try{
 const url=new URL('../../src/modules/logger.js',import.meta.url).href;
 const r=spawnSync(process.execPath,['--input-type=module','-e',`
 import {safeLogError,safeLogInfo,flushLogger,patchConsoleForRedaction} from '${url}';
 safeLogError('password=contextsecret',new Error('authorization=Bearer abcsecret privateKey=0x'+'ab'.repeat(32)),{note:'password=extrasecret',nested:new Error('secret=nestedsecret')});
 safeLogInfo('index:main','Starting token=infosecret');
 patchConsoleForRedaction();console.debug(new Error('password=debugsecret'));console.error('https://user:proxypass@example.com:1234');
 await flushLogger(0);
 `],{cwd:temp,env:{...process.env,HIP4_DATA_DIR:temp,LOG_TO_FILE:'true',LOG_FILE_PATH:log},encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);const disk=await readFile(log,'utf8');
 for(const text of [disk,r.stderr,r.stdout]) for(const secret of ['contextsecret','abcsecret','extrasecret','nestedsecret','infosecret','debugsecret','proxypass','ab'.repeat(32)])assert.ok(!text.includes(secret),secret);
 assert.match(disk,/REDACTED/);assert.match(disk,/nested/);
 }finally{await rm(temp,{recursive:true,force:true});}
});
test('HTTPS proxy transport stays HTTPS',()=>{
 const url=new URL('../../src/modules/proxy.js',import.meta.url).href;
 const r=spawnSync(process.execPath,['--input-type=module','-e',`import {getProxyConfig} from '${url}';const c=getProxyConfig();if(!c.runtimeUrl.startsWith('https:')||c.downgradedToHttpConnect)process.exit(2);`],{env:{...process.env,PROXY:'https://user:pass@proxy.example:8443'},encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
});
