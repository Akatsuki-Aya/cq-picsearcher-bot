import AxiosProxy from '../../utils/axiosProxy.mjs';
import emitter from '../../utils/emitter.mjs';
import logger from '../../utils/logger.mjs';
import { requestDecision } from './api.mjs';
import { writeDiagnostic } from './diagnostics.mjs';
import { SocialEngine } from './engine.mjs';
import { loadPersona } from './persona.mjs';

const contains = (list, id) => Array.from(list || []).some(item => String(item) === String(id));
export const socialTrace = (context, event, details) =>
  writeDiagnostic(global.config.bot.chatgpt.social.diagnostics !== false, context, event, details);

const engine = new SocialEngine({
  trace: socialTrace,
  getConfig: () => global.config.bot.chatgpt.social,
  getPersona: loadPersona,
  request: messages =>
    requestDecision(AxiosProxy.post, global.config.bot.chatgpt, global.config.bot.chatgpt.social, messages),
  send: (context, message) => global.replyMsg(context, message),
  allowed: context => {
    const { bot } = global.config;
    let reason;
    if (!bot.chatgpt.apiKey) reason = 'missing_api_key';
    else if (logger.checkBan(context)) reason = 'banned';
    else if (bot.debug && String(context.user_id) !== String(bot.admin)) reason = 'debug_admin_only';
    else if (context.message_type === 'private') {
      if (!bot.enablePM) reason = 'private_messages_disabled';
    } else if (!bot.enableGM) reason = 'group_messages_disabled';
    else if (bot.whiteGroup.size && !contains(bot.whiteGroup, context.group_id)) reason = 'global_group_whitelist';
    else if (contains(bot.chatgpt.blackGroup, context.group_id)) reason = 'chatgpt_group_blacklist';
    else if (bot.chatgpt.whiteGroup.size && !contains(bot.chatgpt.whiteGroup, context.group_id)) reason = 'chatgpt_group_whitelist';
    if (reason) socialTrace(context, 'access_denied', { reason });
    return !reason;
  },
});

emitter.onConfigReload(() => engine.reset());
emitter.onConfigLoad(() => {
  const { bot } = global.config;
  const social = bot.chatgpt.social;
  socialTrace(null, 'config_loaded', {
    enabled: social.enable, diagnostics: social.diagnostics !== false,
    groupCount: social.groups.length, privateUserCount: social.privateUsers.length,
    enableGM: bot.enableGM, enablePM: bot.enablePM, debugAdminOnly: bot.debug,
    hasApiKey: Boolean(bot.chatgpt.apiKey),
    dailyDecisionLimit: social.dailyDecisionLimit, dailyReplyLimit: social.dailyReplyLimit,
  });
});

export const resetSocialGroup = groupId => engine.resetGroup(groupId);

export default context => {
  const { message } = context;
  const skip = reason => {
    socialTrace(context, 'filtered', { reason });
    return false;
  };
  // Leave image search, commands and non-text media to the existing handlers.
  if (typeof message !== 'string' || !message.trim()) return skip('empty_text');
  if (message.includes('--')) return skip('command');
  if (/\[CQ:(?!at,|reply,)/.test(message)) return skip('non_text_cq');
  if (/^(all|pixiv|danbooru|doujin|book|anime|原图)$/.test(message)) return skip('search_command');
  const { regs } = global.config.bot;
  if ([regs.searchModeOn, regs.searchModeOff].some(regexp => regexp && new RegExp(regexp).test(message))) return skip('search_command');
  return engine.observe(context);
};
