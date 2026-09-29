import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLiquidityStore, liquidityStorePath } from '../../src/modules/liquidity/store.js';
const account='0x'+'1'.repeat(40);
test('scoped restrictive sqlite, synchronous persistence and reopen',()=>{
  const dir=mkdtempSync(join(tmpdir(),'liq-store-'));
  try {
    const scope={dataDir:dir,account,network:'testnet'};
    assert.match(liquidityStorePath(scope),/liquidity-testnet-0x1+\.sqlite$/);
    assert.throws(()=>liquidityStorePath({...scope,network:'wrong'}));
    const a=createLiquidityStore(scope),row={id:'a',requestId:'request001',policy:{account,network:'testnet'},status:'draft'};
    assert.equal(statSync(a.path).mode&0o777,0o600);
    a.save(row);assert.equal(a.findRequest('request001').id,'a');a.close();
    const b=createLiquidityStore(scope);assert.equal(b.get('a').status,'draft');
    row.status='paused';b.save(row);assert.equal(b.list()[0].status,'paused');
    assert.throws(()=>b.save({...row,policy:{account,network:'mainnet'}}));b.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
