/**
 * Withdraw feature for HIP-4 Telegram bot.
 *
 * Allows users to withdraw USDC from their bot wallet to an external
 * address on HyperLiquid L1.
 *
 * Flow:
 *  1. User taps "Withdraw" on wallet screen
 *  2. Bot asks for destination address
 *  3. User enters 0x address (validated)
 *  4. Bot asks for amount with quick % buttons
 *  5. User enters amount or taps percentage
 *  6. Confirmation screen
 *  7. Execute: transfer perp→spot if needed, then withdraw
 */

import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { busyLocks, userStates, hlClient } from '../runtime.js';
import { getMainMenuKeyboard } from '../ui/keyboards.js';

// ─── Helpers ──────────────────────────────────────────────────────

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MIN_WITHDRAW = 1;

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

function confirmKeyboard(t) {
  return new InlineKeyboard()
    .text(t ? t('confirm') : 'Confirm', 'confirm_withdraw')
    .text(t ? t('cancel') : 'Cancel', 'cancel_withdraw');
}

// ─── Feature factory ──────────────────────────────────────────────

export function createWithdrawFeature(_deps) {

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

    try {
      const spotBal = await hlClient.getSpotUsdcBalance();
      const perpBal = await hlClient.getPerpBalance();
      const totalBal = spotBal + perpBal;

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
      process.stderr.write(`[withdraw] handleWithdrawStart error: ${err.message}\n`);
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
    const t = await getT();
    const address = (text || '').trim();

    if (!ADDRESS_RE.test(address)) {
      await ctx.reply(t('invalid_address'), { reply_markup: cancelKeyboard(t) });
      return;
    }

    // Refresh balances
    let spotBal, perpBal, totalBal;
    try {
      spotBal = await hlClient.getSpotUsdcBalance();
      perpBal = await hlClient.getPerpBalance();
      totalBal = spotBal + perpBal;
    } catch {
      spotBal = state.spotBal || 0;
      perpBal = state.perpBal || 0;
      totalBal = state.totalBal || 0;
    }

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
    const t = await getT();
    const amount = parseFloat((text || '').trim());

    if (!Number.isFinite(amount) || amount < MIN_WITHDRAW) {
      await ctx.reply(
        t('invalid_withdraw_amount', { min: MIN_WITHDRAW.toFixed(2) }),
        { reply_markup: amountKeyboard(state.totalBal || 0, t) },
      );
      return;
    }

    const totalBal = state.totalBal || 0;
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

    userStates.set(chatId, {
      state: 'CONFIRMING_WITHDRAW',
      destination: state.destination,
      amount: roundedAmount,
      spotBal: state.spotBal,
      perpBal: state.perpBal,
      totalBal: state.totalBal,
    });

    await ctx.reply(
      `${t('confirm_withdrawal')}\n\n` +
      `${t('to_label')}: ${truncateAddress(state.destination)}\n` +
      `${t('amount')}: $${roundedAmount.toFixed(2)} USDC\n` +
      `${t('network_label')}: ${networkDisplay}\n\n` +
      t('proceed'),
      { reply_markup: confirmKeyboard(t) },
    );
  }

  /**
   * Handle percentage quick-buttons (25%, 50%, 75%, Max).
   */
  async function handleWithdrawPct(ctx, pct) {
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
      totalBal = spotBal + perpBal;
    } catch {
      spotBal = state.spotBal || 0;
      perpBal = state.perpBal || 0;
      totalBal = state.totalBal || 0;
    }

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

    userStates.set(chatId, {
      state: 'CONFIRMING_WITHDRAW',
      destination: state.destination,
      amount,
      spotBal,
      perpBal,
      totalBal,
    });

    await editOrReply(ctx,
      `${t('confirm_withdrawal')}\n\n` +
      `${t('to_label')}: ${truncateAddress(state.destination)}\n` +
      `${t('amount')}: $${amount.toFixed(2)} USDC\n` +
      `${t('network_label')}: ${networkDisplay}\n\n` +
      t('proceed'),
      { reply_markup: confirmKeyboard(t) },
    );
  }

  /**
   * Step 4: Execute the withdrawal.
   * If funds are in perp account, transfer to spot first, then withdraw.
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

    busyLocks.set(chatId, true);

    try {
      const { destination, amount } = state;

      await editOrReply(ctx, t('processing_withdrawal', { amount: amount.toFixed(2) }));

      // Check how much is in spot vs perp
      const spotBal = await hlClient.getSpotUsdcBalance();
      const perpBal = await hlClient.getPerpBalance();

      process.stderr.write(`[withdraw] executing: dest=${truncateAddress(destination)} amount=${amount} spot=${spotBal} perp=${perpBal}\n`);

      // If spot balance is insufficient, transfer from perp to spot first
      if (spotBal < amount && perpBal > 0) {
        const transferNeeded = Math.min(perpBal, amount - spotBal);
        const transferAmt = Math.floor(transferNeeded * 100) / 100;

        if (transferAmt >= 0.01) {
          process.stderr.write(`[withdraw] transferring ${transferAmt} USDC from perp to spot\n`);
          try {
            await editOrReply(ctx,
              t('processing_withdrawal', { amount: amount.toFixed(2) }) + '\n' +
              t('transferring_perp_to_spot', { amount: transferAmt.toFixed(2) }),
            );
            await hlClient.transferUsdClass(transferAmt, false); // toPerp=false → perp to spot
            // Small delay to let the transfer settle
            await new Promise(r => setTimeout(r, 1000));
          } catch (transferErr) {
            process.stderr.write(`[withdraw] perp→spot transfer failed: ${transferErr.message}\n`);
            await editOrReply(ctx,
              t('transfer_perp_failed', { error: transferErr.message }),
              { reply_markup: new InlineKeyboard().text(t('back_to_wallet'), 'wallet') },
            );
            userStates.delete(chatId);
            return;
          }
        }
      }

      // Verify spot balance after transfer
      const finalSpot = await hlClient.getSpotUsdcBalance();
      if (finalSpot < amount - 0.01) {
        await editOrReply(ctx,
          t('insufficient_after_transfer', { available: finalSpot.toFixed(2), needed: amount.toFixed(2) }),
          { reply_markup: new InlineKeyboard().text(t('back_to_wallet'), 'wallet') },
        );
        userStates.delete(chatId);
        return;
      }

      // Execute the withdrawal
      process.stderr.write(`[withdraw] calling hlClient.withdraw(${destination}, ${amount})\n`);
      const result = await hlClient.withdraw(destination, amount);
      process.stderr.write(`[withdraw] result: ${JSON.stringify(result)}\n`);

      // Check for errors in the response
      if (result?.status === 'err') {
        throw new Error(result.response || 'Withdrawal failed');
      }

      const newSpot = await hlClient.getSpotUsdcBalance();
      const newPerp = await hlClient.getPerpBalance();

      await editOrReply(ctx,
        `${t('withdrawal_successful')}\n\n` +
        `${t('amount')}: $${amount.toFixed(2)} USDC\n` +
        `${t('to_label')}: ${truncateAddress(destination)}\n\n` +
        `${t('remaining_balance')}:\n` +
        `  ${t('spot')}: $${newSpot.toFixed(2)}\n` +
        `  ${t('perp')}: $${newPerp.toFixed(2)}`,
        {
          reply_markup: new InlineKeyboard()
            .text(t('back_to_wallet'), 'wallet')
            .row()
            .text(t('main_menu_btn'), 'back_menu'),
        },
      );

      userStates.delete(chatId);
    } catch (err) {
      process.stderr.write(`[withdraw] error: ${err.message}\n`);
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
    userStates.delete(chatId);
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
