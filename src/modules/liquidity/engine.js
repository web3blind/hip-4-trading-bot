import {market,bookQuote,feeEvidence} from './market.js';
export {market,bookQuote,feeEvidence} from './market.js';
import { randomBytes, createHash } from 'node:crypto';
import { orderStatuses } from '../hyperliquid.js';
import { validateLiquidityPolicy } from './policy.js';
import {resolveLiquidityEvent, assessLiquidityEvent, spendableSpotUsdc} from './event.js';
const coins = s => s.legs?.map(l=>l.coin) || [s.policy.coin];
const orderCoin = (s,o) => o.coin || s.policy.coin;
function eventMarket(meta,s,at,live) {
 if(!s.policy.event) return market(meta,s.policy.coin,at,live);
 const resolved=resolveLiquidityEvent(meta,s.policy.event);
 if(resolved.fingerprint!==s.membershipFingerprint) throw Error('Event metadata changed');
 const members=resolved.legs.map(l=>market(meta,l.coin,at,live));
 return {expiry:Math.min(...members.map(m=>m.expiry)),fingerprint:digest(members),members};
}

const TERMINAL = new Set(['stopped','expired']);
const ACTIVE = new Set(['active','observing','stopping','paused','recovery_required','error']);
const num = v => (typeof v === 'number' || typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v)) && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const oid = v => v != null && Number.isSafeInteger(Number(v)) && Number(v)>0 ? Number(v) : null;
const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const snapshot = s => structuredClone(s);
function binding(s,c) { if (!c || c.network !== s.policy.network || c.address?.toLowerCase() !== s.policy.account || s.signerAddress && c.wallet?.address?.toLowerCase()!==s.signerAddress) throw new Error('Liquidity account/network mismatch'); }
function inventory(data,coin) {
  if (!Array.isArray(data?.balances)) throw new Error('Inventory unavailable');
  const matches=data.balances.filter(b=>b.coin===coin || b.coin==='+'+coin.slice(1));
  if (matches.length>1) throw new Error('Ambiguous inventory');
  const total=matches.length ? num(matches[0].total) : 0;
  if (total===null || total<0) throw new Error('Invalid inventory');
  return total;
}
function orderState(response, intent, account) {
  const status=response?.order?.status;
  const detail=response?.order?.order;
  if (!status || !detail || typeof detail !== 'object') return {status:null,id:null};
  // An OID returned for a CLOID query is not evidence of ownership by itself.
  const expectedSide=intent.isBuy?'B':'A';
  if (detail.coin!==intent.coin || detail.side!==expectedSide ||
      detail.cloid!==intent.cloid ||
      [response.user,response.account,response.order.user,response.order.account,detail.user,detail.account]
        .some(v=>v!=null && (typeof v!=='string' || v.toLowerCase()!==account))) {
    throw new Error('Order identity mismatch');
  }
  const id=oid(detail.oid);
  if (!id) throw new Error('Order identity unavailable');
  return {status,id};
}
export function createLiquidityService({store,ownerId,now=Date.now,authorize=async()=>true}) {
  if (!store || ownerId == null || typeof now !== 'function' || typeof authorize !== 'function') throw new Error('Invalid liquidity service');
  let busy=false;
  const exclusive=async fn=>{if(busy) throw new Error('Liquidity service busy');busy=true;try{return await fn();}finally{busy=false;}};
  const save=s=>{store.save(s);return snapshot(s);};
  const load=id=>{const s=store.get(id);if(!s)throw new Error('Session not found');return s;};
  const owned=s=>s.orders.filter(o=>!['closed','rejected','aborted'].includes(o.state));
  const unresolved=s=>s.policy.mode==='live' && owned(s).length>0;
  const halt=(s,reason,state='stopping')=>{s.status=state;s.reason=reason;save(s);};
  // Exchange hold already removes resting notional from spendable cash. Only
  // the unheld part of ALL old reserves is additional; never debit that notional twice.
  function spotCapacity(s,balances,excludeCloid=null) {
    const available=spendableSpotUsdc(balances);
    const hold=Number(balances.balances.find(b=>b.coin==='USDC').hold || 0);
    const buys=owned(s).filter(o=>o.isBuy && o.cloid!==excludeCloid);
    const reserves=buys.reduce((n,o)=>n+Math.max(0,o.reserve-o.trades.reduce((v,t)=>v+t.sz*t.px+t.fee,0)),0);
    const heldNotional=buys.filter(o=>o.state==='open').reduce((n,o)=>n+Math.max(0,o.size-o.trades.reduce((v,t)=>v+t.sz,0))*o.price,0);
    return available-Math.max(0,reserves-Math.min(hold,heldNotional));
  }
  async function reconcile(s,client,excludeCloid=null) {
    binding(s,client);
    if(s.policy.mode==='observe') return save(s);
    const fills=await client.getUserFillsByTime(s.startedAt || s.createdAt,now(),s.policy.account);
    if(!Array.isArray(fills) || fills.length>=500) throw new Error('Fill history incomplete');
    for(const order of s.orders) {
      if(order.cloid===excludeCloid || ['rejected','aborted'].includes(order.state)) continue;
      const response=await client.getOrderStatus(order.oid || order.cloid,s.policy.account);
      const {status,id}=orderState(response,{...order,coin:orderCoin(s,order)},s.policy.account);
      if(id && order.oid && id!==order.oid) throw new Error('Order identity changed');
      if(id) order.oid=id;
      const open=status==='open';
      const closed=/^(filled|canceled|cancelled|rejected|expired|marginCanceled)$/.test(status||'');
      if(!open && !closed) {order.state='unknown';save(s);continue;}
      const matching=fills.filter(f=>order.oid && oid(f.oid ?? f.orderId)===order.oid || !order.oid && f.cloid===order.cloid);
      const trades=new Map(order.trades.map(t=>[t.key,t]));
      for(const f of matching) {
        const key=f.tid!=null?`tid:${f.tid}`:f.hash && Number.isSafeInteger(num(f.time))?`hash:${f.hash}:${f.time}:${f.oid}:${f.sz}`:null;
        const sz=num(f.sz),px=num(f.px),fee=num(f.fee);
        if(!key || sz===null || sz<=0 || px===null || px<=0 || px>=1 || fee===null || fee<0 || f.feeToken!=='USDC') throw new Error('Fill economics/identity unknown');
        if(!trades.has(key)) trades.set(key,{key,sz,px,fee});
      }
      order.trades=[...trades.values()];
      if(order.trades.reduce((n,t)=>n+t.sz,0)>order.size+1e-7) throw new Error('Fill exceeds order');
      order.state=open?'open':status==='filled' && order.trades.reduce((n,t)=>n+t.sz,0)<order.size-1e-7?'unknown':'closed';
      save(s);
      if(['canceled','cancelled','expired','marginCanceled'].includes(status) && !order.cancelExpected &&
          s.status==='active') throw new Error('outside_order_cancellation');
    }
    // Re-query account state after awaits; outside activity cannot be attributed to this session.
    const balances=await client.getUserBalances(s.policy.account);
    const legs=coins(s).map(coin=>{
      const buys=s.orders.filter(o=>o.isBuy && orderCoin(s,o)===coin).flatMap(o=>o.trades);
      const sells=s.orders.filter(o=>!o.isBuy && orderCoin(s,o)===coin).flatMap(o=>o.trades);
      const shares=buys.reduce((n,t)=>n+t.sz,0)-sells.reduce((n,t)=>n+t.sz,0);
      const spend=buys.reduce((n,t)=>n+t.sz*t.px+t.fee,0),revenue=sells.reduce((n,t)=>n+t.sz*t.px-t.fee,0);
      if(shares < -1e-7 || Math.abs(inventory(balances,coin)-shares)>1e-7) throw Error('Inventory attribution mismatch; protocol or outside activity requires review');
      return {coin,shares,spend,revenue};
    });
    const shares=legs.reduce((n,l)=>n+l.shares,0),spend=legs.reduce((n,l)=>n+l.spend,0),revenue=legs.reduce((n,l)=>n+l.revenue,0);
    const reservations=owned(s).filter(o=>o.isBuy && o.cloid!==excludeCloid).reduce((n,o)=>n+Math.max(0,o.reserve-o.trades.reduce((v,t)=>v+t.sz*t.px+t.fee,0)),0);
    if(spend+reservations>s.policy.budgetUsdc+1e-7 || shares>s.policy.maxInventoryShares+1e-7) throw Error('Inventory or spend mismatch');
    s.exposure={shares,spend,revenue,reservations,legs,realizedNet:revenue-spend,observedAt:now()};
    return save(s);
  }
  async function cleanup(s,c) {
    if(s.policy.mode==='observe') {s.status='stopped';return save(s);}
    // Resolve any prepared/unknown CLOID against its own identity before cancelling.
    // Reconciliation failure is not evidence that an order is gone.
    let verified=false;
    try {await reconcile(s,c);verified=true;} catch { /* retry on the next tick */ }
    for(const o of owned(s)) {
      // Balance/fill evidence can fail while an identified live order still needs
      // cancellation. Independently verify its identity before using any OID.
      if(!verified) {
        try {
          binding(s,c);
          const {status,id}=orderState(await c.getOrderStatus(o.oid||o.cloid,s.policy.account),
            {...o,coin:orderCoin(s,o)},s.policy.account);
          if(id && o.oid && id!==o.oid) continue;
          if(status!=='open') continue;
          o.oid=id;save(s);
        } catch {continue;}
      }
      if(!o.oid) continue;
      binding(s,c);
      if(!['open','unknown','prepared','cancel_unknown'].includes(o.state)) continue;
      o.state='cancel_unknown';o.cancelExpected=true;save(s); // durable cancel intent
      try {await c.cancelOrder(orderCoin(s,o),o.oid,{beforeTransmit:()=>binding(s,c)});} catch { /* read back below */ }
      try {await reconcile(s,c);verified=true;} catch {verified=false;o.state='cancel_unknown';save(s);}
    }
    s.status=verified && !unresolved(s)?'stopped':'recovery_required';
    return save(s);
  }
  return {
    async proposeEvent(policy,options,client) {
      if(!policy.event || policy.coin) throw Error('Event selection required');
      const validated=validateLiquidityPolicy(policy);
      const assessment=await assessLiquidityEvent(client,validated,now);
      const s=this.propose(validated,options);if(s.status!=='draft') return s;
      s.legs=assessment.legs.map(({coin,outcomeId,side,name,sideName,fallback,size})=>({coin,outcomeId,side,name,sideName,fallback,size}));
      s.membershipFingerprint=assessment.fingerprint;s.eventLabel=assessment.label;s.assessment=assessment;s.cursor=0;
      if(await authorize(snapshot(s))!==true) {s.assessment.suitability='unsuitable';s.assessment.reasons.push({code:'ownership_or_authorization_conflict'});}
      return save(s);
    },
    propose(policy,{requestId,credentialId=null,credentialGeneration=null}={}) {
      const p=validateLiquidityPolicy(policy);
      if(p.account!==store.account || p.network!==store.network || typeof requestId!=='string' || !/^[a-zA-Z0-9_-]{8,128}(?::[a-zA-Z0-9_-]{8,128}){0,2}$/.test(requestId)) throw new Error('Invalid request/scope');
      if(credentialId!==null && (typeof credentialId!=='string' || credentialId.length>128 || !credentialId)) throw new Error('Invalid credential');
      if(credentialGeneration!==null && !(typeof credentialGeneration==='string' && /^[a-f0-9]{24}$/.test(credentialGeneration) || Number.isSafeInteger(credentialGeneration) && credentialGeneration>=0)) throw new Error('Invalid credential generation');
      const existing=store.findRequest(requestId);
      if(existing) {if(digest(existing.policy)!==digest(p) || existing.credentialId!==credentialId || existing.credentialGeneration!==credentialGeneration) throw new Error('Request ID conflict');return snapshot(existing);}
      const s={id:randomBytes(16).toString('hex'),requestId,policy:p,credentialId,credentialGeneration,status:'draft',reason:null,createdAt:now(),startedAt:null,expiresAt:null,market:null,actions:0,proposals:[],orders:[],exposure:{shares:0,spend:0,revenue:0,realizedNet:0}};
      return save(s);
    },
    async review(id,client) {return exclusive(async()=>{
      const s=load(id);binding(s,client);
      if(s.status!=='draft' || !s.policy.event) throw Error('Event review unavailable');
      const a=await assessLiquidityEvent(client,s.policy,now);
      if(a.fingerprint!==s.membershipFingerprint) throw Error('Event metadata changed');
      if(await authorize(snapshot(s))!==true) {a.suitability='unsuitable';a.reasons.push({code:'ownership_or_authorization_conflict'});}
      s.assessment=a;s.legs=a.legs;return save(s);
    });},
    async approve(id,{ownerId:who,client}={}) {return exclusive(async()=>{
      const s=load(id);if(who!==ownerId || s.status!=='draft') throw new Error('Owner approval required');binding(s,client);
      if(s.policy.event && s.policy.mode==='live') {if(!client.wallet?.address)throw Error('Bound signer unavailable');s.signerAddress=client.wallet.address.toLowerCase();}
      if(store.list().some(other=>other.id!==id && (ACTIVE.has(other.status)||unresolved(other)))) throw new Error('Account has unresolved liquidity session');
      const at=now();
      const meta=await client.getOutcomeMeta(),m=eventMarket(meta,s,now(),s.policy.mode==='live');
      if(s.policy.mode==='live') {
        const balances=await client.getUserBalances(s.policy.account);
        if(coins(s).some(coin=>inventory(balances,coin)!==0)) throw new Error('Existing inventory');
        const open=await client.getOpenOrders(s.policy.account);
        if(!Array.isArray(open) || open.some(o=>coins(s).some(coin=>o.coin===coin || o.coin==='+'+coin.slice(1)))) throw new Error('Foreign orders or unavailable open orders');
        const fees=await client.getUserFees();for(const member of m.members || [m]) feeEvidence(fees,member.feeScale);
      }
      if(s.policy.event) {
        const assessment=await assessLiquidityEvent(client,s.policy,now);
        if(assessment.fingerprint!==s.membershipFingerprint)throw Error('Event metadata changed');
        if(assessment.suitability!=='conditional')throw Object.assign(Error('Event assessment blocked: '+assessment.reasons.map(r=>r.code).join(', ')),{assessment});
        if(digest(assessment.legs.map(l=>[l.coin,l.bid,l.ask,l.size,l.feeRate,l.reserve]))!==digest(s.assessment.legs.map(l=>[l.coin,l.bid,l.ask,l.size,l.feeRate,l.reserve])))throw Error('Assessment changed; review again');
        s.assessment=assessment;
      }
      if(await authorize(snapshot(s))!==true) throw Error('Authorization changed');
      // No awaits after this point: credential validation may have aged the
      // assessment or any mandatory book while the owner grant was pending.
      const activationAt=now();
      if(s.policy.event && (!Number.isFinite(s.assessment.observedAt) || activationAt-s.assessment.observedAt>5000 || s.assessment.observedAt>activationAt+1000 ||
        coins(s).some(coin=>{const leg=s.assessment.legs.find(l=>l.coin===coin);return !leg || leg.unavailable || !Number.isFinite(leg.time) || activationAt-leg.time>5000 || leg.time>activationAt+1000;})))
        throw Error('Assessment expired; review again');
      if(store.get(id)?.stopRequested) throw new Error('Session stopped during approval');
      binding(s,client);
      if(activationAt>=m.expiry-3600000) throw new Error('Market expiry near');
      s.market=m;s.startedAt=activationAt;s.expiresAt=Math.min(s.startedAt+s.policy.durationMinutes*60000,m.expiry-3600000);s.status=s.policy.mode==='live'?'active':'observing';
      if(s.expiresAt<=activationAt) throw new Error('Session expired during approval');return save(s);
    });},
    async tick(client) {return exclusive(async()=>{
      const retry=store.list().find(x=>x.policy.mode==='live' && (unresolved(x) && x.status!=='active' ||
        ['recovery_required','stopping','paused','error'].includes(x.status) && x.reason!=='outside_order_cancellation'));
      if(retry) {binding(retry,client);return cleanup(retry,client);}
      const s=store.list().find(x=>x.status==='active'||x.status==='observing');if(!s)return null;binding(s,client);
      if(now()>=s.expiresAt) {halt(s,'duration_or_market_expiry','expired');return s.policy.mode==='live'?cleanup(s,client):save(s);}
      try {
        const meta=await client.getOutcomeMeta(),m=eventMarket(meta,s,now(),s.policy.mode==='live');
        if(m.fingerprint!==s.market.fingerprint || m.expiry!==s.market.expiry) throw new Error('Market metadata changed');
        const quotes={};for(const coin of coins(s)) quotes[coin]=bookQuote(await client.getOrderbook(coin),now(),s.policy);
        const coin=coins(s)[(s.cursor || 0)%coins(s).length],q=quotes[coin];
        if(s.policy.mode==='observe') {s.proposals.push(s.policy.event?{at:now(),event:s.policy.event,legs:coins(s).map(c=>({coin:c,...quotes[c],size:s.legs.find(l=>l.coin===c).size}))}:{at:now(),...q});s.proposals=s.proposals.slice(-100);return save(s);}
        await reconcile(s,client);
        if(s.policy.event && owned(s).some(o=>o.trades.reduce((n,t)=>n+t.sz,0)>0 && o.trades.reduce((n,t)=>n+t.sz,0)<o.size-1e-7)) {halt(s,'partial_leg');return cleanup(s,client);}
        if(store.get(s.id).stopRequested) return cleanup(s,client);
        const open=await client.getOpenOrders(s.policy.account);
        if(!Array.isArray(open) || open.some(o=>coins(s).some(coin=>o.coin===coin || o.coin==='+'+coin.slice(1)) && !s.orders.some(own=>own.oid && own.oid===oid(o.oid)))) throw new Error('Foreign order or unavailable order inventory');
        // Bid marks remaining shares conservatively; no claimed realized PnL from this mark.
        if(s.exposure.spend-s.exposure.revenue-(s.exposure.legs || [{coin,shares:s.exposure.shares}]).reduce((n,l)=>n+l.shares*quotes[l.coin].bid,0)>=s.policy.maxLossUsdc) {halt(s,'loss_stop');return cleanup(s,client);}
        if(store.get(s.id).stopRequested) return cleanup(s,client);
        if(owned(s).some(o=>o.state!=='open')) {halt(s,'unresolved_leg');return cleanup(s,client);}
        if(owned(s).some(o=>orderCoin(s,o)===coin)) {s.cursor=((s.cursor||0)+1)%coins(s).length;return save(s);} // unknown orders block replacement, even without an OID
        if(s.actions>=s.policy.maxActions) {halt(s,'action_limit');return cleanup(s,client);}
        const rate=feeEvidence(await client.getUserFees(),(m.members?.[coins(s).indexOf(coin)] || m).feeScale);
        const exposure=s.exposure.legs?.find(l=>l.coin===coin) || s.exposure;
        const orderSize=s.legs?.find(l=>l.coin===coin)?.size || s.policy.orderSizeShares;
        const isBuy=exposure.shares < orderSize;
        const price=isBuy?q.bid:q.ask;
        const size=isBuy?orderSize:Math.min(orderSize,exposure.shares);
        const prepared=await client.prepareMakerOrder({coin,isBuy,price,size});
        if(prepared.orderType!=='PostOnly' || prepared.coin!==coin || prepared.isBuy!==isBuy || prepared.price!==price || prepared.size<=0 || prepared.size>size+1e-7 || isBuy && prepared.size>s.policy.maxInventoryShares-s.exposure.shares-owned(s).filter(o=>o.isBuy).reduce((n,o)=>n+o.size-o.trades.reduce((v,t)=>v+t.sz,0),0)+1e-7) throw new Error('Invalid maker preparation');
        const reserve=isBuy?prepared.maxSpend:0;
        if(isBuy) {
          const available=s.policy.event ? spotCapacity(s,await client.getUserBalances(s.policy.account)) : num(await client.getAvailableUsdc());
          if(available===null || available<0 || !Number.isFinite(reserve) || reserve<prepared.price*prepared.size*(1+rate)-1e-7 || reserve>available || reserve+s.exposure.spend+(s.exposure.reservations||0)>s.policy.budgetUsdc+1e-7) {halt(s,'budget_or_inventory');return cleanup(s,client);}
        }
        // All awaited data and owner grant are checked again immediately before a write.
        if(now()>=s.expiresAt || now()>=s.market.expiry-3600000 || store.get(s.id).status!=='active') {halt(s,'authorization_or_expiry');return cleanup(s,client);}
        binding(s,client);
        const latest=eventMarket(await client.getOutcomeMeta(),s,now(),true);
        if(latest.fingerprint!==s.market.fingerprint || latest.expiry!==s.market.expiry) throw new Error('Market metadata changed before placement');
        for(const memberCoin of coins(s)) bookQuote(await client.getOrderbook(memberCoin),now(),s.policy);
        const fees=await client.getUserFees();for(const member of latest.members || [latest]) feeEvidence(fees,member.feeScale);
        const latestOpen=await client.getOpenOrders(s.policy.account);
        if(!Array.isArray(latestOpen) || latestOpen.some(o=>coins(s).some(c=>o.coin===c || o.coin==='+'+c.slice(1)) && !s.orders.some(own=>own.oid===oid(o.oid)))) throw new Error('Foreign order before placement');
        if(now()>=s.expiresAt || store.get(s.id).status!=='active' || await authorize(snapshot(s))!==true) {halt(s,'authorization_or_expiry');return cleanup(s,client);}
        binding(s,client);
        if(now()>=s.expiresAt || now()>=s.market.expiry-3600000 || store.get(s.id).status!=='active') {halt(s,'authorization_or_expiry');return cleanup(s,client);}
        const cloid='0x'+randomBytes(16).toString('hex');
        s.orders.push({coin,cloid,oid:null,isBuy,price:prepared.price,size:prepared.size,reserve,state:'prepared',trades:[]});s.actions++;s.cursor=((s.cursor||0)+1)%coins(s).length;save(s);
        const o=s.orders.at(-1);
        let lastMarks=quotes;
        const beforeTransmit=()=>{
          const latest=store.get(s.id);
          if(!latest || latest.status!=='active' || latest.stopRequested || now()>=latest.expiresAt ||
              now()>=latest.market.expiry-3600000) {
            const error=new Error('Liquidity grant expired or revoked before submission');
            error.neverSubmitted=true;
            throw error;
          }
          try {binding(s,client);if(s.policy.event && Object.values(lastMarks).some(mark=>now()-mark.time>5000||mark.time>now()+1000)) throw Error('Event book snapshot expired before transmission');} catch(error) {error.neverSubmitted=true;throw error;}
        };
        const beforeSubmit=async()=>{
          if(s.policy.event) {
            try {
              const latestMeta=eventMarket(await client.getOutcomeMeta(),s,now(),true);
              if(latestMeta.fingerprint!==s.market.fingerprint) throw Error('Metadata changed during signing');
              const marks={};for(const c of coins(s)) {const book=await client.getOrderbook(c);marks[c]=bookQuote(book,now(),s.policy);const depths=book.levels.map(level=>level.reduce((n,l)=>n+Number(l.sz),0));const size=s.legs.find(l=>l.coin===c).size;if(depths.some(d=>!Number.isFinite(d)||d<size)||Math.max(...depths)/Math.min(...depths)>4)throw Error('Event depth unavailable or imbalanced');}
              for(const member of s.legs.filter(l=>l.side===0)){const no=marks['#'+(member.outcomeId*10+1)],yes=marks[member.coin];if(Math.abs(yes.bid+no.ask-1)>0.00002||Math.abs(yes.ask+no.bid-1)>0.00002)throw Error('Merged book changed');}
              if(marks[coin].bid!==q.bid || marks[coin].ask!==q.ask) throw Error('Book changed during signing');
              const fees=await client.getUserFees();for(let i=0;i<latestMeta.members.length;i++){const rate=feeEvidence(fees,latestMeta.members[i].feeScale),mark=marks[coins(s)[i]];if(mark.ask-mark.bid-rate*(mark.ask+mark.bid)<=0)throw Error('Net spread unavailable during signing');}
              // This intent has never reached the exchange. Reconcile every
              // other leg, but do not turn the current prepared CLOID into an
              // unknown order by querying it before its first transmission.
              const continuity=digest(s.orders.filter(order=>order!==o));
              await reconcile(s,client,cloid);
              if(digest(s.orders.filter(order=>order!==o))!==continuity || owned(s).some(order=>order!==o && order.state!=='open')) throw Error('Event order continuity changed during signing');
              const open=await client.getOpenOrders(s.policy.account);
              if(!Array.isArray(open) || open.some(order=>coins(s).some(c=>order.coin===c || order.coin==='+'+c.slice(1)) && !owned(s).some(own=>own!==o && own.oid && own.oid===oid(order.oid) && orderCoin(s,own)===('#'+order.coin.slice(1))))) throw Error('Foreign event order during signing');
              if(owned(s).some(own=>own!==o && !open.some(order=>oid(order.oid)===own.oid && orderCoin(s,own)===('#'+order.coin.slice(1))))) throw Error('Owned event order missing during signing');
              const balances=await client.getUserBalances(s.policy.account);
              for(const leg of s.exposure.legs) if(Math.abs(inventory(balances,leg.coin)-leg.shares)>1e-7) throw Error('Inventory attribution mismatch');
              if(isBuy && (spotCapacity(s,balances,cloid)+1e-7<reserve || reserve+s.exposure.spend+s.exposure.reservations>s.policy.budgetUsdc+1e-7)) throw Error('Spendable Spot USDC changed');
              if(s.exposure.spend-s.exposure.revenue-s.exposure.legs.reduce((n,l)=>n+l.shares*marks[l.coin].bid,0)>=s.policy.maxLossUsdc) throw Error('Loss stop during signing');
              if(await authorize(snapshot(s))!==true) throw Error('Authorization changed during signing');
              lastMarks=marks;
            } catch(error) {error.neverSubmitted=true;throw error;}
          }
          beforeTransmit();
        };
        try {
          const result=await client.placeMakerOrders([{...prepared,cloid,maxSpend:reserve}],{beforeSubmit,beforeTransmit});
          const status=orderStatuses(result,1)[0];
          if(status.error) o.state='rejected'; else {o.oid=oid(status.resting?.oid??status.filled?.oid);o.state=status.resting?'open':'unknown';}
        } catch(e) {o.state=e.neverSubmitted?'aborted':'unknown';}
        save(s);
        if(s.policy.event && ['rejected','unknown'].includes(o.state)) {halt(s,'unresolved_leg');return cleanup(s,client);}
        if(store.get(s.id).stopRequested || o.state==='aborted') {
          if(!store.get(s.id).stopRequested) halt(s,'authorization_or_expiry');
          return cleanup(s,client);
        }
        return save(s);
      } catch(e) {halt(s,e.message,'paused');return e.message==='outside_order_cancellation'?save(s):cleanup(s,client);}
    });},
    requestStop(id,{ownerId:who,client,reason='owner_stop'}={}) {
      const s=load(id);if(who!==ownerId) throw new Error('Owner required');
      if(TERMINAL.has(s.status)&&!unresolved(s)) return snapshot(s);
      // A durable owner revocation is not a financial write and must survive a changed signer.
      const intent=store.requestStop(id,reason);
      if(intent.startedAt==null && intent.orders.length===0) {intent.status='stopped';return save(intent);}
      return snapshot(intent);
    },
    async stop(id,{ownerId:who,client,reason='owner_stop'}={}) {return exclusive(async()=>{
      const s=load(id);if(who!==ownerId)throw new Error('Owner required');if(TERMINAL.has(s.status)&&!unresolved(s))return snapshot(s);
      if(s.status==='draft') {s.status='stopped';s.reason=reason;return save(s);}
      binding(s,client);if(!s.stopRequested) halt(s,reason);return cleanup(s,client);
    });},
    async revokeCredential(id,generation,client) {return exclusive(async()=>{
      const results=[];for(const s of store.list().filter(s=>s.credentialId===id && s.credentialGeneration===generation && !TERMINAL.has(s.status))) {
        if(s.status==='draft'){s.status='stopped';s.reason='credential_revoked';results.push(save(s));continue;}
        binding(s,client);halt(s,'credential_revoked');results.push(await cleanup(s,client));
      }return results;
    });},
    async recover(client) {return exclusive(async()=>{
      const results=[];for(const s of store.list().filter(s=>ACTIVE.has(s.status)||unresolved(s))) {
        if(s.policy.mode==='observe'){s.status='stopped';s.reason='restart_review_required';results.push(save(s));continue;}
        binding(s,client);halt(s,'restart_review_required','recovery_required');
        try{await reconcile(s,client);}catch{ /* unresolved evidence remains visible */ }
        results.push(await cleanup(s,client));
      }return results;
    });},
    list() {return store.list().map(snapshot);},get(id) {const s=store.get(id);return s?snapshot(s):null;},
    hasUnresolved() {return store.list().some(s=>ACTIVE.has(s.status)||unresolved(s));},
    async shutdown(client) {return this.recover(client);},
  };
}
