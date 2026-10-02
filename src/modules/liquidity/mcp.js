import * as runtime from '../bot/runtime.js';
import * as coordinator from './coordinator.js';
import { isMcpCredentialCurrent } from '../mcp/key-store.js';

export const LIQUIDITY_MCP_READ=new Set(['liquidity_campaigns','liquidity_sessions','liquidity_session_status']);
export const LIQUIDITY_MCP_TRADE=new Set(['liquidity_request_session','liquidity_stop_session']);
const fields=['mode','event','durationMinutes','budgetUsdc','maxInventoryShares','orderSizeShares','minPrice','maxPrice','minSpread','maxLossUsdc','maxActions'];
function visible(s) {
  if(!s) return {status:'not_found'};
  const out={eventLabel:s.eventLabel,assessment:s.assessment,legs:s.legs,id:s.id,status:s.status,policy:s.policy,reason:s.reason??null,expiresAt:s.expiresAt??null};
  for(const k of ['statistics','inventoryShares','buySpentUsdc','realizedPnlUsdc','indicativePnlUsdc']) if(s[k]!==undefined) out[k]=s[k];
  if(s.exposure) out.exposure={shares:s.exposure.shares,spendUsdc:s.exposure.spend,revenueUsdc:s.exposure.revenue,
    netCashFlowUsdc:s.exposure.realizedNet,observedAt:s.exposure.observedAt??null,
    note:'Last reconciled evidence, not live balance. Net cash flow is not realized PnL; held shares are not sold on stop.'};
  if(Array.isArray(s.proposals)) out.proposals=s.proposals.slice(-2);
  return out;
}

export function createLiquidityMcp({api=coordinator,getClient=()=>runtime.hlClient,getOwner=()=>runtime.allowedUserId,
  currentCredential=isMcpCredentialCurrent,deliver=async (id,expectedState)=>{
    if(!runtime.bot?.api || !runtime.allowedUserId) throw new Error('Telegram unavailable');
    const {showLiquiditySessionReview}=await import('../bot/features/liquidity.js');
    const owner=Number(runtime.allowedUserId);
    return showLiquiditySessionReview({chat:{id:owner,type:'private'},from:{id:owner},
      editMessageText:async()=>{throw new Error('New review');},
      reply:(text,opts)=>runtime.bot.api.sendMessage(owner,text,opts)},id,expectedState);
  }}={}) {
  const inflight=new Map(),delivered=new Map();
  return async function operation(name,args,credential) {
    if(!LIQUIDITY_MCP_READ.has(name) && !LIQUIDITY_MCP_TRADE.has(name)) throw new Error('Operation not allowed');
    if(!credential || !await currentCredential(credential)) throw new Error('MCP key revoked');
    if(!args || typeof args!=='object' || Array.isArray(args)) throw new Error('Invalid arguments');
    if(LIQUIDITY_MCP_TRADE.has(name) && credential.scope!=='trade') throw new Error('Trade scope required');
    if(name==='liquidity_campaigns') return api.getLiquidityCampaigns();
    if(name==='liquidity_sessions') return {sessions:(await api.listLiquiditySessions()).slice(0,20).map(visible)};
    if(name==='liquidity_session_status') return visible(await api.getLiquiditySession(args.session_id));
    if(name==='liquidity_stop_session') {
      const s=await api.getLiquiditySession(args.session_id);
      if(!s || s.credentialId!==credential.id || s.credentialGeneration!==credential.generation) throw new Error('Session not owned by this credential');
      if(!await currentCredential(credential)) throw new Error('MCP key revoked');
      return visible(await api.stopLiquiditySession(s.id,{ownerId:String(getOwner()),reason:'mcp_stop'}));
    }
    if(!/^[A-Za-z0-9_-]{8,80}$/.test(args.request_id||'') || Object.keys(args).some(k=>k!=='request_id'&&!fields.includes(k))) throw new Error('Invalid session request');
    const client=getClient();if(!client?.address) throw new Error('Wallet unavailable');
    const policy=Object.fromEntries(fields.map(k=>[k,args[k]]));
    Object.assign(policy,{account:client.address.toLowerCase(),network:client.network});
    const key=`${credential.id}:${credential.generation}:${args.request_id}`,fingerprint=JSON.stringify(policy);
    if(delivered.has(key)) {
      const old=delivered.get(key);if(old.fingerprint!==fingerprint) throw new Error('request_id reused');
      return {session:visible(await api.getLiquiditySession(old.id)),requires_owner_confirmation:true};
    }
    if(inflight.has(key)) {
      if(inflight.get(key).fingerprint!==fingerprint) throw new Error('request_id reused');
      return inflight.get(key).promise;
    }
    if(inflight.size || delivered.size>=100) throw new Error('Session proposal rate limit');
    const promise=(async()=>{
      const owner=Number(getOwner());
      if(!owner || runtime.runtimeTransitioning || runtime.busyLocks.get(owner)||runtime.userStates.has(owner)) throw new Error('Finish the current Telegram operation first');
      // Reserve a unique state before any assessment await. Cancel/menu clears
      // even this pending state, so absence after navigation is not permission
      // to install an unsolicited review over the newer Telegram operation.
      const expectedState={state:'LIQUIDITY_MCP_PROPOSING'};
      const binding=runtime.runtimeBinding();runtime.userStates.set(owner,expectedState);
      let s;
      try {
        s=await api.proposeLiquiditySession(policy,{requestId:key,credentialId:credential.id,credentialGeneration:credential.generation});
        if(!await currentCredential(credential) || getClient()!==client || runtime.runtimeBinding()!==binding || runtime.runtimeTransitioning || runtime.busyLocks.get(owner) || runtime.userStates.get(owner)!==expectedState) throw new Error('Telegram proposal abandoned or account/key changed');
        if(await deliver(s.id,expectedState)!==true) throw new Error('Telegram review delivery failed or abandoned');
        delivered.set(key,{id:s.id,fingerprint});
        return {session:visible(s),requires_owner_confirmation:true};
      } catch(error) {
        if(s?.status==='draft') await api.stopLiquiditySession(s.id,{ownerId:String(owner),reason:'owner_stop'});
        throw error;
      } finally {
        if(runtime.userStates.get(owner)===expectedState) await runtime.invalidateUserState(owner);
      }
    })();
    inflight.set(key,{promise,fingerprint});
    try{return await promise;}finally{inflight.delete(key);}
  };
}
export const liquidityMcpOperation=createLiquidityMcp();
