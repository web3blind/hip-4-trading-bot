import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { getOutcomeRewards } from '../../outcome-rewards.js';
import { hlClient } from '../runtime.js';
import { outcomeBuilderStatusKey } from '../../outcome-builder.js';
export async function showRewards(ctx) {
 const config = await loadConfig(); const t = await getTranslator(config.language || 'en');
 const keyboard = new InlineKeyboard().text(t('refresh'),'rewards').row().text(t('back'),'settings');
 let text;
 if ((hlClient?.network || config.hlNetwork || 'testnet') !== 'mainnet') text=t('rewards_mainnet_only');
 else if (!config.walletAddress) text=t('wallet_not_configured_setup');
 else {
   const builderStatus = hlClient ? await hlClient.refreshOutcomeBuilderStatus() : { status: 'unavailable' };
   try {
   const data = await getOutcomeRewards(config.walletAddress);
   text=t('rewards_totals',{...data,address:config.walletAddress});
   } catch { text=t('rewards_unavailable'); }
   text += '\n\n'+t(outcomeBuilderStatusKey(builderStatus.status))+'\n'+t('rewards_eligibility_unknown');
 }
 try { await ctx.editMessageText(text,{reply_markup:keyboard}); } catch { await ctx.reply(text,{reply_markup:keyboard}); }
}
