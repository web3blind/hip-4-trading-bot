import { randomBytes, createHash } from 'node:crypto';
import { coinToOutcome } from '../hl-encoding.js';
import { FEE_RESERVE, orderStatuses } from '../hyperliquid.js';
import { validateLiquidityPolicy } from './policy.js';

const TERMINAL = new Set(['stopped','expired']);
const ACTIVE = new Set(['active','observing','stopping','paused','recovery_required','error']);
const num = v => (typeof v === 'number' || typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v)) && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const oid = v => v != null && Number.isSafeInteger(Number(v)) && Number(v)>0 ? Number(v) : null;
const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const snapshot = s => structuredClone(s);
function binding(s,c) { if (!c || c.network !== s.policy.network || c.address?.toLowerCase() !== s.policy.account) throw new Error('Liquidity account/network mismatch'); }
function market(meta, coin, at, live) {
  const {outcomeId,side}=coinToOutcome(coin);
  const spec=meta?.outcomes?.find(x=>x.outcome===outcomeId);
  if (!spec || spec.quoteToken !== 'USDC') throw new Error('Unavailable USDC outcome');
  const feeScale=num(spec.deployerFeeScale);
  if(live && (feeScale===null || feeScale<0 || feeScale>10)) throw new Error('Outcome fee scale unavailable');
  const question=meta?.questions?.find(q=>q.question===spec.question || q.namedOutcomes?.includes(outcomeId));
  const desc=`${spec.description||''}|${question?.description||''}`;
  if (live && /(?:priceBinary|binaryPrice|priceTouch)/i.test(`${spec.name||''}|${question?.name||''}|${desc}`)) throw new Error('Short-expiry price market not supported live');
  const timestamp = spec.expiry ?? spec.expiryTime ?? question?.expiry ?? question?.expiryTime ?? /(?:^|\|)(?:expiry|time):(\d{8}-\d{4})/.exec(desc)?.[1];
  let expiry;
  if (typeof timestamp === 'string' && /^\d{8}-\d{4}$/.test(timestamp)) expiry=Date.parse(`${timestamp.slice(0,4)}-${timestamp.slice(4,6)}-${timestamp.slice(6,8)}T${timestamp.slice(9,11)}:${timestamp.slice(11)}:00Z`);
  else if (typeof timestamp === 'string' && /^\d{4}-\d\d-\d\dT/.test(timestamp)) expiry=Date.parse(timestamp);
  else if (typeof timestamp === 'number' && timestamp > 1e12) expiry=timestamp;
  if (!Number.isSafeInteger(expiry) || expiry <= at + 3600000) throw new Error('Market expiry unavailable or inside safety buffer');
  const cutoff=question?.decisionDeadline ?? spec.decisionDeadline;
  if (cutoff != null && (!Number.isSafeInteger(num(cutoff)) || num(cutoff) <= at + 3600000)) throw new Error('Decision cutoff unavailable or near');
  if (spec.settled || spec.isSettled || question?.settledNamedOutcomes?.includes(outcomeId)) throw new Error('Settled outcome');
  return {expiry,feeScale,fingerprint:digest({spec,question,template:meta?.templates?.find(t=>t.id===question?.name),side})};
}
function inventory(data,coin) {
  if (!Array.isArray(data?.balances)) throw new Error('Inventory unavailable');
  const matches=data.balances.filter(b=>b.coin===coin || b.coin==='+'+coin.slice(1));
  if (matches.length>1) throw new Error('Ambiguous inventory');
  const total=matches.length ? num(matches[0].total) : 0;
  if (total===null || total<0) throw new Error('Invalid inventory');
  return total;
}
function bookQuote(book,at,p) {
  const time=num(book?.time);
  const bid=num(book?.levels?.[0]?.[0]?.px), ask=num(book?.levels?.[1]?.[0]?.px);
  if (!Number.isSafeInteger(time) || time>at+1000 || at-time>5000 || bid===null || ask===null || bid<=0 || ask>=1 || bid>=ask || ask-bid<p.minSpread || bid<p.minPrice || ask>p.maxPrice) throw new Error('Stale, crossed or out-of-corridor book');
  return {bid,ask,time};
}
function feeEvidence(fees,scale) {
  const accountRate=num(fees?.userSpotCrossRate),baseRate=num(fees?.feeSchedule?.spotCross);
  if(accountRate===null || baseRate===null || scale===null || accountRate<0 || baseRate<0 || accountRate>0.02 || baseRate>0.02) throw new Error('Fee rate unknown');
  const rate=2*Math.max(accountRate,baseRate)*(scale+Math.max(scale,1));
  if(rate>FEE_RESERVE) throw new Error('Outcome fee exceeds reserve');
  return rate;
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
  const owned=s=>s.orders.filter(o=>!['closed','rejected'].includes(o.state));
  const unresolved=s=>s.policy.mode==='live' && owned(s).length>0;
  const halt=(s,reason,state='stopping')=>{s.status=state;s.reason=reason;save(s);};
  async function reconcile(s,client) {
    binding(s,client);
    if(s.policy.mode==='observe') return save(s);
    const fills=await client.getUserFillsByTime(s.startedAt || s.createdAt,now(),s.policy.account);
    if(!Array.isArray(fills) || fills.length>=500) throw new Error('Fill history incomplete');
    for(const order of s.orders) {
      const response=await client.getOrderStatus(order.oid || order.cloid,s.policy.account);
      const {status,id}=orderState(response,{...order,coin:s.policy.coin},s.policy.account);
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
        if(!key || sz===null || sz<=0 || px===null || px<=0 || px>=1 || fee===null || f.feeToken!=='USDC') throw new Error('Fill economics/identity unknown');
        if(!trades.has(key)) trades.set(key,{key,sz,px,fee});
      }
      order.trades=[...trades.values()];
      if(order.trades.reduce((n,t)=>n+t.sz,0)>order.size+1e-7) throw new Error('Fill exceeds order');
      order.state=open?'open':status==='filled' && order.trades.reduce((n,t)=>n+t.sz,0)<order.size-1e-7?'unknown':'closed';
      save(s);
    }
    // Re-query account state after awaits; outside activity cannot be attributed to this session.
    const actual=inventory(await client.getUserBalances(s.policy.account),s.policy.coin);
    const buys=s.orders.filter(o=>o.isBuy).flatMap(o=>o.trades);
    const sells=s.orders.filter(o=>!o.isBuy).flatMap(o=>o.trades);
    const shares=buys.reduce((n,t)=>n+t.sz,0)-sells.reduce((n,t)=>n+t.sz,0);
    const spend=buys.reduce((n,t)=>n+t.sz*t.px+t.fee,0);
    const revenue=sells.reduce((n,t)=>n+t.sz*t.px-t.fee,0);
    if(shares < -1e-7 || Math.abs(actual-shares)>1e-7 || spend>s.policy.budgetUsdc+1e-7 || shares>s.policy.maxInventoryShares+1e-7) throw new Error('Inventory or spend mismatch');
    s.exposure={shares,spend,revenue,realizedNet:revenue-spend,observedAt:now()};
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
            {...o,coin:s.policy.coin},s.policy.account);
          if(id && o.oid && id!==o.oid) continue;
          if(status!=='open') continue;
          o.oid=id;save(s);
        } catch {continue;}
      }
      if(!o.oid) continue;
      binding(s,c);
      if(!['open','unknown','prepared','cancel_unknown'].includes(o.state)) continue;
      o.state='cancel_unknown';save(s); // durable cancel intent
      try {await c.cancelOrder(s.policy.coin,o.oid);} catch { /* read back below */ }
      try {await reconcile(s,c);verified=true;} catch {verified=false;o.state='cancel_unknown';save(s);}
    }
    s.status=verified && !unresolved(s)?'stopped':'recovery_required';
    return save(s);
  }
  return {
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
    async approve(id,{ownerId:who,client}={}) {return exclusive(async()=>{
      const s=load(id);if(who!==ownerId || s.status!=='draft') throw new Error('Owner approval required');binding(s,client);
      if(store.list().some(other=>other.id!==id && ACTIVE.has(other.status))) throw new Error('Account has unresolved liquidity session');
      const at=now();
      const meta=await client.getOutcomeMeta(),m=market(meta,s.policy.coin,now(),s.policy.mode==='live');
      if(s.policy.mode==='live') {
        if(inventory(await client.getUserBalances(s.policy.account),s.policy.coin)!==0) throw new Error('Existing inventory');
        const open=await client.getOpenOrders(s.policy.account);
        if(!Array.isArray(open) || open.some(o=>o.coin===s.policy.coin || o.coin==='+'+s.policy.coin.slice(1))) throw new Error('Foreign orders or unavailable open orders');
        feeEvidence(await client.getUserFees(),m.feeScale);
      }
      if(now()>=m.expiry-3600000) throw new Error('Market expiry near');
      s.market=m;s.startedAt=now();s.expiresAt=Math.min(s.startedAt+s.policy.durationMinutes*60000,m.expiry-3600000);s.status=s.policy.mode==='live'?'active':'observing';
      if(s.expiresAt<=now()) throw new Error('Session expired during approval');return save(s);
    });},
    async tick(client) {return exclusive(async()=>{
      const retry=store.list().find(x=>x.policy.mode==='live' && ['recovery_required','stopping','paused','error'].includes(x.status));
      if(retry) {binding(retry,client);return cleanup(retry,client);}
      const s=store.list().find(x=>x.status==='active'||x.status==='observing');if(!s)return null;binding(s,client);
      if(now()>=s.expiresAt) {halt(s,'duration_or_market_expiry','expired');return s.policy.mode==='live'?cleanup(s,client):save(s);}
      try {
        const meta=await client.getOutcomeMeta(),m=market(meta,s.policy.coin,now(),s.policy.mode==='live');
        if(m.fingerprint!==s.market.fingerprint || m.expiry!==s.market.expiry) throw new Error('Market metadata changed');
        const q=bookQuote(await client.getOrderbook(s.policy.coin),now(),s.policy);
        if(s.policy.mode==='observe') {s.proposals.push({at:now(),...q});s.proposals=s.proposals.slice(-100);return save(s);}
        await reconcile(s,client);
        const open=await client.getOpenOrders(s.policy.account);
        if(!Array.isArray(open) || open.some(o=>(o.coin===s.policy.coin || o.coin==='+'+s.policy.coin.slice(1)) && !s.orders.some(own=>own.oid && own.oid===oid(o.oid)))) throw new Error('Foreign order or unavailable order inventory');
        // Bid marks remaining shares conservatively; no claimed realized PnL from this mark.
        if(s.exposure.spend-s.exposure.revenue-s.exposure.shares*q.bid>=s.policy.maxLossUsdc) {halt(s,'loss_stop');return cleanup(s,client);}
        if(owned(s).length) return save(s); // unknown orders block replacement, even without an OID
        if(s.actions>=s.policy.maxActions) {halt(s,'action_limit');return cleanup(s,client);}
        const rate=feeEvidence(await client.getUserFees(),m.feeScale);
        const isBuy=s.exposure.shares < s.policy.orderSizeShares;
        const price=isBuy?q.bid:q.ask;
        const size=isBuy?s.policy.orderSizeShares:Math.min(s.policy.orderSizeShares,s.exposure.shares);
        const prepared=await client.prepareMakerOrder({coin:s.policy.coin,isBuy,price,size});
        if(prepared.orderType!=='PostOnly' || prepared.coin!==s.policy.coin || prepared.isBuy!==isBuy || prepared.price!==price || prepared.size<=0 || prepared.size>size+1e-7 || isBuy && prepared.size>s.policy.maxInventoryShares-s.exposure.shares+1e-7) throw new Error('Invalid maker preparation');
        const reserve=isBuy?prepared.maxSpend:0;
        if(isBuy) {
          const available=num(await client.getAvailableUsdc());
          if(available===null || available<0 || !Number.isFinite(reserve) || reserve<prepared.price*prepared.size*(1+rate)-1e-7 || reserve>available || reserve+s.exposure.spend>s.policy.budgetUsdc+1e-7) {halt(s,'budget_or_inventory');return cleanup(s,client);}
        }
        // All awaited data and owner grant are checked again immediately before a write.
        if(now()>=s.expiresAt || now()>=s.market.expiry-3600000 || store.get(s.id).status!=='active') {halt(s,'authorization_or_expiry');return cleanup(s,client);}
        binding(s,client);
        const latest=market(await client.getOutcomeMeta(),s.policy.coin,now(),true);
        if(latest.fingerprint!==s.market.fingerprint || latest.expiry!==s.market.expiry) throw new Error('Market metadata changed before placement');
        bookQuote(await client.getOrderbook(s.policy.coin),now(),s.policy);
        feeEvidence(await client.getUserFees(),latest.feeScale);
        const latestOpen=await client.getOpenOrders(s.policy.account);
        if(!Array.isArray(latestOpen) || latestOpen.some(o=>o.coin===s.policy.coin || o.coin==='+'+s.policy.coin.slice(1))) throw new Error('Foreign order before placement');
        if(now()>=s.expiresAt || store.get(s.id).status!=='active' || await authorize(snapshot(s))!==true) {halt(s,'authorization_or_expiry');return cleanup(s,client);}
        binding(s,client);
        if(now()>=s.expiresAt || now()>=s.market.expiry-3600000 || store.get(s.id).status!=='active') {halt(s,'authorization_or_expiry');return cleanup(s,client);}
        const cloid='0x'+randomBytes(16).toString('hex');
        s.orders.push({cloid,oid:null,isBuy,price:prepared.price,size:prepared.size,reserve,state:'prepared',trades:[]});s.actions++;save(s);
        const o=s.orders.at(-1);
        try {
          const result=await client.placeMakerOrders([{...prepared,cloid,maxSpend:reserve}]);
          const status=orderStatuses(result,1)[0];
          if(status.error) o.state='rejected'; else {o.oid=oid(status.resting?.oid??status.filled?.oid);o.state=status.resting?'open':'unknown';}
        } catch {o.state='unknown';}
        save(s);return save(s);
      } catch(e) {halt(s,e.message,'paused');return cleanup(s,client);}
    });},
    async stop(id,{ownerId:who,client,reason='owner_stop'}={}) {return exclusive(async()=>{
      const s=load(id);if(who!==ownerId)throw new Error('Owner required');if(TERMINAL.has(s.status)&&!unresolved(s))return snapshot(s);
      if(s.status==='draft') {s.status='stopped';s.reason=reason;return save(s);}
      binding(s,client);halt(s,reason);return cleanup(s,client);
    });},
    async revokeCredential(id,generation,client) {return exclusive(async()=>{
      const results=[];for(const s of store.list().filter(s=>s.credentialId===id && s.credentialGeneration===generation && !TERMINAL.has(s.status))) {
        if(s.status==='draft'){s.status='stopped';s.reason='credential_revoked';results.push(save(s));continue;}
        binding(s,client);halt(s,'credential_revoked');results.push(await cleanup(s,client));
      }return results;
    });},
    async recover(client) {return exclusive(async()=>{
      const results=[];for(const s of store.list().filter(s=>ACTIVE.has(s.status))) {
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
