import { InlineKeyboard } from 'grammy';
import { loadConfig } from '../../config.js';
import { getTranslator } from '../../i18n.js';
import { issueMcpKey, revokeMcpKey, listMcpKeys } from '../../mcp/key-store.js';
import { confirmationCallback, userStates, isAuthorizedPrivateContext, scheduleMessageDeletion } from '../runtime.js';

export async function showMcpSettings(ctx) {
  if (!isAuthorizedPrivateContext(ctx)) return;
  const config = await loadConfig();
  const t = await getTranslator(config.language || 'en');
  const active = await listMcpKeys();
  const has = scope => active.some(k => k.scope === scope);
  const text = `${t('mcp_title')}\n\n${t('mcp_explainer')}\n` +
    `${t('mcp_read')}: ${has('read') ? t('mcp_active') : t('mcp_off')}\n` +
    `${t('mcp_trade')}: ${has('trade') ? t('mcp_active') : t('mcp_off')}\n` +
    `${t('mcp_local_only')}`;
  const kb = new InlineKeyboard()
    .text(t('mcp_issue_read'), 'mcp:key:issue:read').row()
    .text(t('mcp_issue_trade'), 'mcp:key:issue:trade').row();
  if (has('read')) kb.text(t('mcp_revoke_read'), 'mcp:key:revoke:read').row();
  if (has('trade')) kb.text(t('mcp_revoke_trade'), 'mcp:key:revoke:trade').row();
  kb.text(t('back'), 'settings');
  try { await ctx.editMessageText(text, { reply_markup: kb }); }
  catch { await ctx.reply(text, { reply_markup: kb }); }
}

export async function handleMcpKeyAction(ctx, data) {
  if (!isAuthorizedPrivateContext(ctx)) return;
  const t = await getTranslator((await loadConfig()).language || 'en');
  if (data === 'mcp:key:menu') return showMcpSettings(ctx);
  const step = /^mcp:key:(issue|revoke):(read|trade)$/.exec(data);
  if (step) {
    const [, action, scope] = step;
    const callback = confirmationCallback(ctx.chat.id, `confirm_mcp_${action}_${scope}`, { state: 'MCP_KEY_REVIEW', action, scope });
    const warning = action === 'issue' ? scope === 'trade' ? t('mcp_trade_warning') : t('mcp_read_warning') : t('mcp_revoke_warning');
    await ctx.editMessageText(warning, { reply_markup: new InlineKeyboard().text(t('confirm'), callback).text(t('cancel'), 'mcp:key:menu') });
    return;
  }
  const confirmed = /^confirm_mcp_(issue|revoke)_(read|trade)(?:_final)?$/.exec(data);
  if (!confirmed) return;
  const [, action, scope] = confirmed;
  const state = userStates.get(ctx.chat.id);
  if (state?.state !== 'MCP_KEY_REVIEW' || state.action !== action || state.scope !== scope) return;
  if (action === 'issue' && scope === 'trade' && !data.endsWith('_final')) {
    const callback = confirmationCallback(ctx.chat.id, 'confirm_mcp_issue_trade_final', state);
    await ctx.editMessageText(t('mcp_trade_final_warning'), { reply_markup: new InlineKeyboard().text(t('confirm'), callback).text(t('cancel'), 'mcp:key:menu') });
    return;
  }
  userStates.delete(ctx.chat.id);
  if (action === 'revoke') {
    await revokeMcpKey(scope);
    await ctx.editMessageText(t('mcp_revoked'));
    return;
  }
  const key = await issueMcpKey(scope);
  await ctx.editMessageText(t('mcp_created'));
  const message = await ctx.reply(`${t('mcp_key_once')}\n\n${key}\n\n${t('mcp_key_safety')}`, {
    reply_markup: new InlineKeyboard().copyText(t('mcp_copy_key'), key),
  });
  if (message?.message_id) scheduleMessageDeletion(ctx, [message.message_id], 300_000);
}
