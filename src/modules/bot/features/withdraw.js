/**
 * Withdraw feature — STUB for HIP-4 bot.
 *
 * HyperLiquid L1 withdrawals work differently from Polygon/Polymarket.
 * This feature is disabled for MVP and will be implemented later.
 */

import { InlineKeyboard } from 'grammy';

export function createWithdrawFeature(_deps) {
  async function startWithdrawFlow(ctx) {
    await ctx.editMessageText(
      'Withdrawals are not available yet for HyperLiquid HIP-4.\n\n' +
      'Use the HyperLiquid web app to manage funds.',
      {
        reply_markup: new InlineKeyboard().text('Back', 'back_menu'),
      },
    );
  }

  return {
    startWithdrawFlow,
    handleWithdrawAddress: startWithdrawFlow,
    handleWithdrawAmount: startWithdrawFlow,
    handleWithdrawPercent: startWithdrawFlow,
    executeWithdraw: startWithdrawFlow,
  };
}
