/**
 * Wallet / Security feature for HIP-4 Telegram bot.
 *
 * Provides:
 *   - Show wallet address & balance
 *   - Export private key (with auto-delete after 90 s)
 *   - Initialize wallet
 */

import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { getDecryptedPrivateKey, initializeWallet } from '../../auth.js';
import { createContext, safeLogError, safeLogWarn } from '../../logger.js';
import { busyLocks, userStates, hlClient } from '../runtime.js';
import { mainMenuKeyboard, getMainMenuKeyboard } from '../ui/keyboards.js';

// ─── Show wallet info (/wallet command) ─────────────────────────

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

  // Fetch balance if hlClient is available
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
      // balance unavailable
    }
  }

  const text =
    `Wallet\n\n` +
    `Address: ${config.walletAddress}` +
    balanceText +
    `\nNetwork: ${config.hlNetwork || 'testnet'}`;

  const keyboard = new InlineKeyboard()
    .text(t('settings_export_pk') || 'Export Key', 'start_export_pk')
    .row()
    .text(t('back') || 'Back', 'back_menu');

  try {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  } catch {
    await ctx.reply(text, { reply_markup: keyboard });
  }
}

// ─── Callback dispatcher ────────────────────────────────────────

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

  // Fallback
  await showWalletInfo(ctx);
}

// ─── Init wallet ────────────────────────────────────────────────

async function handleInitWallet(ctx) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');
  const chatId = ctx.chat.id;

  busyLocks.set(chatId, true);
  try {
    try { await ctx.editMessageText(t('loading')); } catch {}

    const result = await initializeWallet();

    await ctx.editMessageText(result.warning, {
      reply_markup: await getMainMenuKeyboard(config.language || 'en'),
    });
  } catch (error) {
    const logCtx = createContext('security', 'handleInitWallet');
    safeLogError(logCtx, error);
    try {
      await ctx.editMessageText(t('error_generic'), {
        reply_markup: new InlineKeyboard()
          .text(t('try_again') || 'Try Again', 'init_wallet')
          .text(t('back') || 'Back', 'back_menu'),
      });
    } catch {}
  } finally {
    busyLocks.delete(chatId);
  }
}

// ─── Export private key ─────────────────────────────────────────

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

/**
 * Handle the confirmation text input for export.
 * Exported so text-router can call it directly.
 */
export async function handleExportConfirmation(ctx, state, text) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');
  const chatId = ctx.chat.id;

  // Delete confirmation message immediately for security
  try {
    await ctx.api.deleteMessage(chatId, ctx.message.message_id);
  } catch (e) {
    const logCtx = createContext('security', 'handleExportConfirmation');
    safeLogWarn(logCtx, 'Failed to delete confirmation message', { error: e?.message });
  }

  try {
    const confirmationText = String(text || '').trim();
    if (confirmationText !== 'confirm') {
      userStates.delete(chatId);
      busyLocks.delete(chatId);
      await ctx.reply(t('export_pk_invalid_password'), {
        reply_markup: await getMainMenuKeyboard(config.language || 'en'),
      });
      return;
    }

    const privateKey = await getDecryptedPrivateKey();

    const messageText = t('export_pk_sent_will_delete', { privateKey });
    const sentMessage = await ctx.reply(messageText, { parse_mode: 'HTML' });

    userStates.delete(chatId);
    busyLocks.delete(chatId);

    // Auto-delete after 90 s
    setTimeout(async () => {
      try {
        await ctx.api.deleteMessage(chatId, sentMessage.message_id);
      } catch (e2) {
        const logCtx = createContext('security', 'autoDeleteExportMessage');
        safeLogWarn(logCtx, 'Failed to auto-delete', { error: e2?.message });
      }
    }, 90_000);

    // Delete warning message too
    if (state.warningMessageId) {
      setTimeout(async () => {
        try { await ctx.api.deleteMessage(chatId, state.warningMessageId); } catch {}
      }, 1000);
    }
  } catch (error) {
    const logCtx = createContext('security', 'handleExportConfirmation');
    safeLogError(logCtx, error);
    userStates.delete(chatId);
    busyLocks.delete(chatId);
    await ctx.reply(t('error_generic'), {
      reply_markup: await getMainMenuKeyboard(config.language || 'en'),
    });
  }
}
