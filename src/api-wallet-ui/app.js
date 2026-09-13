'use strict';
const $ = id => document.getElementById(id);
const copy = {
 ru: {
 title:'Сохранить API-кошелёк', intro:'Однократная настройка: бот сохраняет отдельный API-ключ в зашифрованном виде на компьютере, где запущен помощник. При обычном перезапуске вводить его заново не нужно.',
 helpTitle:'1. Создайте и разрешите API-кошелёк', links:'Откройте страницу API для нужной сети (в новой вкладке):',
 step1:'Выберите сеть. Для Testnet откройте https://app.hyperliquid-testnet.xyz/API, для Mainnet — https://app.hyperliquid.xyz/API. В форме ниже по умолчанию выбрана Testnet.',
 step2:'Нажмите Connect и подключите ОСНОВНОЙ (MAIN) кошелёк, на аккаунте которого находятся средства. Это владелец торгового аккаунта, а не API-кошелёк.',
 step3:'В разделе API wallet укажите отдельное имя для бота, например HIP4Bot, и нажмите Generate. Появятся отдельный адрес API-кошелька и его приватный ключ; это не адрес и не ключ основного кошелька.',
 step4:'Сразу скопируйте приватный ключ API-кошелька и сохраните в надёжном менеджере паролей. Не рассчитывайте, что интерфейс покажет его повторно. Никому не отправляйте ключ.',
 step5:'Авторизуйте именно сгенерированный адрес API-кошелька. Выберите срок действия в интерфейсе (Valid Until) и один раз подпишите разрешение в основном кошельке. Доступные сроки определяет Hyperliquid.',
 step6:'Проверьте таблицу авторизованных API-кошельков: имя, сгенерированный адрес и Valid Until должны соответствовать вашему новому кошельку и выбранной сети.',
 step7:'В форму ниже вставьте адрес ОСНОВНОГО владельца в поле MAIN и только приватный ключ API-кошелька в поле ключа. API-адрес — подписант для бота, MAIN-адрес — аккаунт со средствами. Никогда не вводите основной приватный ключ или seed-фразу. Средства на API-кошелёк не переводите.',
 step8:'Нажмите «Проверить», сверьте владельца, API-подписанта, сеть и срок, затем явно подтвердите сохранение. Разрешение действует до выбранного срока или отзыва, не бессрочно. Ежедневное подключение не требуется.',
 step9:'Чтобы отозвать доступ, удалите/отзовите API-кошелёк в той же таблице на странице API. Остановка бота не отзывает разрешение. После истечения срока создайте новый отдельный API-ключ, авторизуйте его и сохраните здесь заново; старый при необходимости отзовите.',
 risk:'API-кошелёк может торговать от имени основного аккаунта и потерять его средства в торговле, но не может выводить средства. Используйте отдельный ключ только для этого бота.',
 tunnel:'Помощник доступен локально. Если бот установлен на удалённом сервере, откройте форму через защищённый SSH-туннель к его локальному порту; localhost вашего компьютера сам по себе не ведёт на сервер. Не публикуйте порт или полную ссылку доступа.',
 formTitle:'2. Проверьте ключ и сохраните', network:'Сеть', owner:'Адрес ОСНОВНОГО владельца (MAIN)', ownerHelp:'Публичный адрес 0x… аккаунта со средствами, не адрес API-кошелька.', key:'Приватный ключ API-кошелька', keyHelp:'Только отдельный API-ключ. Поле очищается после проверки, при отмене и ошибке. Ключ не сохраняется в хранилище браузера.', show:'Показать ключ', hide:'Скрыть ключ', prepare:'Проверить', cancel:'Отмена', reviewTitle:'3. Проверьте данные перед сохранением', agent:'Адрес API-подписанта', until:'Разрешение действует до (Valid Until)', replacement:'Сохранение заменит ранее настроенный кошелёк бота.', previous:'Прежний владелец', newOwner:'Новый владелец', replaceConfirm:'Я подтверждаю замену ранее настроенного кошелька указанным новым.', consent:'Я проверил владельца, подписанта, сеть и срок. Разрешаю сохранить API-ключ для торговли ботом с риском потери средств.', save:'Сохранить API-кошелёк', savedTitle:'API-кошелёк сохранён', savedText:'Ключ сохранён в зашифрованной конфигурации бота на компьютере помощника и доступен после перезапуска. Разрешение Hyperliquid ограничено сроком и может быть отозвано.', finish1:'Закройте эту вкладку.', finish2:'В терминале помощника завершите его командой', finish3:'Затем в каталоге бота запустите', notRunning:'Сохранение не запускает Telegram-бота и не подтверждает его подключение или polling.', loading:'Проверка доступа к помощнику…', idle:'Заполните поля. Изменения сохранятся только после отдельного подтверждения.', checking:'Проверяем авторизацию API-кошелька…', ready:'Проверка завершена. Сверьте данные и подтвердите сохранение.', saving:'Сохраняем. Не закрывайте страницу до результата.', changed:'Данные изменились. Предыдущая проверка отменена; проверьте ключ заново.', cancelled:'Проверка отменена, поле ключа очищено. Это не отзывает разрешение в Hyperliquid.', error:'Проверка не выполнена. Проверьте сеть, MAIN-адрес, API-ключ и действующее разрешение в таблице API. Введите ключ заново. При недоступности помощника откройте новую ссылку npm run connect.', saveError:'Не удалось подтвердить сохранение. Не повторяйте его вслепую: закройте помощник и запустите npm run connect заново, чтобы проверить текущую конфигурацию.', noToken:'Откройте полную ссылку доступа, выданную командой npm run connect. Эта вкладка не имеет доступа к помощнику.'
 },
 en: {
 title:'Save an API wallet', intro:'One-time setup: the bot saves a dedicated API key encrypted on the computer running this helper. Normal restarts do not require entering it again.',
 helpTitle:'1. Create and authorize an API wallet', links:'Open the API page for your network (new tab):',
 step1:'Choose your network. For Testnet use https://app.hyperliquid-testnet.xyz/API; for Mainnet use https://app.hyperliquid.xyz/API. The form below defaults to Testnet.',
 step2:'Click Connect and connect your MAIN wallet whose account holds the funds. This is the trading account owner, not the API wallet.',
 step3:'In API wallet, enter a dedicated name such as HIP4Bot and click Generate. This generates a separate API wallet address and private key, not your main wallet address or key.',
 step4:'Immediately copy the API wallet private key and store it in a secure password manager. Do not assume the interface will display it again. Never share this key.',
 step5:'Authorize the generated API wallet address. Choose the expiry in the interface (Valid Until) and sign the approval once in your main wallet. Hyperliquid determines the available expiry options.',
 step6:'Check the authorized API wallets table: the name, generated address and Valid Until must match your new wallet and chosen network.',
 step7:'In the form below, enter the MAIN owner address and only the API wallet private key. The API address is the bot signer; the MAIN address is the account holding funds. Never enter your main private key or seed phrase. Do not send funds to the API wallet.',
 step8:'Click Check, review the owner, API signer, network and expiry, then explicitly confirm saving. Approval persists until expiry or revocation, not indefinitely. Daily reconnection is unnecessary.',
 step9:'Revoke access in the same API wallet list on the API page. Stopping the bot does not revoke approval. After expiry, create a new dedicated API key, authorize it and save it here again; revoke the old key if needed.',
 risk:'An API wallet can trade on behalf of the main account and lose its funds through trading, but cannot withdraw funds. Use a dedicated key only for this bot.',
 tunnel:'This helper is local. If the bot runs on a remote server, use a secure SSH tunnel to its local port; localhost on your computer does not reach the server by itself. Never publish the port or full access link.',
 formTitle:'2. Check and save the key', network:'Network', owner:'MAIN owner address', ownerHelp:'Public 0x… address of the account holding funds, not the API wallet address.', key:'API wallet private key', keyHelp:'Only the dedicated API key. The field is cleared after checking, on cancellation and on error. The key is not saved in browser storage.', show:'Show key', hide:'Hide key', prepare:'Check', cancel:'Cancel', reviewTitle:'3. Review before saving', agent:'API signer address', until:'Approval expires (Valid Until)', replacement:'Saving will replace the previously configured bot wallet.', previous:'Previous owner', newOwner:'New owner', replaceConfirm:'I explicitly confirm replacing the previously configured wallet with this new one.', consent:'I checked the owner, signer, network and expiry. I authorize saving this API key for bot trading, including the risk of losing funds.', save:'Save API wallet', savedTitle:'API wallet saved', savedText:'The key is saved in the bot’s encrypted configuration on the helper computer and is available after restart. Hyperliquid approval is limited by expiry and can be revoked.', finish1:'Close this tab.', finish2:'In the helper terminal, stop it with', finish3:'Then, in the bot directory, run', notRunning:'Saving does not start the Telegram bot or confirm a connection or polling.', loading:'Checking helper access…', idle:'Fill in the fields. Nothing is saved until you explicitly confirm.', checking:'Checking API wallet authorization…', ready:'Check complete. Review the details and confirm saving.', saving:'Saving. Keep this page open until the result appears.', changed:'Details changed. The previous review was invalidated; check the key again.', cancelled:'Check cancelled and key field cleared. This does not revoke approval in Hyperliquid.', error:'Check failed. Verify the network, MAIN address, API key and active approval in the API table. Enter the key again. If the helper is unavailable, open a fresh npm run connect link.', saveError:'Saving could not be confirmed. Do not retry blindly: close the helper and run npm run connect again to check the current configuration.', noToken:'Open the full access link printed by npm run connect. This tab does not have access to the helper.'
 }
};
let token = location.hash.slice(1);
history.replaceState(null, '', location.pathname + location.search);
let prepared = null;
let busy = null;
let controller = null;
let revision = 0;
let available = false;
let finished = false;
let uncertainSave = false;
let statusKey = 'loading';
const tr = key => copy[$('language').value][key];
function status(key) { statusKey = key; $('status').textContent = tr(key); }
function clearKey() { $('private-key').value = ''; $('private-key').type = 'password'; $('show-key').setAttribute('aria-pressed', 'false'); $('show-key').textContent = tr('show'); }
function discard() { prepared = null; $('review').hidden = true; $('consent').checked = false; $('replace-confirm').checked = false; }
function matches() { return prepared && prepared.accountAddress.toLowerCase() === $('account-address').value.trim().toLowerCase() && prepared.network === $('network').value; }
function controls() {
 const locked = finished || uncertainSave || busy === 'save';
 for (const id of ['network', 'account-address']) $(id).disabled = locked;
 for (const id of ['private-key', 'show-key']) $(id).disabled = locked || Boolean(busy);
 $('prepare').disabled = locked || Boolean(busy) || !available;
 $('cancel').disabled = locked;
 $('save').disabled = locked || Boolean(busy) || !matches() || !$('consent').checked || (prepared?.replacing && !$('replace-confirm').checked);
 $('wallet-form').setAttribute('aria-busy', String(Boolean(busy)));
}
function invalidate() {
 revision++; controller?.abort(); discard(); clearKey(); status('changed'); controls();
}
async function api(path, body, signal) {
 const response = await fetch(path, {method: body === undefined ? 'GET' : 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type':'application/json'}, cache:'no-store', signal, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
 if (!response.ok) throw new Error('Request failed');
 return response.json();
}
function render() {
 document.documentElement.lang = $('language').value;
 document.title = `${tr('title')} · HIP4 Bot`;
 for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = tr(node.dataset.i18n);
 $('show-key').textContent = tr($('private-key').type === 'password' ? 'show' : 'hide');
 if (prepared) $('review-until').textContent = new Date(prepared.validUntil).toLocaleString($('language').value);
 status(statusKey);
}
$('language').addEventListener('change', render);
$('show-key').addEventListener('click', () => {
 const show = $('private-key').type === 'password'; $('private-key').type = show ? 'text' : 'password';
 $('show-key').setAttribute('aria-pressed', String(show)); $('show-key').textContent = tr(show ? 'hide' : 'show');
});
$('network').addEventListener('change', invalidate);
$('account-address').addEventListener('input', invalidate);
$('private-key').addEventListener('input', () => { discard(); controls(); });
$('cancel').addEventListener('click', () => {
 if (busy === 'save' || finished || uncertainSave) return;
 revision++; controller?.abort(); discard(); clearKey(); status('cancelled'); controls();
});
$('consent').addEventListener('change', controls);
$('replace-confirm').addEventListener('change', controls);
$('wallet-form').addEventListener('submit', async event => {
 event.preventDefault();
 if (busy || finished || uncertainSave || !available) return;
 discard(); busy = 'prepare'; const currentRevision = ++revision; controller = new AbortController();
 const body = {accountAddress:$('account-address').value.trim(), privateKey:$('private-key').value.trim(), network:$('network').value};
 controls(); status('checking');
 try {
 const pending = api('/api/prepare', body, controller.signal);
 body.privateKey = ''; clearKey();
 const data = await pending;
 if (revision !== currentRevision) return;
 if (!data.id || !/^0x[0-9a-fA-F]{40}$/.test(data.accountAddress) || !/^0x[0-9a-fA-F]{40}$/.test(data.agentAddress) || !Number.isFinite(new Date(data.validUntil).getTime()) || new Date(data.validUntil).getTime() <= Date.now() || data.network !== body.network || data.accountAddress.toLowerCase() !== body.accountAddress.toLowerCase() || (data.replacing && !/^0x[0-9a-fA-F]{40}$/.test(data.previousAccountAddress))) throw new Error('Invalid review');
 prepared = data;
 $('review-network').textContent = data.network;
 $('review-owner').textContent = data.accountAddress;
 $('review-agent').textContent = data.agentAddress;
 $('review-until').textContent = new Date(data.validUntil).toLocaleString($('language').value);
 $('replacement').hidden = !data.replacing;
 $('previous-owner').textContent = data.previousAccountAddress || '';
 $('new-owner').textContent = data.accountAddress;
 $('review').hidden = false; status('ready'); $('review-title').focus();
 } catch { if (revision === currentRevision) { discard(); status('error'); } }
 finally { body.privateKey = ''; clearKey(); busy = null; controller = null; controls(); }
});
$('save').addEventListener('click', async () => {
 if (busy || finished || uncertainSave || !matches() || !$('consent').checked || (prepared.replacing && !$('replace-confirm').checked)) return;
 if (new Date(prepared.validUntil).getTime() <= Date.now()) { invalidate(); return; }
 busy = 'save'; controls(); status('saving');
 try {
 const result = await api('/api/save', {id:prepared.id, confirm:true});
 if (result.saved !== true) throw new Error('Save not confirmed');
 finished = true; token = ''; discard(); $('wallet-form').hidden = true; $('saved').hidden = false; status('savedTitle'); $('status').focus();
 } catch { uncertainSave = true; discard(); status('saveError'); $('status').focus(); }
 finally { clearKey(); busy = null; controls(); }
});
window.addEventListener('pagehide', () => { revision++; controller?.abort(); clearKey(); discard(); token = ''; });
render(); controls();
async function initialize() {
 if (!token) { status('noToken'); return; }
 busy = 'session'; controls();
 try { await api('/api/session'); available = true; status('idle'); }
 catch { clearKey(); status('noToken'); }
 finally { busy = null; controls(); }
}
void initialize();
