/* Owner signs through an injected EIP-1193 wallet; no secret input or remote script. */
const $ = id => document.getElementById(id);
const strings = {
 ru: {title:'Подключить Hyperliquid',intro:'Основной приватный ключ остаётся в вашем кошельке. Бот получает отдельное разрешение на торговлю на 24 часа.',risk:'Агент может размещать и отменять ордера: торговля может привести к убыткам. Переводы и вывод средств выполняйте в Hyperliquid своим кошельком.',network:'Сеть',builder:'Добавлять Outcome builder code, комиссия 0',rewards:'Это отдельное разрешение кошелька. Код не гарантирует награды: действуют правила кампании и ограничения допустимых интерфейсов.',connect:'Подключить кошелёк',review:'Проверить разрешение',owner:'Ваш аккаунт',agent:'Агент бота',expires:'Действует до',consent:'Разрешаю этому агенту торговать на выбранном аккаунте и в выбранной сети.',approve:'Подписать разрешение',cancel:'Отмена',ephemeral:'Ключ агента хранится только в памяти процесса. После остановки требуется повторное подключение. Остановка бота не отзывает разрешение: отзовите HIP4 Bot в управлении API-кошельками Hyperliquid.',noWallet:'Не найден кошелёк. Откройте страницу в браузере с Rabby, MetaMask или другим совместимым кошельком.',noToken:'Откройте полную локальную ссылку, напечатанную командой npm run connect:temporary.',ready:'Проверьте аккаунт, сеть и разрешение ниже.',needConsent:'Подтвердите согласие на торговлю.',changed:'Аккаунт или параметры изменились. Подключите кошелёк заново.',signing:'Подтвердите разрешение в кошельке. Основной приватный ключ не передаётся.',success:'Аккаунт подключён. Откройте личный чат с вашим Telegram-ботом и отправьте /start. Переводы и вывод — через основной кошелёк.',cancelled:'Подключение отменено. Если вы уже подписали разрешение, проверьте и отзовите его в Hyperliquid.',busy:'Подключение…'},
 en: {title:'Connect Hyperliquid',intro:'Your main private key stays in your wallet. The bot receives a separate trading approval for 24 hours.',risk:'The agent can place and cancel orders: trading can lose funds. Make transfers and withdrawals with your own wallet in Hyperliquid.',network:'Network',builder:'Include Outcome builder code, zero builder fee',rewards:'This requires a separate wallet approval. Attribution does not guarantee rewards: campaign and eligible-interface restrictions apply.',connect:'Connect wallet',review:'Review approval',owner:'Your account',agent:'Bot agent',expires:'Expires at',consent:'I authorize this agent to trade on the selected account and network.',approve:'Sign approval',cancel:'Cancel',ephemeral:'The agent key is held only in process memory. Reconnect after stopping. Stopping the bot does not revoke approval: revoke HIP4 Bot in Hyperliquid API wallet management.',noWallet:'No wallet found. Open this page in a browser with Rabby, MetaMask or another compatible injected wallet.',noToken:'Open the full local link printed by npm run connect:temporary.',ready:'Review the account, network and permissions below.',needConsent:'Confirm trading consent first.',changed:'Account or settings changed. Connect the wallet again.',signing:'Confirm in your wallet. Your main private key is not sent.',success:'Connected. Open your Telegram bot in a private chat and send /start. Transfers and withdrawals use your main wallet.',cancelled:'Connection cancelled. If already signed, check and revoke approval in Hyperliquid.',busy:'Connecting…'}
};
let token = location.hash.slice(1); history.replaceState(null,'',location.pathname);
let prepared; let provider; let busy = false;
const tr = key => strings[$('language').value][key];
function status(text) { $('status').textContent = text; }
function reset() { prepared = null; $('review').hidden = true; $('consent').checked = false; }
function setBusy(value) { busy=value; for(const id of ['connect','approve','network','builder','cancel']) $(id).disabled=value; }
async function api(path, body) {
 const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const data=await r.json();if(!r.ok)throw new Error(data.error||`HTTP ${r.status}`);return data;
}
$('language').onchange=()=>{document.documentElement.lang=$('language').value;for(const el of document.querySelectorAll('[data-i18n]'))el.textContent=tr(el.dataset.i18n);};
$('network').onchange=reset; $('builder').onchange=reset;
$('cancel').onclick=()=>{if(!busy){reset();status(tr('cancelled'));}};
$('connect').onclick=async()=>{
 if(busy)return;reset();setBusy(true);
 try {if(!token)throw new Error(tr('noToken'));if(!window.ethereum)throw new Error(tr('noWallet'));
 status(tr('busy'));provider=new ethers.providers.Web3Provider(window.ethereum,'any');await provider.send('eth_requestAccounts',[]);
 const address=await provider.getSigner().getAddress();prepared=await api('/api/prepare',{address,network:$('network').value,builderEnabled:$('builder').checked});
 $('owner').textContent=prepared.accountAddress;$('agent').textContent=prepared.agentAddress;$('review-network').textContent=prepared.network;
 $('expires').textContent=new Date(prepared.expiresAt).toLocaleString();$('review').hidden=false;status(tr('ready'));$('consent').focus();
 }catch(e){status(e.message||String(e));}finally{setBusy(false);}
};
$('approve').onclick=async()=>{
 if(busy||!prepared)return;if(!$('consent').checked){status(tr('needConsent'));return;}setBusy(true);
 try {const current=prepared;const signer=provider.getSigner();const address=await signer.getAddress();
 if(address.toLowerCase()!==current.accountAddress.toLowerCase()||$('network').value!==current.network)throw new Error(tr('changed'));
 status(tr('signing'));const signatures=[];
 for(const a of current.approvals)signatures.push(await signer._signTypedData(a.domain,a.types,a.message));
 await api('/api/complete',{id:current.id,signatures});reset();status(tr('success'));$('status').focus();$('connect').hidden=true;
 }catch(e){reset();status((e.message||String(e))+' '+tr('cancelled'));}finally{setBusy(false);}
};
if(!token)status(tr('noToken'));
