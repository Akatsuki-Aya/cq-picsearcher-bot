// Uses the existing bot.chatgpt endpoint/key/model; no DSH or tool-calling API is required.
export async function requestDecision(post, chatConfig, socialConfig, messages) {
  if (!chatConfig.apiKey) throw new Error('未配置 bot.chatgpt.apiKey');
  const params = { ...chatConfig.additionParams };
  // These options conflict with the plain JSON decision protocol.
  for (const key of ['tools', 'tool_choice', 'functions', 'function_call', 'response_format']) delete params[key];
  const { data } = await post(
    chatConfig.customChatAPI || 'https://api.openai.com/v1/chat/completions',
    {
      ...params,
      model: chatConfig.model,
      max_tokens: chatConfig.maxTokens || undefined,
      messages,
      stream: false,
      n: 1,
    },
    {
      headers: {
        Authorization: `Bearer ${chatConfig.apiKey}`,
        ...(chatConfig.organization ? { 'OpenAI-Organization': chatConfig.organization } : {}),
      },
      timeout: Number.isFinite(socialConfig.requestTimeoutMs)
        ? Math.max(1000, Math.min(180000, socialConfig.requestTimeoutMs))
        : 60000,
      maxContentLength: 1024 * 1024,
    },
  );
  if (data?.error) throw new Error(data.error.message || '模型接口错误');
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型没有返回决策文本');
  return content;
}
