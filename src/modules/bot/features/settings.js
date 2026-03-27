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
import { loadConfig, updateConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { userStates } from '../runtime.js';
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
    `Network: ${network}\n`;

  const keyboard = new InlineKeyboard();
  keyboard.text(t('settings_language') || 'Language', 'change_language').row();
  keyboard.text(`Network: ${network}`, 'settings:network').row();

  if (!config.walletAddress) {
    keyboard.text(t('settings_init_wallet') || 'Init Wallet', 'init_wallet').row();
  } else {
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
    const current = config.hlNetwork || 'testnet';
    const newNetwork = current === 'testnet' ? 'mainnet' : 'testnet';
    await updateConfig('hlNetwork', newNetwork);

    const text = `Network switched to: ${newNetwork}\n\nRestart the bot for the change to take full effect.`;
    const keyboard = new InlineKeyboard()
      .text('Back to Settings', 'settings');

    try {
      await ctx.editMessageText(text, { reply_markup: keyboard });
    } catch {
      await ctx.reply(text, { reply_markup: keyboard });
    }
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
