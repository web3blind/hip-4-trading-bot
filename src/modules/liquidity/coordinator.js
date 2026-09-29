import { existsSync } from 'node:fs';
import { DATA_DIR } from '../config.js';
import * as runtime from '../bot/runtime.js';
import { isMcpCredentialCurrent } from '../mcp/key-store.js';
import { getCompleteSetAttempts, getBundleAttempts, getBundleSnapshot } from '../database.js';
import { coinToOutcome, isOutcomeCoin } from '../hl-encoding.js';

function bundleConflict(policy) {
  const id=coinToOutcome(policy.coin).outcomeId;
  const rows=[...getCompleteSetAttempts(['prepared','submitting','submitted_unknown','partial']),
    ...getBundleAttempts(policy.account,policy.network)];
  return rows.some(row=>row.account===policy.account.toLowerCase() && row.network===policy.network &&
    row.state!=='closed' && getBundleSnapshot(row.id)?.status!=='closed' &&
    (row.coins||row.legs?.map(l=>l.coin)||[]).some(c=>isOutcomeCoin(c)&&coinToOutcome(c).outcomeId===id));
}

/** Module-only coordinator. Existing trade/MCP confirmations are not altered. */
export function createLiquidityCoordinator({getClient=()=>runtime.hlClient,getOwner=()=>runtime.allowedUserId,
  transitioning=()=>runtime.runtimeTransitioning,locks=runtime.busyLocks,dataDir=DATA_DIR,
  credentialCurrent=isMcpCredentialCurrent,conflicts=bundleConflict,loadModules=async()=>({
    ...await import('./store.js'),...await import('./engine.js')})}={}) {
  let current=null, opening=null;
  const binding=c=>`${c?.network}:${String(c?.address||'').toLowerCase()}`;
  function ownerCheck(ownerId) {
    if (!getOwner() || String(ownerId)!==String(getOwner())) throw new Error('Owner approval required');
  }
  async function service({existingOnly=false,client=getClient()}={}) {
    if (!client?.address || !['mainnet','testnet'].includes(client.network)) throw new Error('Wallet unavailable');
    if (current?.binding===binding(client)) return current.service;
    if (current) throw new Error('Liquidity account transition requires cleanup');
    if (opening) {await opening;return service({existingOnly,client});}
    opening=(async()=>{
      const m=await loadModules();
      const scope={dataDir,account:client.address.toLowerCase(),network:client.network};
      if(existingOnly && !existsSync(m.liquidityStorePath(scope))) return null;
      const store=m.createLiquidityStore(scope);
      const engine=m.createLiquidityService({store,ownerId:String(getOwner()),authorize:async session=>{
        if(transitioning() || binding(getClient())!==binding(client)) return false;
        if(session.credentialId && !await credentialCurrent({id:session.credentialId,generation:session.credentialGeneration,scope:'trade'})) return false;
        return !conflicts(session.policy);
      }});
      current={binding:binding(client),service:engine,store,client,recovered:false};
      return engine;
    })();
    try{return await opening;}finally{opening=null;}
  }
  async function locked(fn,{allowTransition=false}={}) {
    const owner=getOwner(), key=Number(owner);
    if (!owner || (!allowTransition&&transitioning())) throw new Error('Runtime unavailable');
    if (locks.get(key)||locks.get(String(owner))) throw new Error('Financial operation is running');
    locks.set(key,true);
    try{return await fn();}finally{locks.delete(key);}
  }
  async function recoverOnce(s,client) {
    if(current?.recovered) return;
    await s.recover(client);current.recovered=true;
  }
  return {
    async list(){return await (await service()).list();},
    async get(id){return await (await service()).get(id);},
    async propose(policy,options={}) {
      return locked(async()=>{
        const client=getClient();
        if(policy.account!==client?.address?.toLowerCase() || policy.network!==client.network) throw new Error('Session account mismatch');
        if(options.credentialId && !await credentialCurrent({id:options.credentialId,generation:options.credentialGeneration,scope:'trade'})) throw new Error('MCP credential revoked');
        return (await service()).propose(policy,options);
      });
    },
    async approve(id,{ownerId}) {
      ownerCheck(ownerId);
      return locked(async()=>{
        const client=getClient(),s=await service();await recoverOnce(s,client);
        const session=await s.get(id);if(!session) throw new Error('Session not found');
        if(session.credentialId && !await credentialCurrent({id:session.credentialId,generation:session.credentialGeneration,scope:'trade'})) throw new Error('MCP credential revoked');
        if(session.policy.mode==='live' && conflicts(session.policy)) throw new Error('Outcome belongs to another bundle');
        // Trading consent is independent of reward-program eligibility.
        // Market, account, risk and ownership checks still run in the engine.
        return s.approve(id,{ownerId:String(ownerId),client});
      });
    },
    async stop(id,{ownerId,reason='owner_stop'}) {
      ownerCheck(ownerId);
      return locked(async()=>{const s=await service();return s.stop(id,{ownerId:String(ownerId),client:getClient(),reason});});
    },
    async tick() {
      if(!getClient() || transitioning() || locks.get(Number(getOwner())) || locks.get(String(getOwner()))) return;
      return locked(async()=>{
        const client=getClient(),s=await service({existingOnly:true});if(!s) return;
        await recoverOnce(s,client);
        for(const row of await s.list()) {
          if(row.credentialId && !await credentialCurrent({id:row.credentialId,generation:row.credentialGeneration,scope:'trade'}))
            await s.stop(row.id,{ownerId:String(getOwner()),client,reason:'credential_revoked'});
        }
        return s.tick(client);
      });
    },
    async shutdown(client=getClient()) {
      if(!client?.address) return;
      const s=await service({existingOnly:true,client});if(!s) return;
      return locked(async()=>{
        await s.shutdown(client);
        if(await s.hasUnresolved()) throw new Error('Liquidity orders still require reconciliation');
        current.store.close();current=null;
      },{allowTransition:true});
    },
  };
}
const coordinator=createLiquidityCoordinator();
export const listLiquiditySessions=()=>coordinator.list();
export const getLiquiditySession=id=>coordinator.get(id);
export const proposeLiquiditySession=(policy,options)=>coordinator.propose(policy,options);
export const approveLiquiditySession=(id,options)=>coordinator.approve(id,options);
export const stopLiquiditySession=(id,options)=>coordinator.stop(id,options);
export const tickLiquidity=()=>coordinator.tick();
export const shutdownLiquidity=client=>coordinator.shutdown(client);
export async function getLiquidityCampaigns(options={}) {
  const {getCampaignSnapshot}=await import('./campaigns.js');
  return getCampaignSnapshot(options);
}
