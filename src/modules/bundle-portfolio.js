import {getBundleAttempts,getBundleSnapshot,putBundleSnapshot,markBundleAlert,markBundleFinalNotified,getPendingBundleCloseRequests,updateBundleCloseRequest,getOutcomeByCoin,getBundleFillEvidence,putBundleFillEvidence} from './database.js';
import {getCompleteSetFeeEvidence} from './complete-set-fees.js';

const coinOf = coin => /^[#+][0-9]+0$/.test(String(coin)) ? `#${String(coin).slice(1)}` : null;
const num = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const keyOf = f => f.tid != null ? `tid:${f.tid}` : f.hash && Number.isSafeInteger(Number(f.time)) ? `hash:${f.hash}:${f.time}:${f.oid}:${f.sz}` : null;
const eq = (a,b) => Math.abs(a-b)<1e-7;

/** Ascending time windows, bisected if the exchange fills a page. A saturated millisecond fails closed. */
export async function bundleFillHistory(client,start,end) {
  if (typeof client.getUserFillsByTime !== 'function' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<0 || start>end) throw new Error('Fill history unavailable');
  const fills=new Map();
  async function collect(from,to) {
    const page=await client.getUserFillsByTime(from,to,client.address);
    if(!Array.isArray(page) || page.some(f=>!Number.isSafeInteger(Number(f.time)) || Number(f.time)<from || Number(f.time)>to || !keyOf(f))) throw new Error('Incomplete fill history');
    if(page.length>=2000) {
      if(from===to) throw new Error('Incomplete fill history');
      const mid=from+Math.floor((to-from)/2);
      await collect(from,mid);await collect(mid+1,to);return;
    }
    for(const f of page) {
      const key=keyOf(f),prior=fills.get(key);
      if(prior && JSON.stringify(prior)!==JSON.stringify(f)) throw new Error('Conflicting trade identity');
      fills.set(key,f);
    }
  }
  for(let from=start;from<=end;) {
    const to=Math.min(end,from+6*60*60*1000-1);
    await collect(from,to);from=to+1;
  }
  return [...fills.values()].sort((a,b)=>Number(a.time)-Number(b.time));
}

/** Trade identity and exchange startPosition anchor the entire per-coin inventory chain. */
export function evaluateBundle(attempt,allAttempts,fills,balances,mids={}) {
  const base={id:attempt.id,questionId:attempt.question_id,coins:attempt.coins,createdAt:attempt.created_at,status:'unknown',reason:null,cost:null,proceeds:null,net:null,value:null,indicativePnl:null,remaining:[],ownershipCertain:false};
  const fail=reason=>({...base,reason});
  if(!Array.isArray(balances?.balances) || !Array.isArray(fills) || !Array.isArray(attempt.legs) || attempt.legs.length!==attempt.coins.length) return fail('history');
  const held=new Map(),seen=new Map();
  for(const b of balances.balances) {
    const coin=coinOf(b.coin);if(!coin) continue;
    const total=num(b.total),hold=num(b.hold);
    if(total===null || total<0 || hold===null || hold<0 || hold>total+1e-7 || held.has(coin)) return fail('balance');
    held.set(coin,{total,available:Math.max(0,total-hold)});
  }
  for(const f of fills) {
    if(!coinOf(f.coin)) continue;
    const key=keyOf(f);if(!key || !Number.isSafeInteger(Number(f.time))) return fail('history');
    if(seen.has(key)) {if(JSON.stringify(seen.get(key))!==JSON.stringify(f)) return fail('duplicate fills');continue;}
    seen.set(key,f);
  }
  const unique=[...seen.values()].sort((a,b)=>Number(a.time)-Number(b.time));
  const remaining=[];let cost=0,proceeds=0,unknown=false,ambiguous=false,allExited=true,openValue=0,acquired=0;
  for(let i=0;i<attempt.coins.length;i++) {
    const coin=attempt.coins[i],leg=attempt.legs[i];
    if(!coinOf(coin) || coinOf(coin)!==coin) return fail('buy identity');
    const expected=num(leg.filledSize);
    // A rejected zero-fill leg in a partial batch has no bundle shares to attribute.
    if((leg.status==='rejected' || leg.status==='cancelled') && expected===0) continue;
    if(!leg.oid || !/^\d+$/.test(String(leg.oid)) || expected===null || expected<=0) return fail('buy identity');
    const chain=unique.filter(f=>coinOf(f.coin)===coin),buys=chain.filter(f=>String(f.oid??f.orderId)===String(leg.oid) && f.side==='B');
    const bought=buys.reduce((n,f)=>n+(num(f.sz)??0),0);
    if(!buys.length || buys.some(f=>num(f.sz)===null || num(f.sz)<=0 || num(f.px)===null || num(f.px)<=0 || num(f.px)>=1 || num(f.startPosition)===null) || !eq(bought,expected)) return fail('buy fills');
    acquired++;
    let inventory=0,sold=0,started=false,processedBuys=0,closedChain=false,tail=0;
    for(const f of chain) {
      const isBuy=buys.includes(f),time=Number(f.time);
      if(!started && !isBuy) {
        // Earlier activity is acceptable only if the first matched buy proves a zero starting inventory.
        continue;
      }
      if(!started) {started=true;if(!eq(num(f.startPosition),0)) ambiguous=true;}
      if(closedChain) {
        const sz=num(f.sz);
        if(isBuy || !['B','A'].includes(f.side) || sz===null || sz<=0 || num(f.startPosition)===null || !eq(num(f.startPosition),tail)) ambiguous=true;
        else tail+=f.side==='B'?sz:-sz;
        continue;
      }
      if(!['B','A'].includes(f.side) || num(f.sz)===null || num(f.sz)<=0 || num(f.startPosition)===null || !eq(num(f.startPosition),inventory)) {ambiguous=true;continue;}
      if(!isBuy && time<Number(buys[0].time)) {ambiguous=true;continue;}
      const sz=num(f.sz),px=num(f.px),fee=num(f.fee);
      if(px===null || px<0 || px>1 || f.feeToken!=='USDC' || fee===null) unknown=true;
      if(isBuy) {
        if(px===0 || px===1) unknown=true;
        inventory+=sz;processedBuys+=sz;if(fee!==null && px!==null) cost+=sz*px+fee;
      } else {
        if(f.side!=='A' || (f.dir!=='Settlement' && !/^Sell/.test(String(f.dir))) || sz>inventory+1e-7) ambiguous=true;
        inventory-=sz;sold+=sz;if(fee!==null && px!==null) proceeds+=sz*px-fee;
        if(eq(inventory,0) && eq(processedBuys,expected)) closedChain=true;
      }
    }
    if(!closedChain && chain.some(f=>Number(f.time)>=Number(buys[0].time) && f.side==='B' && !buys.includes(f))) ambiguous=true;
    if(!closedChain && allAttempts.some(other=>other.id!==attempt.id && other.coins.includes(coin) && other.created_at>=attempt.created_at && other.state!=='closed')) ambiguous=true;
    if(sold>bought+1e-7 || inventory< -1e-7) ambiguous=true;
    const size=Math.max(0,inventory),live=held.get(coin)?.total??0,available=held.get(coin)?.available??0;
    if(!eq(live,closedChain?tail:size)) ambiguous=true;
    if(size>1e-7) allExited=false;
    const mid=num(mids[coin]??mids[`+${coin.slice(1)}`]);
    if(size>1e-7 && (mid===null || mid<0 || mid>1)) unknown=true;
    else openValue+=size*(mid??0);
    remaining.push({coin,size,available,live,mid,owned:!ambiguous && eq(live,size)});
  }
  if(!acquired) return fail('buy fills');
  const status=ambiguous||unknown?'unknown':allExited?'closed':'active';
  return {...base,status,reason:ambiguous?'ownership':unknown?'economics':null,
    cost:unknown?null:cost,proceeds:unknown||ambiguous?null:proceeds,
    net:allExited&&!ambiguous&&!unknown?proceeds-cost:null,
    value:!allExited&&!unknown&&!ambiguous?openValue:null,
    indicativePnl:!allExited&&!unknown&&!ambiguous?proceeds+openValue-cost:null,
    remaining,ownershipCertain:!ambiguous};
}

export async function loadBundlePortfolio(client,{attempts=getBundleAttempts,history=bundleFillHistory,balances=null,mids=null,evidence={get:getBundleFillEvidence,put:putBundleFillEvidence}}={}) {
  const rows=attempts(client.address,client.network);
  if(!rows.length) return [];
  const withLabel=s=>{
    let label=s.label;
    if(!label) try {label=getOutcomeByCoin(s.coins[0])?.question||null;} catch {}
    return {...s,label:label||`#${s.questionId}`,remaining:(s.remaining||[]).map(l=>{
      let legLabel=l.label;
      if(!legLabel) try {legLabel=getOutcomeByCoin(l.coin)?.question||null;} catch {}
      return {...l,label:legLabel||l.coin};
    })};
  };
  const completed=new Map(rows.map(r=>[r.id,getBundleSnapshot(r.id)?.snapshot]).filter(([,s])=>s?.status==='closed'));
  if(completed.size===rows.length) return rows.map(r=>withLabel(completed.get(r.id)));
  const pending=rows.filter(r=>!completed.has(r.id));
  let live,prices;
  try {[live,prices]=await Promise.all([balances??client.getUserBalances(client.address),mids??client.getAllMids()]);}
  catch {return rows.map(r=>withLabel(completed.get(r.id)??{id:r.id,questionId:r.question_id,coins:r.coins,createdAt:r.created_at,status:'unknown',reason:'history',remaining:[],ownershipCertain:false}));}
  const snapshots=[];
  for(const r of rows) {
    if(completed.has(r.id)) {snapshots.push(withLabel(completed.get(r.id)));continue;}
    try {
      const cached=evidence.get(r.id),end=Date.now(),start=cached?.cursor!=null?Math.max(r.created_at-3600000,cached.cursor-60000):Math.max(0,r.created_at-3600000);
      const fresh=await history(client,start,end);
      const merged=new Map((cached?.fills||[]).map(f=>[keyOf(f),f]));
      for(const f of fresh) {
        const key=keyOf(f);if(!key || (merged.has(key) && JSON.stringify(merged.get(key))!==JSON.stringify(f))) throw new Error('Conflicting trade identity');
        merged.set(key,f);
      }
      const fills=[...merged.values()].sort((a,b)=>Number(a.time)-Number(b.time));
      const snapshot=withLabel(evaluateBundle(r,rows,fills,live,prices));
      if(snapshot.status!=='unknown') evidence.put(r.id,end,fills);
      snapshots.push(snapshot);
    } catch {snapshots.push(withLabel({id:r.id,questionId:r.question_id,coins:r.coins,createdAt:r.created_at,status:'unknown',reason:'history',remaining:[],ownershipCertain:false}));}
  }
  return snapshots;
}

export async function monitorBundlePortfolio(client,notify,{load=loadBundlePortfolio,repo={get:getBundleSnapshot,put:putBundleSnapshot,alert:markBundleAlert,final:markBundleFinalNotified},now=Date.now,threshold=10,repeatStep=2,cooldownMs=300000}={}) {
  const snapshots=await load(client);
  for(const snapshot of snapshots) {
    const previous=repo.get(snapshot.id);
    // Do not erase a verified historical result on a transient failure.
    if(previous?.snapshot?.status==='closed' && snapshot.status!=='closed') continue;
    repo.put(snapshot.id,snapshot);
    if(snapshot.status==='closed' && !previous?.final_notified && snapshot.net!==null && snapshot.net!==undefined) {
      if(await notify(snapshot,'closed')) repo.final(snapshot.id);
    } else if(snapshot.status==='active' && snapshot.indicativePnl!==null && snapshot.indicativePnl!==undefined && snapshot.cost>0 &&
      Math.abs(snapshot.indicativePnl/snapshot.cost*100)>=threshold &&
      (!previous?.alert_at || now()-previous.alert_at>=cooldownMs) &&
      (previous?.alert_value==null || Math.abs(snapshot.indicativePnl-previous.alert_value)/snapshot.cost*100>=repeatStep)) {
      if(await notify(snapshot,'active')) repo.alert(snapshot.id,snapshot.indicativePnl,now());
    }
  }
  return snapshots;
}

/** Conservative per-outcome fee ceiling; all legs require the same verified deployer scale. */
export async function quoteBundleClose(client,snapshot) {
  if(snapshot.status!=='active' || !snapshot.ownershipCertain || !snapshot.remaining?.some(l=>l.size>1e-7) || snapshot.remaining.some(l=>l.size>1e-7 && (!eq(l.size,l.live) || l.available+1e-7<l.size))) throw new Error('Bundle shares cannot be uniquely attributed or are held by orders');
  const orders=[];let expected=0;
  if(typeof client.getOutcomeMeta!=='function') throw new Error('Fee unavailable');
  const meta=await client.getOutcomeMeta();
  const outcomes=meta?.outcomes??meta?.[1]?.outcomes;
  const selected=snapshot.remaining.filter(l=>l.size>1e-7).map(l=>outcomes?.find(o=>o.outcome===Number(l.coin.slice(1))/10));
  if(selected.some(o=>!o)) throw new Error('Fee unavailable');
  const fee=await getCompleteSetFeeEvidence(client,{outcomes:selected});
  if(!fee) throw new Error('Fee unavailable');
  for(const leg of snapshot.remaining.filter(l=>l.size>1e-7)) {
    const book=await client.getOrderbook(leg.coin);
    const bids=book?.levels?.[0];
    if(!Array.isArray(bids)) throw new Error('No executable bid');
    let depth=0,last=null,gross=0;
    for(const level of bids) {
      const sz=num(level.sz),px=num(level.px);
      if(sz===null || sz<=0 || px===null || px<=0 || px>=1) throw new Error('Invalid book');
      const take=Math.min(sz,leg.size-depth);gross+=take*px;depth+=take;last=px;
      if(depth+1e-7>=leg.size) break;
    }
    if(depth+1e-7<leg.size || last===null || leg.size*last<10) throw new Error('Insufficient depth or below minimum notional');
    const prepared=await client.prepareOrder({coin:leg.coin,isBuy:false,price:last,size:leg.size,orderType:'Market'});
    if(!eq(prepared.size,leg.size) || !eq(prepared.price,last) || prepared.orderType!=='Market') throw new Error('Size or price changed');
    orders.push(prepared);expected+=gross*(1-fee.rate);
  }
  return {orders,expected,feeRate:fee.rate,net:snapshot.cost===null?null:snapshot.proceeds+expected-snapshot.cost};
}

export function bundleCoveredCoins(snapshots) {
  const covered=new Map();
  for(const snapshot of snapshots) if(snapshot.status==='active' && snapshot.ownershipCertain)
    for(const leg of snapshot.remaining) covered.set(leg.coin,(covered.get(leg.coin)||0)+leg.size);
  return covered;
}

/** Origin is established by the first matched buy's zero startPosition, not an epoch scan. */
export async function verifyBundleOrigin(_client,snapshot) {
  if(snapshot?.status!=='active' || !snapshot.ownershipCertain) throw new Error('Bundle origin unverified');
}

/** Never make a second close available until every IOC leg has a terminal status and covered fills. */
export async function reconcileBundleCloseRequests(client,{list=getPendingBundleCloseRequests,update=updateBundleCloseRequest,history=bundleFillHistory}={}) {
  for(const request of list(client.address,client.network)) {
    let fills;
    try {fills=await history(client,Math.max(0,request.created_at-1000),Date.now());} catch {continue;}
    const legs=[];
    for(const leg of request.legs) {
      if(leg.status==='rejected') {legs.push({...leg,filledSize:0,verified:true});continue;}
      let exchange;
      try {exchange=await client.getOrderStatus(leg.cloid,client.address);} catch {exchange=null;}
      const oid=String(exchange?.order?.order?.oid??leg.oid??'');
      const matching=fills.filter(f=>oid && String(f.oid??f.orderId)===oid && f.side==='A' && coinOf(f.coin)===leg.coin);
      const filled=matching.reduce((n,f)=>n+(num(f.sz)??0),0);
      const valid=matching.every(f=>keyOf(f) && num(f.sz)>0 && num(f.px)!==null && num(f.px)>=0 && num(f.px)<=1 && num(f.fee)!==null && f.feeToken==='USDC');
      const terminal=/filled|cancel|reject|expir/i.test(exchange?.order?.status||'');
      legs.push({...leg,oid:oid||null,filledSize:Math.max(filled,Number(leg.filledSize||0)),verified:valid && terminal && filled<=leg.size+1e-7 && filled+1e-7>=Number(leg.filledSize||0)});
    }
    update(request.id,legs.every(l=>l.verified)?'reconciled':'unknown',legs);
  }
}
