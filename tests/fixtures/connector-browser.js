// Browser integration fixture: no Telegram or external network, synthetic owner only.
import { startAgentConnection } from '../../src/modules/agent-connection.js';
let agent;
const app = await startAgentConnection({ port:8788,
 fetchImpl: async (_url, init) => {
  const p=JSON.parse(init.body);
  if(p.action){if(p.action.type==='approveAgent')agent=p.action.agentAddress;return new Response(JSON.stringify({status:'ok',response:{type:'default'}}));}
  return new Response(JSON.stringify(p.type==='extraAgents'?[{address:agent,validUntil:Date.now()+86400000}]:0));
 },onConnected:async ({accountAddress,network})=>console.log(JSON.stringify({fixtureConnected:true,accountAddress,network})),
});
// Only the test server injects a synthetic provider. Production assets have none.
const { readFile } = await import('node:fs/promises');
const realHandler = app.server.listeners('request')[0];
app.server.removeAllListeners('request');
app.server.on('request', async (req,res) => {
 if (req.url === '/') {
  const html = await readFile(new URL('../../src/connect-ui/index.html',import.meta.url),'utf8');
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'"});
  res.end(html.replace('<script src="/app.js"', '<script src="/fixture.js" defer></script><script src="/app.js"'));return;
 }
 if(req.url==='/fixture.js') {
  res.writeHead(200,{'Content-Type':'text/javascript'});
  res.end(`window.__qaErrors=[];window.addEventListener('error',e=>{window.__qaErrors.push(e.message);document.body.dataset.errors=JSON.stringify(window.__qaErrors);});
const wallet=new ethers.Wallet('0x'+'1'.padStart(64,'0'));
window.ethereum={request:async ({method,params})=>{
 if(method==='eth_chainId')return '0x66eee';
 if(method==='net_version')return '421614';
 if(method==='eth_requestAccounts'||method==='eth_accounts')return [wallet.address];
 if(method==='eth_signTypedData_v4'){const t=JSON.parse(params[1]);delete t.types.EIP712Domain;return wallet._signTypedData(t.domain,t.types,t.message);}
 throw new Error('Unsupported synthetic RPC '+method);
}};document.body.dataset.qaProvider='ready';`);return;
 }
 return realHandler(req,res);
});
console.log(app.url);
process.once('SIGTERM',async()=>{await app.close();process.exit(0);});
process.once('SIGINT',async()=>{await app.close();process.exit(0);});
