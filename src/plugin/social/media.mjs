// Keep media URLs separate from the bounded transcript text.
const decode = value => String(value || '').replace(/&#44;/g, ',').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&');
const imageUrl = value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && value.length <= 8192 ? value : null;
  } catch { return null; }
};

export function parseSocialMessage(message) {
  const images = [];
  let supported = true;
  const text = String(message).replace(/\[CQ:([^,\]]+)([^\]]*)\]/g, (raw, type, attrs) => {
    const data = Object.fromEntries(attrs.split(',').filter(Boolean).map(pair => {
      const pos = pair.indexOf('=');
      return [pair.slice(0, pos), decode(pair.slice(pos + 1))];
    }));
    if (type === 'image') {
      const url = imageUrl(data.url) || imageUrl(data.file);
      if (url && images.length < 4) {
        images.push(url);
        return `[图片${images.length}${data.summary ? `：${data.summary.slice(0, 100)}` : ''}]`;
      }
      return '[图片未提供或超出可读取数量]';
    }
    if (['face', 'mface', 'bface', 'sface'].includes(type)) {
      const url = imageUrl(data.url);
      if (url && images.length < 4) images.push(url);
      return `[表情：${(data.summary || data.text || data.id || '未知').slice(0, 100)}]`;
    }
    if (!['at', 'reply'].includes(type)) supported = false;
    return raw;
  });
  return { text: decode(text), images, supported };
}

export function attachImages(messages, history) {
  const parts = [{ type: 'text', text: messages[1].content }];
  // Bound total visual context, favoring the most recent messages.
  let remaining = 12;
  const selected = history.map(() => []);
  for (let i = history.length - 1; i >= 0 && remaining; i--) {
    selected[i] = (history[i].images || []).slice(0, remaining);
    remaining -= selected[i].length;
  }
  selected.forEach((urls, i) => urls.forEach((url, j) => {
    parts.push({ type: 'text', text: `聊天记录第 ${i + 1} 条，消息 ID ${history[i].messageId}，附件 ${j + 1}` },
      { type: 'image_url', image_url: { url } });
  }));
  if (parts.length > 1) messages[1].content = parts;
  return messages;
}
