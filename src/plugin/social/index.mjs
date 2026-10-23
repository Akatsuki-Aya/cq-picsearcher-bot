import AxiosProxy from '../../utils/axiosProxy.mjs';
import emitter from '../../utils/emitter.mjs';
import logger from '../../utils/logger.mjs';
import { requestDecision } from './api.mjs';
import { SocialEngine } from './engine.mjs';

const contains = (list, id) => Array.from(list || []).some(item => String(item) === String(id));
const engine = new SocialEngine({
  getConfig: () => global.config.bot.chatgpt.social,
  request: messages =>
    requestDecision(AxiosProxy.post, global.config.bot.chatgpt, global.config.bot.chatgpt.social, messages),
  send: (context, message) => global.replyMsg(context, message),
  allowed: context => {
    const { bot } = global.config;
    if (!bot.chatgpt.apiKey || logger.checkBan(context)) return false;
    if (bot.debug && String(context.user_id) !== String(bot.admin)) return false;
    if (context.message_type === 'private') return bot.enablePM;
    return (
      bot.enableGM &&
      (!bot.whiteGroup.size || contains(bot.whiteGroup, context.group_id)) &&
      !contains(bot.chatgpt.blackGroup, context.group_id) &&
      (!bot.chatgpt.whiteGroup.size || contains(bot.chatgpt.whiteGroup, context.group_id))
    );
  },
});

emitter.onConfigReload(() => engine.reset());

export const resetSocialGroup = groupId => engine.resetGroup(groupId);

export default context => {
  const { message } = context;
  // Leave image search, commands and non-text media to the existing handlers.
  if (typeof message !== 'string' || !message.trim() || message.includes('--')) return false;
  if (/\[CQ:(?!at,|reply,)/.test(message)) return false;
  if (/^(all|pixiv|danbooru|doujin|book|anime|原图)$/.test(message)) return false;
  const { regs } = global.config.bot;
  if ([regs.searchModeOn, regs.searchModeOff].some(regexp => regexp && new RegExp(regexp).test(message))) return false;
  return engine.observe(context);
};
