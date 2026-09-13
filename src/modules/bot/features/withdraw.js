/**
 * Withdraw feature for HIP-4 Telegram bot.
 *
 * Allows users to withdraw USDC from their bot wallet to an external
 * address on Arbitrum via the Hyperliquid bridge.
 *
 * Flow:
 *  1. User taps "Withdraw" on wallet screen
 *  2. Bot asks for destination address
 *  3. User enters 0x address (validated)
 *  4. Bot asks for amount with quick % buttons
 *  5. User enters amount or taps percentage
 *  6. Confirmation screen
 *  7. Execute: transfer spot→perp if needed, then request bridge withdrawal
 */

import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { busyLocks, userStates, hlClient, confirmationCallback, invalidateUserState, runtimeBinding } from '../runtime.js';
import { getMainMenuKeyboard } from '../ui/keyboards.js';

// ─── Helpers ──────────────────────────────────────────────────────

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MIN_WITHDRAW = 2; // $1 bridge fee is deducted from the submitted amount

function truncateAddress(addr) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

async function editOrReply(ctx, text, extra = {}) {
  try {
    await ctx.editMessageText(text, extra);
  } catch {
    await ctx.reply(text, extra);
  }
}

async function getT() {
  const config = await loadConfig();
  return await getTranslator(config.language || 'en');
}

function cancelKeyboard(t) {
  return new InlineKeyboard().text(t ? t('cancel') : 'Cancel', 'cancel_withdraw');
}

function amountKeyboard(balance, t) {
  const kb = new InlineKeyboard()
    .text('25%', 'withdraw_pct:25')
    .text('50%', 'withdraw_pct:50')
    .text('75%', 'withdraw_pct:75')
    .text(t ? t('max') : 'Max', 'withdraw_pct:100')
    .row()
    .text(t ? t('cancel') : 'Cancel', 'cancel_withdraw');
  return kb;
}

function confirmKeyboard(t, callback) {
  return new InlineKeyboard()
    .text(t ? t('confirm') : 'Confirm', callback)
    .text(t ? t('cancel') : 'Cancel', 'cancel_withdraw');
}

// ─── Feature factory ──────────────────────────────────────────────

export function createWithdrawFeature(_deps) {
  async function balanceRefreshFailed(ctx, t) {
    await invalidateUserState(ctx.chat.id);
    const ru = (await loadConfig()).language === 'ru';
    await editOrReply(ctx, ru ? 'Не удалось обновить баланс. Начните вывод заново.' : 'Balance refresh failed. Start withdrawal again.', {
      reply_markup: new InlineKeyboard().text(t('try_again'), 'withdraw_start'),
    });
  }

  /**
   * Step 1: Show balance info and ask for destination address.
   */
  async function handleWithdrawStart(ctx) {
    const chatId = ctx.chat.id;
    const t = await getT();

    if (!hlClient) {
      await editOrReply(ctx, t('wallet_not_ready'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu'),
      });
      return;
    }

    if (hlClient.authMode === 'agent') {
      userStates.delete(chatId);
      await editOrReply(ctx, t('owner_transfer_required')); return;
    }

    try {
      const spotBal = await hlClient.getSpotUsdcBalance();
      const perpBal = await hlClient.getPerpBalance();
      const totalBal = await hlClient.getAvailableUsdc();

      if (totalBal < MIN_WITHDRAW) {
        await editOrReply(ctx,
          `${t('insufficient_for_withdraw')}\n\n` +
          `${t('spot_usdc')}: $${spotBal.toFixed(2)}\n` +
          `${t('perp')}: $${perpBal.toFixed(2)}\n` +
          `${t('total')}: $${totalBal.toFixed(2)}\n\n` +
          t('min_withdrawal', { amount: MIN_WITHDRAW.toFixed(2) }),
          { reply_markup: new InlineKeyboard().text(t('back_to_wallet'), 'wallet') },
        );
        return;
      }

      userStates.set(chatId, {
        state: 'AWAITING_WITHDRAW_ADDRESS',
        spotBal,
        perpBal,
        totalBal,
      });

      await editOrReply(ctx,
        `${t('withdraw_title')}\n\n` +
        `${t('available_balance')}:\n` +
        `  ${t('spot_usdc')}: $${spotBal.toFixed(2)}\n` +
        `  ${t('perp')}: $${perpBal.toFixed(2)}\n` +
        `  ${t('total')}: $${totalBal.toFixed(2)}\n\n` +
        t('enter_destination'),
        { reply_markup: cancelKeyboard(t) },
      );
    } catch (err) {
      await editOrReply(ctx, `Error: ${err.message}`, {
        reply_markup: new InlineKeyboard().text(t('back_to_wallet'), 'wallet'),
      });
    }
  }

  /**
   * Step 2: Validate address, ask for amount.
   */
  async function handleWithdrawAddress(ctx, state, text) {
    const chatId = ctx.chat.id;
    if (userStates.get(chatId) !== state || state?.state !== 'AWAITING_WITHDRAW_ADDRESS') return;
    const t = await getT();
    const address = (text || '').trim();

    if (!ADDRESS_RE.test(address) || /^0x0{40}$/.test(address)) {
      await ctx.reply(t('invalid_address'), { reply_markup: cancelKeyboard(t) });
      return;
    }

    // Refresh balances
    let spotBal, perpBal, totalBal;
    try {
      spotBal = await hlClient.getSpotUsdcBalance();
      perpBal = await hlClient.getPerpBalance();
      totalBal = await hlClient.getAvailableUsdc();
      if (![spotBal, perpBal, totalBal].every(v => Number.isFinite(v) && v >= 0)) throw new Error('Invalid balance');
    } catch {
      await balanceRefreshFailed(ctx, t);
      return;
    }
    if (userStates.get(chatId) !== state) return;

    userStates.set(chatId, {
      state: 'AWAITING_WITHDRAW_AMOUNT',
      destination: address,
      spotBal,
      perpBal,
      totalBal,
    });

    await ctx.reply(
      `${t('destination')}: ${truncateAddress(address)}\n\n` +
      `${t('available')}: $${totalBal.toFixed(2)} USDC\n` +
      `  (${t('spot')}: $${spotBal.toFixed(2)} | ${t('perp')}: $${perpBal.toFixed(2)})\n\n` +
      t('enter_withdraw_amount'),
      { reply_markup: amountKeyboard(totalBal, t) },
    );
  }

  /**
   * Step 3: Validate amount, show confirmation.
   */
  async function handleWithdrawAmount(ctx, state, text) {
    const chatId = ctx.chat.id;
    if (userStates.get(chatId) !== state || state?.state !== 'AWAITING_WITHDRAW_AMOUNT') return;
    const t = await getT();
    const raw = String(text || '').trim();
    const amount = /^\d+(?:\.\d{1,6})?$/.test(raw) ? Number(raw) : NaN;

    if (!Number.isFinite(amount) || amount < MIN_WITHDRAW) {
      await ctx.reply(
        t('invalid_withdraw_amount', { min: MIN_WITHDRAW.toFixed(2) }),
        { reply_markup: amountKeyboard(state.totalBal || 0, t) },
      );
      return;
    }

    let totalBal;
    const binding = runtimeBinding();
    try {
      totalBal = await hlClient.getAvailableUsdc();
      if (!Number.isFinite(totalBal) || totalBal < 0) throw new Error('Invalid balance');
    } catch { await balanceRefreshFailed(ctx, t); return; }
    if (userStates.get(chatId) !== state || binding !== runtimeBinding()) return;
    if (amount > totalBal) {
      await ctx.reply(
        t('exceeds_balance', { balance: totalBal.toFixed(2) }),
        { reply_markup: amountKeyboard(totalBal, t) },
      );
      return;
    }

    // Round to 2 decimal places
    const roundedAmount = Math.floor(amount * 100) / 100;

    const config = await loadConfig();
    const network = config.hlNetwork || 'testnet';
    const networkDisplay = network === 'mainnet' ? 'HyperLiquid Mainnet' : 'HyperLiquid Testnet';

    const callback = confirmationCallback(chatId, 'confirm_withdraw', {
      state: 'CONFIRMING_WITHDRAW',
      destination: state.destination,
      amount: roundedAmount,
      spotBal: state.spotBal,
      perpBal: state.perpBal,
      totalBal: state.totalBal,
    });

    await ctx.reply(
      `${t('confirm_withdrawal')}\n\n` +
      `${t('to_label')}: ${state.destination}\n` +
      `${t('amount')}: $${roundedAmount.toFixed(2)} USDC\n` +
      `${t('network_label')}: ${networkDisplay} → Arbitrum\n` +
      (config.language === 'ru' ? 'Комиссия моста $1 удерживается из суммы. Зачисление не мгновенное. При необходимости: spot → perp.\n\n' : 'Bridge fee $1 deducted from amount. Receipt is not immediate. If needed: spot → perp.\n\n') +
      t('proceed'),
      { reply_markup: confirmKeyboard(t, callback) },
    );
  }

  /**
   * Handle percentage quick-buttons (25%, 50%, 75%, Max).
   */
  async function handleWithdrawPct(ctx, pct) {
    if (![25, 50, 75, 100].includes(pct)) return;
    const chatId = ctx.chat.id;
    const t = await getT();
    const state = userStates.get(chatId);

    if (!state || state.state !== 'AWAITING_WITHDRAW_AMOUNT') {
      await editOrReply(ctx, t('session_expired_withdraw'), {
        reply_markup: new InlineKeyboard().text(t('back_to_wallet'), 'wallet'),
      });
      return;
    }

    // Refresh balances
    let spotBal, perpBal, totalBal;
    try {
      spotBal = await hlClient.getSpotUsdcBalance();
      perpBal = await hlClient.getPerpBalance();
      totalBal = await hlClient.getAvailableUsdc();
      if (![spotBal, perpBal, totalBal].every(v => Number.isFinite(v) && v >= 0)) throw new Error('Invalid balance');
    } catch {
      await balanceRefreshFailed(ctx, t);
      return;
    }
    if (userStates.get(chatId) !== state) return;

    const rawAmount = (totalBal * pct) / 100;
    const amount = Math.floor(rawAmount * 100) / 100;

    if (amount < MIN_WITHDRAW) {
      await editOrReply(ctx,
        t('pct_of_balance', { pct, amount: amount.toFixed(2) }) + '\n' +
        t('min_withdrawal', { amount: MIN_WITHDRAW.toFixed(2) }),
        { reply_markup: amountKeyboard(totalBal, t) },
      );
      return;
    }

    const config = await loadConfig();
    const network = config.hlNetwork || 'testnet';
    const networkDisplay = network === 'mainnet' ? 'HyperLiquid Mainnet' : 'HyperLiquid Testnet';

    const callback = confirmationCallback(chatId, 'confirm_withdraw', {
      state: 'CONFIRMING_WITHDRAW',
      destination: state.destination,
      amount,
      spotBal,
      perpBal,
      totalBal,
    });

    await editOrReply(ctx,
      `${t('confirm_withdrawal')}\n\n` +
      `${t('to_label')}: ${state.destination}\n` +
      `${t('amount')}: $${amount.toFixed(2)} USDC\n` +
      `${t('network_label')}: ${networkDisplay} → Arbitrum\n` +
      (config.language === 'ru' ? 'Комиссия моста $1 удерживается из суммы. Зачисление не мгновенное. При необходимости: spot → perp.\n\n' : 'Bridge fee $1 deducted from amount. Receipt is not immediate. If needed: spot → perp.\n\n') +
      t('proceed'),
      { reply_markup: confirmKeyboard(t, callback) },
    );
  }

  /**
   * Step 4: Execute the withdrawal.
   * Standard accounts withdraw from perp; fund from spot if needed.
   */
  async function executeWithdraw(ctx) {
    const chatId = ctx.chat.id;
    const t = await getT();
    const state = userStates.get(chatId);

    if (!state || state.state !== 'CONFIRMING_WITHDRAW') {
      await editOrReply(ctx, t('session_expired_withdraw'), {
        reply_markup: new InlineKeyboard().text(t('back_to_wallet'), 'wallet'),
      });
      return;
    }

    if (!hlClient) {
      await editOrReply(ctx, t('trading_client_not_ready'), {
        reply_markup: new InlineKeyboard().text(t('back'), 'back_menu'),
      });
      userStates.delete(chatId);
      return;
    }

    if (busyLocks.get(chatId)) return;
    busyLocks.set(chatId, true);

    try {
      const { destination, amount } = state;

      await editOrReply(ctx, t('processing_withdrawal', { amount: amount.toFixed(2) }));

      if (hlClient.authMode === 'agent') throw new Error(t('owner_transfer_required'));
      if (!await hlClient.ensureWithdrawalFunding(amount)) throw new Error(t('insufficient_funds_deposit'));
      const result = await hlClient.withdraw(destination, amount);
      if (result?.status !== 'ok' || result?.response?.type !== 'default') throw new Error(t('execution_unknown'));
      const config = await loadConfig();
      await editOrReply(ctx,
        (config.language === 'ru' ? 'Запрос вывода принят, получение в Arbitrum ещё не подтверждено.' : 'Withdrawal request accepted; receipt on Arbitrum is not yet confirmed.') +
        `\n${destination}\n${amount.toFixed(2)} USDC; fee $1`,
        { reply_markup: new InlineKeyboard().text(t('back_to_wallet'), 'wallet') });

      userStates.delete(chatId);
    } catch (err) {
      await editOrReply(ctx,
        t('withdrawal_failed', { error: err.message }),
        {
          reply_markup: new InlineKeyboard()
            .text(t('try_again'), 'withdraw_start')
            .text(t('back_to_wallet'), 'wallet'),
        },
      );
      userStates.delete(chatId);
    } finally {
      busyLocks.delete(chatId);
    }
  }

  /**
   * Cancel the withdrawal flow.
   */
  async function cancelWithdraw(ctx) {
    const chatId = ctx.chat.id;
    const t = await getT();
    await invalidateUserState(chatId);
    busyLocks.delete(chatId);

    await editOrReply(ctx, t('withdrawal_cancelled'), {
      reply_markup: new InlineKeyboard()
        .text(t('back_to_wallet'), 'wallet')
        .row()
        .text(t('main_menu_btn'), 'back_menu'),
    });
  }

  return {
    handleWithdrawStart,
    handleWithdrawAddress,
    handleWithdrawAmount,
    handleWithdrawPct,
    executeWithdraw,
    cancelWithdraw,
    // Legacy compat aliases
    startWithdrawFlow: handleWithdrawStart,
    handleWithdrawPercent: handleWithdrawPct,
  };
}
