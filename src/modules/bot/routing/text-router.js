/**
 * Text-message router for HIP-4 Telegram bot.
 *
 * Routes free-form text input to the appropriate feature handler
 * based on the current user state in runtime.userStates.
 */

import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { createContext, safeLogError } from '../../logger.js';
import { busyLocks, userStates } from '../runtime.js';
import { mainMenuKeyboard, getMainMenuKeyboard } from '../ui/keyboards.js';

// Feature imports
import { createTradeMarketFeature } from '../features/trade-market.js';
import { createTradeLimitFeature } from '../features/trade-limit.js';
import { handleExportConfirmation } from '../features/security.js';

// Instantiate features
const tradeMarket = createTradeMarketFeature({});
const tradeLimit = createTradeLimitFeature({});

// ─── Confirmation states that bypass the busy lock ──────────────

const CONFIRMATION_STATES = new Set([
  'CONFIRMING_MARKET_BUY',
  'CONFIRMING_MARKET_SELL',
  'CONFIRMING_LIMIT_ORDER',
  'AWAITING_EXPORT_CONFIRMATION',
]);

// ─── Main text handler ──────────────────────────────────────────

export async function handleTextMessage(ctx) {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;
  const config = await loadConfig();
  const lang = config.language || 'en';
  const t = await getTranslator(lang);

  const state = userStates.get(chatId);

  // No active state → show menu
  if (!state) {
    await ctx.reply(t('main_menu'), {
      reply_markup: await getMainMenuKeyboard(lang),
    });
    return;
  }

  // Check busy lock (skip for confirmation states)
  if (busyLocks.get(chatId) && !CONFIRMATION_STATES.has(state.state)) {
    await ctx.reply(t('error_busy'));
    return;
  }

  try {
    switch (state.state) {
      // ── Market trade amounts ──
      case 'AWAITING_MARKET_BUY_AMOUNT':
        await tradeMarket.handleMarketBuyAmount(ctx, state, text);
        break;

      case 'AWAITING_MARKET_SELL_AMOUNT':
        await tradeMarket.handleMarketSellAmount(ctx, state, text);
        break;

      // ── Limit order inputs ──
      case 'AWAITING_LIMIT_PRICE':
        await tradeLimit.handleLimitPrice(ctx, state, text);
        break;

      case 'AWAITING_LIMIT_SIZE':
        await tradeLimit.handleLimitSize(ctx, state, text);
        break;

      // ── Wallet export confirmation ──
      case 'AWAITING_EXPORT_CONFIRMATION':
        await handleExportConfirmation(ctx, state, text);
        break;

      // ── Fallback ──
      default:
        await ctx.reply(t('main_menu'), {
          reply_markup: await getMainMenuKeyboard(lang),
        });
        break;
    }
  } catch (error) {
    const logCtx = createContext('textRouter', 'handleTextMessage');
    safeLogError(logCtx, error, { state: state?.state });
    await ctx.reply(t('error_generic'), {
      reply_markup: await getMainMenuKeyboard(lang),
    });
    userStates.delete(chatId);
  }
}
