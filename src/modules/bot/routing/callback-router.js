/**
 * Callback-query router for HIP-4 Telegram bot.
 *
 * Maps callback_query data prefixes to the appropriate feature handler.
 * Keeps zero business logic — just dispatches.
 */

import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { createContext, safeLogError } from '../../logger.js';
import { busyLocks, confirmationLocks, userStates, hlClient } from '../runtime.js';
import { mainMenuKeyboard, getMainMenuKeyboard } from '../ui/keyboards.js';

// Features (lazy-ish imports)
import { showOutcomesList } from '../features/outcomes.js';
import { showOutcomeDetail } from '../features/outcome-details.js';
import { createTradeMarketFeature } from '../features/trade-market.js';
import { createTradeLimitFeature } from '../features/trade-limit.js';
import { createPositionsFeature } from '../features/positions.js';
import { createOrdersFeature } from '../features/orders.js';
import { showSettings, handleSettingsCallback } from '../features/settings.js';
import { showWalletInfo, handleWalletCallback } from '../features/security.js';
import {
  handleLanguageSelectionAction,
  showLanguageSettingsMenu,
  handleSettingsLanguageChangeAction,
} from '../features/language.js';

// ─── Instantiate feature objects (stateless factories) ──────────

const tradeMarket = createTradeMarketFeature({});
const tradeLimit = createTradeLimitFeature({});

// ─── Main callback handler ──────────────────────────────────────

export async function handleCallbackQuery(ctx) {
  const data = ctx.callbackQuery.data;
  const chatId = ctx.chat.id;

  // Double-tap guard for confirm_* callbacks
  const isConfirm = data.startsWith('confirm_');
  if (isConfirm) {
    if (confirmationLocks.get(chatId)) {
      try { await ctx.answerCallbackQuery(); } catch {}
      return;
    }
    confirmationLocks.set(chatId, true);
  }

  try {
    const config = await loadConfig();
    const lang = config.language || 'en';
    const t = await getTranslator(lang);

    let answered = false;
    const ack = async (text) => {
      if (answered) return;
      try {
        text ? await ctx.answerCallbackQuery(text) : await ctx.answerCallbackQuery();
        answered = true;
      } catch { answered = true; }
    };

    // ── Language selection (works before language is configured) ──
    if (data.startsWith('select_lang:')) {
      const selectedLang = data.split(':')[1];
      await handleLanguageSelectionAction(ctx, selectedLang, getMainMenuKeyboard);
      await ack();
      return;
    }

    if (data.startsWith('set_lang:')) {
      const selectedLang = data.split(':')[1];
      await handleSettingsLanguageChangeAction(ctx, selectedLang, getMainMenuKeyboard);
      await ack();
      return;
    }

    // ── Block while busy (except cancel) ──
    const isCancelAction = data === 'cancel_confirmation' || data === 'cancel_export_pk';
    if (busyLocks.get(chatId) && !isCancelAction) {
      await ack(t('error_busy'));
      return;
    }

    // Acknowledge early to avoid Telegram timeout
    await ack();

    // ── Main menu ──
    if (data === 'menu' || data === 'back_menu') {
      await ctx.editMessageText(t('main_menu'), {
        reply_markup: await getMainMenuKeyboard(lang),
      });
      return;
    }

    // ── Outcomes (market browser) ──
    if (data.startsWith('outcomes:')) {
      // outcomes:page:<n>
      const parts = data.split(':');
      const page = parseInt(parts[2], 10) || 1;
      if (!hlClient) {
        await ctx.editMessageText('HyperLiquid client not initialised.', {
          reply_markup: new InlineKeyboard().text('Back', 'back_menu'),
        });
        return;
      }
      await showOutcomesList(ctx, hlClient, page);
      return;
    }

    // ── Outcome detail ──
    if (data.startsWith('outcome:')) {
      const outcomeId = parseInt(data.split(':')[1], 10);
      if (!hlClient || isNaN(outcomeId)) {
        await ctx.editMessageText('Invalid outcome.', {
          reply_markup: new InlineKeyboard().text('Back', 'outcomes:page:1'),
        });
        return;
      }
      await showOutcomeDetail(ctx, hlClient, outcomeId);
      return;
    }

    // ── Trade (market orders) ──
    if (data.startsWith('trade:')) {
      // trade:{outcomeId}:{side}:{action}
      const parts = data.split(':');
      const outcomeId = parseInt(parts[1], 10);
      const sideStr = parts[2];
      const action = parts[3];
      await tradeMarket.handleTradeCallback(ctx, outcomeId, sideStr, action);
      return;
    }

    if (data === 'confirm_market_buy') {
      await tradeMarket.executeConfirmedMarketBuy(ctx);
      return;
    }

    if (data === 'confirm_market_sell') {
      await tradeMarket.executeConfirmedMarketSell(ctx);
      return;
    }

    // ── Limit orders ──
    if (data.startsWith('limit:')) {
      // limit:{outcomeId}:{side}:{action}
      const parts = data.split(':');
      const outcomeId = parseInt(parts[1], 10);
      const sideStr = parts[2];
      const action = parts[3];
      await tradeLimit.handleLimitCallback(ctx, outcomeId, sideStr, action);
      return;
    }

    if (data === 'confirm_limit_order') {
      await tradeLimit.executeConfirmedLimit(ctx);
      return;
    }

    // ── Positions ──
    if (data === 'positions' || data === 'positions:refresh') {
      if (!hlClient) {
        await ctx.editMessageText('HyperLiquid client not initialised.', {
          reply_markup: new InlineKeyboard().text('Back', 'back_menu'),
        });
        return;
      }
      const positions = createPositionsFeature({ hlClient });
      await positions.showPositions(ctx);
      return;
    }

    if (data.startsWith('pos:')) {
      // pos:sell:<coin> — sell from positions
      if (!hlClient) return;
      // For now just redirect to positions list
      const positions = createPositionsFeature({ hlClient });
      await positions.showPositions(ctx);
      return;
    }

    // ── Orders ──
    if (data === 'orders' || data === 'orders:refresh') {
      if (!hlClient) {
        await ctx.editMessageText('HyperLiquid client not initialised.', {
          reply_markup: new InlineKeyboard().text('Back', 'back_menu'),
        });
        return;
      }
      const orders = createOrdersFeature({ hlClient });
      await orders.showOrders(ctx);
      return;
    }

    if (data.startsWith('order:cancel:')) {
      if (!hlClient) return;
      const oid = decodeURIComponent(data.slice('order:cancel:'.length));
      const orders = createOrdersFeature({ hlClient });
      await orders.cancelOrder(ctx, oid);
      return;
    }

    if (data === 'orders:cancelall') {
      if (!hlClient) return;
      const orders = createOrdersFeature({ hlClient });
      await orders.cancelAllOrders(ctx);
      return;
    }

    // ── Settings ──
    if (data === 'settings') {
      await showSettings(ctx);
      return;
    }

    if (data.startsWith('settings:')) {
      await handleSettingsCallback(ctx, data);
      return;
    }

    if (data === 'change_language') {
      await showLanguageSettingsMenu(ctx);
      return;
    }

    // ── Wallet / Security ──
    if (data === 'wallet' || data.startsWith('wallet:')) {
      await handleWalletCallback(ctx, data);
      return;
    }

    if (data === 'init_wallet') {
      await handleWalletCallback(ctx, data);
      return;
    }

    if (data === 'start_export_pk' || data === 'confirm_export_pk' || data === 'cancel_export_pk') {
      await handleWalletCallback(ctx, data);
      return;
    }

    // ── Cancel confirmation (generic) ──
    if (data === 'cancel_confirmation') {
      userStates.delete(chatId);
      await ctx.editMessageText(t('cancel'), {
        reply_markup: await getMainMenuKeyboard(lang),
      });
      return;
    }

    // ── Fallback: unhandled callback ──
    const logCtx = createContext('callbackRouter', 'handleCallbackQuery');
    safeLogError(logCtx, new Error(`Unhandled callback: ${data}`));

  } catch (error) {
    const logCtx = createContext('callbackRouter', 'handleCallbackQuery');
    safeLogError(logCtx, error, { data });
    try {
      await ctx.editMessageText('An error occurred. Please try again.', {
        reply_markup: mainMenuKeyboard(),
      });
    } catch {}
  } finally {
    if (isConfirm) {
      confirmationLocks.delete(chatId);
    }
  }
}
