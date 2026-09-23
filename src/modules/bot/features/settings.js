/**
 * Settings feature for HIP-4 Telegram bot.
 *
 * Provides:
 *   - Language selection
 *   - Network toggle (testnet / mainnet)
 *   - Notification settings
 *   - Links to wallet / export key screens
 */

import { InlineKeyboard } from 'grammy';
import { loadConfig, updateConfig, getNotificationSettings, setNotificationSetting } from '../../config.js';
import { getDecryptedPrivateKey } from '../../auth.js';
import { HLClient } from '../../hyperliquid.js';
import { getTranslator } from '../../i18n.js';
import { userStates, activateHLClient, createConfiguredHLClient, confirmationCallback } from '../runtime.js';
import { mainMenuKeyboard, getMainMenuKeyboard } from '../ui/keyboards.js';

// ─── Show settings menu ─────────────────────────────────────────

export async function showSettings(ctx) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');

  const walletStatus = config.walletAddress ? `<code>${config.walletAddress}</code>` : t('not_configured');
  const languageDisplay = config.language === 'ru' ? '🇷🇺 Русский' : '🇬🇧 English';
  const network = config.hlNetwork || 'testnet';

  const text =
    `${t('settings_title')}\n\n` +
    `${t('settings_wallet')}: ${walletStatus}\n` +
    `${t('settings_language')}: ${languageDisplay}\n` +
    `${t('network_label')}: ${network}\n`;

  const keyboard = new InlineKeyboard();
  keyboard.text(t('settings_language') || 'Language', 'change_language').row();
  keyboard.text(`${t('network_label')}: ${network}`, 'settings:network').row();
  keyboard.text(t('notifications_btn'), 'settings:notifications').row();
  keyboard.text(t('outcome_rewards'), 'rewards').row();
  keyboard.text(t('mcp_title'), 'settings:mcp').row();
  keyboard.text(t('api_wallet_connect'), 'wallet:connect_api').row();

  if (!config.walletAddress) {
    keyboard.text(t('settings_init_wallet') || 'Init Wallet', 'init_wallet').row();
  } else if (config.authMode !== 'agent') {
    keyboard.text(t('settings_export_pk') || 'Export Key', 'start_export_pk').row();
  }

  keyboard.text(t('back') || 'Back', 'back_menu');

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

// ─── Handle settings sub-callbacks ──────────────────────────────

export async function handleSettingsCallback(ctx, data) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');

  if (data === 'settings:network') {
    if (config.authMode === 'agent') { await ctx.editMessageText(t('agent_reconnect_network')); return; }
    const current = config.hlNetwork || 'testnet';
    const network = current === 'testnet' ? 'mainnet' : 'testnet';
    const callback = confirmationCallback(ctx.chat.id, 'confirm_network', { state: 'CONFIRMING_NETWORK', network });
    await ctx.editMessageText(t('network_review', { network }), { reply_markup: new InlineKeyboard()
      .text(t('confirm'), callback).text(t('cancel'), 'settings') });
    return;
  }
  if (data === 'confirm_network') {
    const state = userStates.get(ctx.chat.id);
    if (state?.state !== 'CONFIRMING_NETWORK' || config.authMode === 'agent') return;
    const next = { ...config, hlNetwork: state.network };
    const client = config.encrypted?.privateKey ? await createConfiguredHLClient(next) : null;
    await activateHLClient(client, { persist: () => updateConfig('hlNetwork', state.network) });
    await ctx.editMessageText(t('network_switched', { network: state.network }), {
      reply_markup: new InlineKeyboard().text(t('back_to_settings'), 'settings') });
    return;
  }

  if (data === 'settings:language') {
    const { showLanguageSettingsMenu } = await import('./language.js');
    await showLanguageSettingsMenu(ctx);
    return;
  }

  // Fallback
  await showSettings(ctx);
}

// ─── Cooldown formatting helper ──────────────────────────────

function formatCooldown(seconds) {
  if (seconds >= 60) {
    return `${Math.round(seconds / 60)} min`;
  }
  return `${seconds}s`;
}

function formatCooldownShort(seconds) {
  if (seconds >= 60) {
    return `${Math.round(seconds / 60)}m`;
  }
  return `${seconds}s`;
}

// ─── Show notification settings screen ──────────────────────

export async function showNotificationSettings(ctx) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');
  const notif = await getNotificationSettings();

  const text =
    `${t('notification_settings')}\n\n` +
    `${t('price_change_threshold')}: ${notif.priceChangePercent}%\n` +
    `${t('alert_when_moves')}\n\n` +
    `${t('repeat_step')}: ${notif.priceRepeatStepPercent}%\n` +
    `${t('re_alert_after')}\n\n` +
    `${t('cooldown')}: ${formatCooldown(notif.alertCooldownSeconds)}\n` +
    t('min_time_between');

  const keyboard = new InlineKeyboard()
    .text(`${t('threshold_label')}: ${notif.priceChangePercent}%`, 'notif_threshold:pick')
    .text(`${t('repeat_label')}: ${notif.priceRepeatStepPercent}%`, 'notif_repeat:pick')
    .row()
    .text(`${t('cooldown_label')}: ${formatCooldownShort(notif.alertCooldownSeconds)}`, 'notif_cooldown:pick')
    .row()
    .text(t('back_to_settings'), 'settings');

  try {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  } catch {
    await ctx.reply(text, { reply_markup: keyboard });
  }
}

// ─── Show threshold picker ──────────────────────────────────

export async function showThresholdPicker(ctx) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');
  const notif = await getNotificationSettings();

  const text = t('select_threshold', { value: notif.priceChangePercent });

  const keyboard = new InlineKeyboard()
    .text('5%', 'notif_threshold:5')
    .text('10%', 'notif_threshold:10')
    .text('15%', 'notif_threshold:15')
    .text('20%', 'notif_threshold:20')
    .text(t('custom'), 'notif_threshold:custom')
    .row()
    .text(t('back'), 'settings:notifications');

  try {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  } catch {
    await ctx.reply(text, { reply_markup: keyboard });
  }
}

// ─── Show repeat picker ─────────────────────────────────────

export async function showRepeatPicker(ctx) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');
  const notif = await getNotificationSettings();

  const text = t('select_repeat', { value: notif.priceRepeatStepPercent });

  const keyboard = new InlineKeyboard()
    .text('1%', 'notif_repeat:1')
    .text('2%', 'notif_repeat:2')
    .text('5%', 'notif_repeat:5')
    .text('10%', 'notif_repeat:10')
    .row()
    .text(t('back'), 'settings:notifications');

  try {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  } catch {
    await ctx.reply(text, { reply_markup: keyboard });
  }
}

// ─── Show cooldown picker ───────────────────────────────────

export async function showCooldownPicker(ctx) {
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');
  const notif = await getNotificationSettings();

  const text = t('select_cooldown', { value: formatCooldown(notif.alertCooldownSeconds) });

  const keyboard = new InlineKeyboard()
    .text('1 min', 'notif_cooldown:60')
    .text('5 min', 'notif_cooldown:300')
    .text('10 min', 'notif_cooldown:600')
    .text('30 min', 'notif_cooldown:1800')
    .row()
    .text(t('back'), 'settings:notifications');

  try {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  } catch {
    await ctx.reply(text, { reply_markup: keyboard });
  }
}

// ─── Handle notification callbacks ──────────────────────────

export async function handleNotificationCallback(ctx, data) {
  // Threshold picker
  if (data === 'notif_threshold:pick') {
    await showThresholdPicker(ctx);
    return;
  }

  // Threshold: custom → ask user to type
  if (data === 'notif_threshold:custom') {
    const chatId = ctx.chat.id;
    const config = await loadConfig();
    const t = await getTranslator(config.language || 'en');
    userStates.set(chatId, { state: 'AWAITING_NOTIF_THRESHOLD' });

    const text = t('enter_custom_threshold');
    const keyboard = new InlineKeyboard().text(t('cancel'), 'settings:notifications');

    try {
      await ctx.editMessageText(text, { reply_markup: keyboard });
    } catch {
      await ctx.reply(text, { reply_markup: keyboard });
    }
    return;
  }

  // Threshold: set value
  if (data.startsWith('notif_threshold:')) {
    const value = parseFloat(data.split(':')[1]);
    if (!Number.isNaN(value) && value > 0) {
      await setNotificationSetting('priceChangePercent', value);
    }
    await showNotificationSettings(ctx);
    return;
  }

  // Repeat picker
  if (data === 'notif_repeat:pick') {
    await showRepeatPicker(ctx);
    return;
  }

  // Repeat: set value
  if (data.startsWith('notif_repeat:')) {
    const value = parseFloat(data.split(':')[1]);
    if (!Number.isNaN(value) && value > 0) {
      await setNotificationSetting('priceRepeatStepPercent', value);
    }
    await showNotificationSettings(ctx);
    return;
  }

  // Cooldown picker
  if (data === 'notif_cooldown:pick') {
    await showCooldownPicker(ctx);
    return;
  }

  // Cooldown: set value
  if (data.startsWith('notif_cooldown:')) {
    const value = parseInt(data.split(':')[1], 10);
    if (!Number.isNaN(value) && value > 0) {
      await setNotificationSetting('alertCooldownSeconds', value);
    }
    await showNotificationSettings(ctx);
    return;
  }

  // Fallback
  await showNotificationSettings(ctx);
}

// ─── Handle custom threshold text input ─────────────────────

export async function handleCustomThresholdInput(ctx, text) {
  const chatId = ctx.chat.id;
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');
  const value = parseFloat(text.trim());

  if (Number.isNaN(value) || value <= 0 || value > 100) {
    await ctx.reply(t('invalid_threshold'));
    return;
  }

  userStates.delete(chatId);
  await setNotificationSetting('priceChangePercent', value);
  await showNotificationSettings(ctx);
}
