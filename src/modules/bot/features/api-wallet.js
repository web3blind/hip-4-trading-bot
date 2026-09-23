import { InlineKeyboard } from 'grammy';
import { isDeepStrictEqual } from 'node:util';
import { loadConfig, saveConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { saveApiWalletConnection } from '../../api-wallet-store.js';
import { outcomeBuilderStatusKey } from '../../outcome-builder.js';
import { userStates, runtimeGeneration, runtimeBinding, runtimeTransitioning, busyLocks, hlClient, isAuthorizedPrivateContext, activateHLClient, createConfiguredHLClient } from '../runtime.js';

const TTL = 5 * 60_000;
const copy = (s, en, ru) => s.language === 'ru' ? ru : en;
const active = s => s?.state?.startsWith('API_WALLET_');
const valid = s => active(s) && s.expiresAt > Date.now() && s.binding === runtimeBinding() && s.generation === runtimeGeneration;
const secretLike = text => /(?:0x)?[a-fA-F0-9]{64}/.test(text);
async function display(ctx, text, keyboard) {
  const extra = { reply_markup: keyboard };
  try { await ctx.editMessageText(text, extra); } catch { await ctx.reply(text, extra); }
}
async function keyboard(s) {
  const t = await getTranslator(s.language);
  return new InlineKeyboard().text(t('api_setup_owner_button'), 'wallet:api_owner').row()
    .text(t('api_setup_key_button'), 'wallet:api_key').row()
    .text(`Network: ${s.network}`, 'wallet:api_network').row()
    .text(copy(s, 'Help', 'Инструкция'), 'wallet:api_help').row()
    .text(t('back'), 'wallet');
}
export function isApiWalletStep(data) { return /^wallet:api_(owner|key|network|help)$/.test(data); }
export async function handleApiWalletCallback(ctx, data) {
  if (!isAuthorizedPrivateContext(ctx)) return;
  const config = await loadConfig();
  let s = userStates.get(ctx.chat.id);
  if (data === 'wallet:connect_api') {
    s = { state: 'API_WALLET_MENU', owner: config.walletAddress || '', network: config.hlNetwork || 'testnet', language: config.language || 'en', binding: runtimeBinding(), generation: runtimeGeneration, expectedConfig: config, expiresAt: Date.now() + TTL };
    userStates.set(ctx.chat.id, s);
  } else if (!valid(s) || !isDeepStrictEqual(config, s.expectedConfig)) {
    userStates.delete(ctx.chat.id);
    await ctx.reply(copy({ language: config.language }, 'Setup expired. Open Connect API wallet again.', 'Настройка устарела. Откройте подключение API-кошелька заново.'));
    return;
  }
  if (data === 'wallet:api_help') {
    const t = await getTranslator(s.language);
    await display(ctx, t('api_wallet_help'), await keyboard(s)); return;
  }
  if (data === 'wallet:api_network') s.network = s.network === 'testnet' ? 'mainnet' : 'testnet';
  if (data === 'wallet:api_owner') {
    s.state = 'API_WALLET_OWNER';
    await display(ctx, copy(s, 'Send your MAIN wallet public address (0x…). Not the API wallet address.', 'Отправьте публичный адрес ОСНОВНОГО кошелька (0x…). Не адрес API-кошелька.'), await keyboard(s)); return;
  }
  if (data === 'wallet:api_key') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(s.owner)) {
      await ctx.reply(copy(s, 'First enter your MAIN wallet using Wallet.', 'Сначала укажите ОСНОВНОЙ адрес кнопкой «Кошелёк».')); return;
    }
    s.state = 'API_WALLET_KEY';
    // Snapshot exactly what was reviewed, not a reloaded config at submission.
    s.expectedConfig = config;
    const replacing = !!(config.walletAddress || config.encrypted?.privateKey);
    const text = copy(s, `MAIN wallet: ${s.owner}\nNetwork: ${s.network}\n`, `ОСНОВНОЙ кошелёк: ${s.owner}\nСеть: ${s.network}\n`) +
      (replacing ? copy(s, '\nThis replaces the saved connection. An encrypted backup will be kept.\n', '\nЭто заменит сохранённое подключение. Будет создана зашифрованная резервная копия.\n') : '') +
      copy(s, '\nSend only the dedicated API wallet private key, never your MAIN wallet key. Sending it confirms saving and activation. I will delete the message first. Telegram bot chats are not end-to-end encrypted.', '\nОтправьте только приватный ключ отдельного API-кошелька, не основного. Отправка подтверждает сохранение и активацию. Сначала я удалю сообщение. В чатах с ботами Telegram нет сквозного шифрования.');
    await display(ctx, text, await keyboard(s)); return;
  }
  s.state = 'API_WALLET_MENU';
  await display(ctx, copy(s, `Connect API wallet\nMAIN wallet: ${s.owner || 'not set'}\nNetwork: ${s.network}`, `Подключение API-кошелька\nОСНОВНОЙ кошелёк: ${s.owner || 'не указан'}\nСеть: ${s.network}`), await keyboard(s));
}

/** First middleware: no config reads, logging, commands or rate limiter see a secret. */
export async function interceptApiWalletInput(ctx, next) {
  if (!isAuthorizedPrivateContext(ctx) || typeof ctx.message?.text !== 'string') return next();
  const s = userStates.get(ctx.chat.id);
  const text = ctx.message.text;
  const secret = s?.state === 'API_WALLET_KEY' || s?.state === 'API_WALLET_SAVING' || secretLike(text);
  if (!secret && s?.state !== 'API_WALLET_OWNER') return next();
  // Claim once synchronously; duplicate messages still take the deletion path.
  const claimed = s?.state === 'API_WALLET_KEY';
  if (claimed) s.state = 'API_WALLET_SAVING';
  if (secret) {
    ctx.message.text = '[removed]';
    try {
      if (await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id) !== true) throw new Error('Deletion not confirmed');
    }
    catch {
      if (claimed) userStates.delete(ctx.chat.id);
      try { await ctx.reply(copy(s || {}, 'Could not delete the message. Nothing saved. Delete it manually and revoke that API key before retrying.', 'Не удалось удалить сообщение. Ничего не сохранено. Удалите его вручную и отзовите этот API-ключ перед повторной попыткой.')); } catch {}
      return;
    }
    if (!claimed) return;
  }
  try {
    if (!valid(s) || runtimeTransitioning || busyLocks.get(ctx.chat.id) || userStates.get(ctx.chat.id) !== s || !isDeepStrictEqual(await loadConfig(), s.expectedConfig)) throw new Error('Expired');
    if (!secret) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(text)) {
        await ctx.reply(copy(s, 'Invalid MAIN address. Send exactly 0x plus 40 hexadecimal characters.', 'Некорректный ОСНОВНОЙ адрес. Нужно 0x и 40 шестнадцатеричных символов.')); return;
      }
      s.owner = text; s.state = 'API_WALLET_MENU';
      await display(ctx, copy(s, `MAIN wallet: ${s.owner}\nNow choose Private key.`, `ОСНОВНОЙ кошелёк: ${s.owner}\nТеперь нажмите «Приватник».`), await keyboard(s)); return;
    }
    if (!/^(0x)?[a-fA-F0-9]{64}$/.test(text)) throw new Error('Invalid key');
    busyLocks.set(ctx.chat.id, true);
    let activationAttempted = false;
    try {
      await saveApiWalletConnection({ accountAddress: s.owner, privateKey: text, network: s.network, expectedConfig: s.expectedConfig,
        persist: async saved => {
          const client = await createConfiguredHLClient(saved);
          if (!valid(s) || userStates.get(ctx.chat.id) !== s || !isDeepStrictEqual(await loadConfig(), s.expectedConfig)) throw new Error('Expired');
          // No await gap: activation reserves the shared transition synchronously.
          busyLocks.delete(ctx.chat.id);
          activationAttempted = true;
          await activateHLClient(client, { persist: () => saveConfig(saved) });
          // Keep updates blocked until encrypted disk read-back is verified too.
          busyLocks.set(ctx.chat.id, true);
        },
      });
    } catch {
      if (activationAttempted) {
        busyLocks.delete(ctx.chat.id);
        try { await activateHLClient(null); } catch {}
      }
      throw new Error('Connection failed');
    } finally { busyLocks.delete(ctx.chat.id); }
    try {
      const t = await getTranslator(s.language);
      const status = outcomeBuilderStatusKey(hlClient?.outcomeBuilderStatus);
      await ctx.reply(`${copy(s, 'API wallet saved and connected.', 'API-кошелёк сохранён и подключён.')}\n${t(status)}`);
    } catch {}
  } catch {
    // Never propagate an SDK/Telegram error that may contain input or the update.
    userStates.delete(ctx.chat.id);
    try { await ctx.reply(copy(s || {}, 'Connection not activated. Check the MAIN address, network and API key authorization, then start again. If saving completed, the encrypted connection remains available for retry; trading is disabled on activation failure.', 'Подключение не активировано. Проверьте ОСНОВНОЙ адрес, сеть и разрешение API-ключа, затем начните заново. Если сохранение завершилось, зашифрованное подключение доступно для повтора; при ошибке активации торговля отключена.')); } catch {}
  }
}
