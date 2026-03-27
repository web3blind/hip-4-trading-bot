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

import { showOutcomesList, showEventOutcomes } from '../features/outcomes.js';
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

const tradeMarket = createTradeMarketFeature({});
const tradeLimit = createTradeLimitFeature({});

async function editOrReply(ctx, text, extra = {}) {
  try {
    await ctx.editMessageText(text, extra);
  } catch {
    await ctx.reply(text, extra);
  }
}

export async function handleCallbackQuery(ctx) {
  const data = ctx.callbackQuery.data;
  const chatId = ctx.chat.id;

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
      } catch {
        answered = true;
      }
    };

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

    const isCancelAction = data === 'cancel_confirmation' || data === 'cancel_export_pk' || data.startsWith('trade_cancel:');
    if (busyLocks.get(chatId) && !isCancelAction) {
      await ack(t('error_busy'));
      return;
    }

    await ack();

    if (data === 'menu' || data === 'back_menu') {
      userStates.delete(chatId);
      await editOrReply(ctx, t('main_menu'), {
        reply_markup: await getMainMenuKeyboard(lang),
      });
      return;
    }

    if (data.startsWith('outcomes:')) {
      const parts = data.split(':');
      const page = parseInt(parts[2], 10) || 1;
      if (!hlClient) {
        await editOrReply(ctx, 'Trading is not ready yet. Create or import a wallet first.', {
          reply_markup: new InlineKeyboard().text('Back', 'back_menu'),
        });
        return;
      }
      await showOutcomesList(ctx, hlClient, page);
      return;
    }

    if (data.startsWith('event:')) {
      const questionId = parseInt(data.split(':')[1], 10);
      if (!hlClient || Number.isNaN(questionId)) {
        await editOrReply(ctx, 'This market event is no longer available.', {
          reply_markup: new InlineKeyboard().text('Back', 'outcomes:page:1'),
        });
        return;
      }
      await showEventOutcomes(ctx, hlClient, questionId);
      return;
    }

    if (data.startsWith('outcome:')) {
      const outcomeId = parseInt(data.split(':')[1], 10);
      if (!hlClient || Number.isNaN(outcomeId)) {
        await editOrReply(ctx, 'This market is no longer available.', {
          reply_markup: new InlineKeyboard().text('Back', 'outcomes:page:1'),
        });
        return;
      }
      await showOutcomeDetail(ctx, hlClient, outcomeId);
      return;
    }

    if (data.startsWith('trade:')) {
      const parts = data.split(':');
      const outcomeId = parseInt(parts[1], 10);
      const sideStr = parts[2];
      const action = parts[3];
      await tradeMarket.handleTradeCallback(ctx, outcomeId, sideStr, action);
      return;
    }

    if (data.startsWith('trade_cancel:')) {
      const [, , outcomeIdRaw, sideStr, action] = data.split(':');
      const outcomeId = parseInt(outcomeIdRaw, 10);
      await tradeMarket.cancelTradeFlow(ctx, outcomeId, sideStr, action);
      return;
    }

    if (data.startsWith('mkt_buy_pct:')) {
      const pct = parseInt(data.split(':')[1], 10);
      await tradeMarket.handleBuyPctCallback(ctx, pct);
      return;
    }

    if (data.startsWith('mkt_sell_pct:')) {
      const pct = parseInt(data.split(':')[1], 10);
      await tradeMarket.handleSellPctCallback(ctx, pct);
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

    if (data.startsWith('limit:')) {
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

    if (data === 'positions' || data === 'positions:refresh') {
      if (!hlClient) {
        await editOrReply(ctx, 'Trading is not ready yet. Create or import a wallet first.', {
          reply_markup: new InlineKeyboard().text('Back', 'back_menu'),
        });
        return;
      }
      const positions = createPositionsFeature({ hlClient });
      await positions.showPositions(ctx);
      return;
    }

    if (data.startsWith('pos:sell:')) {
      if (!hlClient) {
        await editOrReply(ctx, 'Trading is not ready yet. Create or import a wallet first.', {
          reply_markup: new InlineKeyboard().text('Back', 'back_menu'),
        });
        return;
      }

      const encodedCoin = data.slice('pos:sell:'.length);
      const coin = decodeURIComponent(encodedCoin);
      const match = String(coin).match(/^#?(\d+)$/);
      if (!match) {
        await editOrReply(ctx, 'This position cannot be sold from Telegram yet.', {
          reply_markup: new InlineKeyboard()
            .text('Back to positions', 'positions:refresh')
            .text('Back', 'back_menu'),
        });
        return;
      }

      const assetId = Number(match[1]);
      const outcomeId = Math.floor(assetId / 10);
      const sideStr = assetId % 10 === 0 ? 'yes' : 'no';
      await tradeMarket.handleTradeCallback(ctx, outcomeId, sideStr, 'sell');
      return;
    }

    if (data === 'orders' || data === 'orders:refresh') {
      if (!hlClient) {
        await editOrReply(ctx, 'Trading is not ready yet. Create or import a wallet first.', {
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

    if (data === 'cancel_confirmation') {
      userStates.delete(chatId);
      await editOrReply(ctx, t('cancel'), {
        reply_markup: await getMainMenuKeyboard(lang),
      });
      return;
    }

    const logCtx = createContext('callbackRouter', 'handleCallbackQuery');
    safeLogError(logCtx, new Error(`Unhandled callback: ${data}`));
  } catch (error) {
    const logCtx = createContext('callbackRouter', 'handleCallbackQuery');
    safeLogError(logCtx, error, { data });
    try {
      await editOrReply(ctx, 'Something went wrong. Please try again.', {
        reply_markup: mainMenuKeyboard(),
      });
    } catch {}
  } finally {
    if (isConfirm) {
      confirmationLocks.delete(chatId);
    }
  }
}
