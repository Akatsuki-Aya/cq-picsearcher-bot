// These tools use a dedicated DeepSeek key, regardless of the conversation provider.
export async function requestWeb(post, config, decision) {
  if (!config.enable || !config.apiKey) throw new Error('网页工具未配置');
  if (!['search', 'fetch'].includes(decision.action)) throw new Error('无效的网页工具');
  const body = decision.action === 'search'
    ? { query: decision.query, count: 3, need_content: false }
    : { url: decision.url };
  const { data } = await post(`https://api.deepseek.com/v1/tools/${decision.action}`, body, {
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    timeout: 20000, maxContentLength: 2 * 1024 * 1024,
  });
  if (data?.error || !data) throw new Error('网页工具响应错误');
  const clip = (value, length) => typeof value === 'string' ? value.slice(0, length) : '';
  if (decision.action === 'fetch') {
    if (typeof data.content !== 'string' || !data.content.trim()) throw new Error('网页正文为空');
    return { url: decision.url, title: clip(data.title, 300), content: clip(data.content, 12000) };
  }
  if (!Array.isArray(data.results)) throw new Error('无效的搜索响应');
  return { results: data.results.slice(0, 3).map(item => ({
    title: clip(item.title, 300), url: clip(item.url, 2000),
    summary: clip(item.summary || item.snippet, 1500), date: clip(item.date, 100),
  })) };
}
