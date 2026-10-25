// Deliberately exclude request/response bodies, headers, URLs and exception messages.
export function errorDetails(error) {
  const reasons = {
    '无效的社交决策': 'invalid_action',
    '发言内容为空': 'empty_reply',
    '目标用户不在当前会话上下文中': 'unknown_target',
    '引用消息不在当前会话上下文中': 'unknown_quote',
    '无效的用户 ID': 'invalid_target_id',
    '无效的消息 ID': 'invalid_quote_id',
    '模型没有返回决策文本': 'empty_model_response',
    'QQ 消息发送失败或客户端未就绪': 'qq_send_failed',
  };
  return {
    reason: Object.hasOwn(reasons, error?.message) ? reasons[error.message] : undefined,
    errorType: ['SyntaxError', 'TypeError', 'AxiosError', 'Error'].includes(error?.name) ? error.name : 'Error',
    code: ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE'].includes(error?.code)
      ? error.code : undefined,
    httpStatus: typeof error?.response?.status === 'number' ? error.response.status : undefined,
  };
}

export function writeDiagnostic(enabled, context, event, details = {}, output = console.log) {
  if (!enabled) return;
  output('[social]', JSON.stringify({
    time: new Date().toISOString(),
    event,
    session: context?.message_type === 'group' ? `group:${context.group_id}`
      : context?.message_type === 'private' ? `private:${context.user_id}` : undefined,
    messageId: context?.message_id == null ? undefined : String(context.message_id),
    ...details,
  }));
}
