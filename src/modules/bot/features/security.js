/**
 * Wallet / Security feature for HIP-4 Telegram bot.
 */

import { InlineKeyboard } from 'grammy';
import { handleApiWalletCallback, isApiWalletStep } from './api-wallet.js';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { getDecryptedPrivateKey, initializeWallet } from '../../auth.js';
import { createContext, safeLogError, safeLogInfo } from '../../logger.js';
import { HLClient } from '../../hyperliquid.js';
import { busyLocks, userStates, hlClient, activateHLClient, createConfiguredHLClient, confirmationCallback, runtimeBinding, invalidateUserState, scheduleMessageDeletion, isAuthorizedPrivateContext } from '../runtime.js';
import { getMainMenuKeyboard } from '../ui/keyboards.js';
import { outcomeBuilderStatusKey } from '../../outcome-builder.js';

export async function showWalletInfo(ctx) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');

  if (!config.walletAddress) {
    const keyboard = new InlineKeyboard()
      .text(t('api_wallet_connect'), 'wallet:connect_api').row()
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

  let spotUsdc = 0;
  let perpUsdc = 0;
  let abstraction = null;
  let balanceText = '';
  let builderText = t('outcome_builder_unavailable');
  if (hlClient) {
    try {
      abstraction = await hlClient.getAccountAbstraction();
      spotUsdc = await hlClient.getSpotUsdcBalance();
      balanceText = `\n${t('spot_usdc')}: $${spotUsdc.toFixed(2)}`;
      if (['unifiedAccount', 'portfolioMargin'].includes(abstraction)) {
        balanceText += `\n${t('unified_outcome_funding')}`;
      } else {
        perpUsdc = await hlClient.getPerpBalance();
        balanceText += `\n${t('perp_usdc')}: $${perpUsdc.toFixed(2)}`;
      }
    } catch {
      balanceText = `\n${t('balance_unavailable')}`;
      abstraction = null;
    }
    const status = await hlClient.refreshOutcomeBuilderStatus();
    builderText = t(outcomeBuilderStatusKey(status.status));
  }

  const text =
    `${t('wallet_title')}\n\n` +
    `Address:\n<code>${config.walletAddress}</code>` +
    balanceText +
    `\n${t('network_label')}: ${config.hlNetwork || 'testnet'}` +
    `\n${builderText}`;

  const keyboard = new InlineKeyboard();
  keyboard.text(t('api_wallet_connect'), 'wallet:connect_api').row();
  if (config.authMode !== 'agent' && abstraction && !['unifiedAccount', 'portfolioMargin'].includes(abstraction) && spotUsdc > 0.01) {
    keyboard.text(`${t('transfer_to_perps')} ($${spotUsdc.toFixed(2)})`, 'wallet:fund_predictions').row();
  }
  const totalUsdc = spotUsdc + perpUsdc;
  if (config.authMode !== 'agent' && totalUsdc >= 1) {
    keyboard.text(t('withdraw_btn'), 'withdraw_start').row();
  }
  if (config.authMode !== 'agent') keyboard.text(t('settings_export_pk') || t('export_key'), 'start_export_pk').row();
  keyboard.text(t('back') || 'Back', 'back_menu');

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

export async function handleWalletCallback(ctx, data) {
  if (!isAuthorizedPrivateContext(ctx)) return;
  if (data === 'wallet:connect_api' || isApiWalletStep(data)) { await handleApiWalletCallback(ctx, data); return; }
  if (data === 'confirm_fund_predictions') { await executeFundPredictions(ctx); return; }
  if (data === 'wallet') {
    await showWalletInfo(ctx);
    return;
  }

  if (data === 'wallet:fund_predictions') {
    await handleFundPredictions(ctx);
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

async function handleFundPredictions(ctx) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');
  if (!hlClient || config.authMode === 'agent') {
    await ctx.editMessageText(t('owner_transfer_required')); return;
  }
  const mode = await hlClient.getAccountAbstraction();
  if (['unifiedAccount', 'portfolioMargin'].includes(mode)) {
    await ctx.editMessageText(t('unified_no_transfer')); return;
  }
  const amount = Math.floor((await hlClient.getSpotUsdcBalance()) * 100) / 100;
  if (!Number.isFinite(amount) || amount < 0.01) { await ctx.editMessageText(t('no_spot_usdc')); return; }
  const callback = confirmationCallback(ctx.chat.id, 'confirm_fund_predictions', { state: 'CONFIRMING_FUND_PREDICTIONS', amount });
  await ctx.editMessageText(`${t('transfer_to_perps')}: $${amount.toFixed(2)} USDC\n${t('network_label')}: ${hlClient.network}\n${config.walletAddress}`, {
    reply_markup: new InlineKeyboard().text(t('confirm'), callback).text(t('cancel'), 'wallet'),
  });
}
async function executeFundPredictions(ctx) {
  const state = userStates.get(ctx.chat.id);
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');
  if (state?.state !== 'CONFIRMING_FUND_PREDICTIONS' || !hlClient || config.authMode === 'agent') return;
  userStates.delete(ctx.chat.id);
  busyLocks.set(ctx.chat.id, true);
  try {
    const mode = await hlClient.getAccountAbstraction();
    if (['unifiedAccount', 'portfolioMargin'].includes(mode)) {
      await ctx.editMessageText(t('unified_no_transfer')); return;
    }
    await hlClient.transferUsdClass(state.amount, true);
    await ctx.editMessageText(`${t('transferred')}: $${state.amount.toFixed(2)} USDC`, { reply_markup: new InlineKeyboard().text(t('back'), 'wallet') });
  } finally { busyLocks.delete(ctx.chat.id); }
}

async function handleInitWallet(ctx) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');
  const chatId = ctx.chat.id;

  busyLocks.set(chatId, true);
  try {
    try { await ctx.editMessageText(t('creating_wallet')); } catch {}

    const result = await initializeWallet();

    try {
      const updatedConfig = await loadConfig();
      const network = updatedConfig.hlNetwork || 'testnet';
      const client = await createConfiguredHLClient(updatedConfig);
      // Setup is not a financial operation; activation drains workers itself.
      busyLocks.delete(chatId);
      await activateHLClient(client);
      const logCtx = createContext('security', 'handleInitWallet');
      safeLogInfo(logCtx, 'HLClient initialised after wallet creation', { network });
    } catch (hlErr) {
      const logCtx = createContext('security', 'handleInitWallet');
      safeLogError(logCtx, hlErr, { stage: 'hlClientInit' });
    }

    const text = result.warning + '\n\n' + t('wallet_created');

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
  if (config.authMode === 'agent' || !config.encrypted?.privateKey) {
    await ctx.editMessageText(t('export_pk_wallet_missing')); return;
  }
  const state = { state: 'EXPORT_REVIEW', binding: runtimeBinding(), expiresAt: Date.now() + 120000 };
  const callback = confirmationCallback(ctx.chat.id, 'confirm_export_pk', state);
  await ctx.editMessageText(t('export_pk_warning'), { reply_markup: new InlineKeyboard()
    .text(t('export_pk_confirm'), callback).text(t('cancel'), 'cancel_export_pk') });
}
async function handleConfirmExportPk(ctx) {
  const state = userStates.get(ctx.chat.id);
  if (state?.state !== 'EXPORT_REVIEW' || state.expiresAt <= Date.now() || state.binding !== runtimeBinding()) return;
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');
  const warningMessageId = ctx.callbackQuery?.message?.message_id;
  userStates.set(ctx.chat.id, { ...state, state: 'AWAITING_EXPORT_CONFIRMATION', warningMessageId });
  scheduleMessageDeletion(ctx, [warningMessageId], 120000);
  await ctx.editMessageText(t('export_pk_enter_password'), { reply_markup: new InlineKeyboard().text(t('cancel'), 'cancel_export_pk') });
}
async function handleCancelExportPk(ctx) {
  await invalidateUserState(ctx.chat.id);
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');
  await ctx.reply(t('cancel'), { reply_markup: await getMainMenuKeyboard(config.language || 'en') });
}
export async function handleExportConfirmation(ctx, state, text) {
  if (!isAuthorizedPrivateContext(ctx)) return;
  const chatId = ctx.chat.id;
  if (state !== userStates.get(chatId) || state?.state !== 'AWAITING_EXPORT_CONFIRMATION') return;
  // One attempt only, and remove the user's confirmation/password-like text immediately.
  userStates.delete(chatId);
  busyLocks.set(chatId, true);
  try {
    try { await ctx.api.deleteMessage(chatId, ctx.message?.message_id); } catch {}
    await invalidateUserState(chatId);
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'en');
    if (text !== 'CONFIRM' || Date.now() >= state.expiresAt || state.binding !== runtimeBinding() || config.authMode === 'agent') {
      await ctx.reply(t('export_confirmation_invalid')); return;
    }
    const privateKey = await getDecryptedPrivateKey();
    const message = await ctx.reply(`<code>${privateKey}</code>`, { parse_mode: 'HTML' });
    scheduleMessageDeletion(ctx, [state.warningMessageId, message?.message_id], 30000);
    await ctx.reply(t('warning_exported_pk'), { reply_markup: await getMainMenuKeyboard(config.language || 'en') });
  } finally { busyLocks.delete(chatId); }
}
