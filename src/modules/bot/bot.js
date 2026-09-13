/**
 * HIP-4 Telegram Bot — main assembly.
 *
 * Creates and configures the Grammy bot instance:
 *   - Auth middleware (TELEGRAM_ALLOWED_USER_ID)
 *   - Rate limiting
 *   - Command handlers (/start, /menu, /markets, /positions, /orders, /settings, /wallet)
 *   - Callback query routing (via callback-router)
 *   - Text message routing (via text-router)
 *
 * All feature logic lives in src/modules/bot/features/*.js — this file
 * only wires the pieces together.
 */

import { Bot, InlineKeyboard } from 'grammy';
import { loadConfig, ensureConfigFileExists, isLanguageConfigured, isWalletConfigured } from '../config.js';
import { getTranslator } from '../i18n.js';
import { createContext, safeLogError, safeLogInfo } from '../logger.js';
import { RATE_LIMIT_MS } from './constants.js';
import {
  bot as runtimeBot,
  setBot,
  setAllowedUserId,
  allowedUserId as runtimeAllowedUserId,
  userStates,
  rateLimits,
  busyLocks,
  hlClient as runtimeHLClient,
  setHLClient, isAuthorizedPrivateContext, invalidateUserState, runtimeTransitioning,
} from './runtime.js';
import { mainMenuKeyboard, getMainMenuKeyboard } from './ui/keyboards.js';
import {
  showLanguageSelectionScreen,
  handleLanguageSelectionAction,
  showLanguageSettingsMenu,
  handleSettingsLanguageChangeAction,
} from './features/language.js';
import { showOutcomesList } from './features/outcomes.js';
import { showOutcomeDetail } from './features/outcome-details.js';
import { createTradeMarketFeature } from './features/trade-market.js';
import { createTradeLimitFeature } from './features/trade-limit.js';
import { createPositionsFeature } from './features/positions.js';
import { createOrdersFeature } from './features/orders.js';
import { showSettings, handleSettingsCallback } from './features/settings.js';
import { showWalletInfo, handleWalletCallback } from './features/security.js';
import { handleCallbackQuery } from './routing/callback-router.js';
import { handleTextMessage } from './routing/text-router.js';
import { interceptApiWalletInput } from './features/api-wallet.js';

// ─── Bot lifecycle ───────────────────────────────────────────────

let pollingStarted = false;

/**
 * Initialise and configure the Grammy bot.
 *
 * @param {string} token - TELEGRAM_BOT_TOKEN
 * @param {string} allowedUserId - TELEGRAM_ALLOWED_USER_ID
 */
export async function initBot(token, allowedUserId) {
  setAllowedUserId(allowedUserId);

  // Ensure config exists on disk (creates skeleton if missing)
  await ensureConfigFileExists();

  const botInstance = new Bot(token);
  setBot(botInstance);

  botInstance.use(interceptApiWalletInput);

  // ── Auth middleware ──────────────────────────────────────────
  botInstance.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!isAuthorizedPrivateContext(ctx)) {
      const config = await loadConfig();
      const t = await getTranslator(config.language || 'en');
      if (ctx.callbackQuery) {
        try { await ctx.answerCallbackQuery(t('error_access_denied')); } catch {}
      } else {
        try { await ctx.reply(t('error_access_denied')); } catch {}
      }
      return;
    }

    if (runtimeTransitioning || busyLocks.get(ctx.chat.id) || userStates.get(ctx.chat.id)?.state === 'API_WALLET_SAVING') return;
    if (ctx.message?.text?.startsWith('/')) await invalidateUserState(ctx.chat.id);
    // Rate limiting
    const now = Date.now();
    const last = rateLimits.get(userId) || 0;
    if (now - last < RATE_LIMIT_MS) {
      const config = await loadConfig();
      const t = await getTranslator(config.language || 'en');
      if (ctx.callbackQuery) {
        try { await ctx.answerCallbackQuery(t('error_rate_limit')); } catch {}
      } else {
        try { await ctx.reply(t('error_rate_limit')); } catch {}
      }
      return;
    }
    rateLimits.set(userId, now);
    await next();
  });

  // ── Commands ────────────────────────────────────────────────

  botInstance.command('start', handleStartCommand);
  botInstance.command('menu', handleStartCommand);
  botInstance.command('markets', async (ctx) => {
    if (!runtimeHLClient) {
      await ctx.reply('HyperLiquid client not initialised yet. Try again shortly.');
      return;
    }
    await showOutcomesList(ctx, runtimeHLClient, 1);
  });
  botInstance.command('positions', async (ctx) => {
    if (!runtimeHLClient) {
      await ctx.reply('HyperLiquid client not initialised yet.');
      return;
    }
    const positions = createPositionsFeature({ hlClient: runtimeHLClient });
    await positions.showPositions(ctx);
  });
  botInstance.command('orders', async (ctx) => {
    if (!runtimeHLClient) {
      await ctx.reply('HyperLiquid client not initialised yet.');
      return;
    }
    const orders = createOrdersFeature({ hlClient: runtimeHLClient });
    await orders.showOrders(ctx);
  });
  botInstance.command('settings', async (ctx) => {
    await showSettings(ctx);
  });
  botInstance.command('wallet', async (ctx) => {
    await showWalletInfo(ctx);
  });

  // ── Callback queries ────────────────────────────────────────

  botInstance.on('callback_query:data', async (ctx) => {
    await handleCallbackQuery(ctx);
  });

  // ── Text messages ───────────────────────────────────────────

  botInstance.on('message:text', async (ctx) => {
    await handleTextMessage(ctx);
  });

  // ── Error handler ───────────────────────────────────────────

  botInstance.catch((err) => {
    const logCtx = createContext('bot', 'catch');
    safeLogError(logCtx, err);
  });

  return botInstance;
}

// ── /start & /menu handler ────────────────────────────────────

async function handleStartCommand(ctx) {
  const langConfigured = await isLanguageConfigured();

  if (!langConfigured) {
    await showLanguageSelectionScreen(ctx);
    return;
  }

  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');
  const walletConfigured = await isWalletConfigured();

  let message =
    `${t('welcome')}\n\n` +
    `${t('wallet_status')}: ` +
    (walletConfigured ? `<code>${config.walletAddress}</code>` : t('not_configured'));

  if (!walletConfigured) {
    message += '\n\n' + t('wallet_not_configured_help');
  }

  await ctx.reply(message, {
    parse_mode: 'HTML',
    reply_markup: await getMainMenuKeyboard(config.language || 'en'),
  });
}

// ── Start / Stop ──────────────────────────────────────────────

let pollingTask = null;
let pollingReady = null;
export function startBot({ onFatal } = {}) {
  const b = runtimeBot;
  if (!b) throw new Error('Bot not initialised. Call initBot() first.');
  if (pollingStarted) return pollingReady;
  pollingStarted = true;
  let resolveReady, rejectReady;
  let ready = false;
  pollingReady = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Keep the lifetime promise separate from verified startup readiness.
  pollingTask = Promise.resolve().then(() => b.start({ onStart: () => {
    ready = true;
    safeLogInfo(createContext('bot', 'startBot'), 'Bot polling started');
    resolveReady();
  } })).then(() => {
    if (!ready) rejectReady(new Error('Polling stopped before initialization'));
  }).catch(error => {
    rejectReady(error);
    safeLogError(createContext('bot', 'polling'), error);
    // Do not await cleanup here: stopBot drains this same lifetime promise.
    if (ready && onFatal) Promise.resolve().then(() => onFatal(error)).catch(cleanupError => {
      safeLogError(createContext('bot', 'pollingCleanup'), cleanupError);
    });
  }).finally(() => { pollingStarted = false; });
  return pollingReady;
}

export async function stopBot() {
  const b = runtimeBot;
  if (!b || !pollingStarted) { await pollingTask; return; }
  try {
    await b.stop();
    await pollingTask;
  } finally { pollingStarted = false; }
}
