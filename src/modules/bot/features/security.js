/**
 * Wallet / Security feature for HIP-4 Telegram bot.
 */

import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { getDecryptedPrivateKey, initializeWallet } from '../../auth.js';
import { createContext, safeLogError, safeLogInfo } from '../../logger.js';
import { HLClient } from '../../hyperliquid.js';
import { busyLocks, userStates, hlClient, setHLClient } from '../runtime.js';
import { getMainMenuKeyboard } from '../ui/keyboards.js';

export async function showWalletInfo(ctx) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');

  if (!config.walletAddress) {
    const keyboard = new InlineKeyboard()
      .text(t('settings_init_wallet') || 'Init Wallet', 'init_wallet')
      .row()
      .text(t('back') || 'Back', 'back_menu');

    const text = t('error_no_wallet') || 'Wallet not configured.';
    try {
      await ctx.editMessageText(text, { reply_markup: keyboard });
    } catch {
      await ctx.reply(text, { reply_markup: keyboard });
    }
    return;
  }

  let balanceText = '';
  if (hlClient) {
    try {
      const balances = await hlClient.getUserBalances(config.walletAddress);
      const usdcEntry = (balances?.balances || []).find(
        (b) => b.coin === 'USDC' || b.coin === 'USD',
      );
      const usdcBalance = usdcEntry ? parseFloat(usdcEntry.total || '0') : null;
      if (usdcBalance !== null) {
        balanceText = `\nBalance: $${usdcBalance.toFixed(2)} USDC`;
      }
    } catch {
      balanceText = '\nBalance: unavailable';
    }
  }

  const text =
    `Wallet\n\n` +
    `Address:\n<code>${config.walletAddress}</code>` +
    balanceText +
    `\nNetwork: ${config.hlNetwork || 'testnet'}`;

  const keyboard = new InlineKeyboard()
    .text(t('settings_export_pk') || 'Export Key', 'start_export_pk')
    .row()
    .text(t('back') || 'Back', 'back_menu');

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

export async function handleWalletCallback(ctx, data) {
  if (data === 'wallet') {
    await showWalletInfo(ctx);
    return;
  }

  if (data === 'init_wallet') {
    await handleInitWallet(ctx);
    return;
  }

  if (data === 'start_export_pk') {
    await handleStartExportPk(ctx);
    return;
  }

  if (data === 'confirm_export_pk') {
    await handleConfirmExportPk(ctx);
    return;
  }

  if (data === 'cancel_export_pk') {
    await handleCancelExportPk(ctx);
    return;
  }

  await showWalletInfo(ctx);
}

async function handleInitWallet(ctx) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');
  const chatId = ctx.chat.id;

  busyLocks.set(chatId, true);
  try {
    try { await ctx.editMessageText(t('loading') || 'Creating wallet...'); } catch {}

    const result = await initializeWallet();

    try {
      const privateKey = await getDecryptedPrivateKey();
      const updatedConfig = await loadConfig();
      const network = updatedConfig.hlNetwork || 'testnet';
      const client = await HLClient.create(privateKey, network);
      setHLClient(client);
      const logCtx = createContext('security', 'handleInitWallet');
      safeLogInfo(logCtx, 'HLClient initialised after wallet creation', { network });
    } catch (hlErr) {
      const logCtx = createContext('security', 'handleInitWallet');
      safeLogError(logCtx, hlErr, { stage: 'hlClientInit' });
    }

    const text = result.warning + '\n\nWallet created! You can now browse markets and trade.';

    await ctx.editMessageText(text, {
      reply_markup: await getMainMenuKeyboard(config.language || 'en'),
    });
  } catch (error) {
    const logCtx = createContext('security', 'handleInitWallet');
    safeLogError(logCtx, error);
    try {
      await ctx.editMessageText(t('error_generic') || 'Error occurred.', {
        reply_markup: new InlineKeyboard()
          .text(t('try_again') || 'Try Again', 'init_wallet')
          .text(t('back') || 'Back', 'back_menu'),
      });
    } catch {}
  } finally {
    busyLocks.delete(chatId);
  }
}

async function handleStartExportPk(ctx) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');

  if (!config.walletAddress) {
    await ctx.editMessageText(t('export_pk_wallet_missing'), {
      reply_markup: new InlineKeyboard().text(t('back'), 'settings'),
    });
    return;
  }

  const keyboard = new InlineKeyboard()
    .text(t('export_pk_confirm'), 'confirm_export_pk')
    .text(t('export_pk_cancel'), 'cancel_export_pk');

  await ctx.editMessageText(t('export_pk_warning'), { reply_markup: keyboard });
}

async function handleConfirmExportPk(ctx) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');
  const chatId = ctx.chat.id;

  if (busyLocks.get(chatId)) {
    try { await ctx.answerCallbackQuery(t('error_busy')); } catch {}
    return;
  }

  busyLocks.set(chatId, true);

  try {
    userStates.set(chatId, {
      state: 'AWAITING_EXPORT_CONFIRMATION',
      warningMessageId: ctx.callbackQuery?.message?.message_id,
    });

    await ctx.editMessageText(t('export_pk_enter_password'), {
      reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel_export_pk'),
    });
  } catch (error) {
    const logCtx = createContext('security', 'handleConfirmExportPk');
    safeLogError(logCtx, error);
    busyLocks.delete(chatId);
    userStates.delete(chatId);
    try {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'settings'),
      });
    } catch {}
  }
}

async function handleCancelExportPk(ctx) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');
  const chatId = ctx.chat.id;

  userStates.delete(chatId);
  busyLocks.delete(chatId);

  await ctx.editMessageText(t('cancel'), {
    reply_markup: await getMainMenuKeyboard(config.language || 'en'),
  });
}

export async function handleExportConfirmation(ctx, state, text) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');
  const chatId = ctx.chat.id;

  try {
    const privateKey = await getDecryptedPrivateKey(text);
    if (!privateKey) {
      await ctx.reply(t('error_generic') || 'Could not export private key.');
      return;
    }

    userStates.delete(chatId);
    busyLocks.delete(chatId);

    await ctx.reply(`<code>${privateKey}</code>`, { parse_mode: 'HTML' });
    await ctx.reply(t('warning_exported_pk') || 'Private key exported. Delete this message after saving it securely.', {
      reply_markup: await getMainMenuKeyboard(config.language || 'en'),
    });
  } catch (error) {
    const logCtx = createContext('security', 'handleExportConfirmation');
    safeLogError(logCtx, error, { state });
    userStates.delete(chatId);
    busyLocks.delete(chatId);
    await ctx.reply(t('error_generic') || 'Could not export private key.', {
      reply_markup: await getMainMenuKeyboard(config.language || 'en'),
    });
  }
}
