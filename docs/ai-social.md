# AI 社交仿真（直接调用大模型 API）

参考 [qq-bridge 的仿真模式](https://github.com/Derpyu520/qq-bridge)中观察、发言、等待、潜水的思路，实现独立的 API 驱动调度器。无需安装 DeepSeek Harness、DSH preset 或 MCP 服务。

模型接收当前会话的最近消息（包括发言人、消息 ID、时间和自己的历史发言），自主选择：

- `speak`：现在说或延迟几秒再说；面向当前群，或选择记录中的群友 @ / 引用回复。
- `wait`：暂时不说，指定等待时间后重新判断。没有新消息也可以被唤醒，再决定是否主动接话。
- `silent`：保持沉默，直到下次收到普通聊天消息。

它不是按随机概率自动回复。模型决定行为，本地调度器负责限制频率、校验对象和执行。被 @ 也不会强制必回。

## 配置

在根目录 `config.jsonc` 的 `bot.chatgpt` 中合并以下配置，不要用它替换整个配置文件：

```jsonc
{
  "enable": false,
  "apiKey": "你的 API Key",
  "model": "服务商提供的模型名称",
  "useChatAPI": true,
  "customChatAPI": "https://你的服务商域名/v1/chat/completions",
  "social": {
    "enable": true,
    "groups": [123456789],
    "privateUsers": [],
    "persona": "你是竹竹，一个温和、有幽默感的 AI 群友。喜欢动漫和游戏，回答自然简短，没必要时就潜水。"
  }
}
```

替换 API 地址、模型、密钥和群号。`customChatAPI` 必须是完整的 Chat Completions 地址；留空时使用项目内置的 OpenAI 地址。服务商需要支持 `messages`、Bearer 鉴权，并返回 `choices[0].message.content`；模型需要能按提示词输出 JSON，不要求支持工具调用或 JSON Schema 模式。此功能不支持 Anthropic 原生接口或 Responses 接口格式。

两个 `enable` 独立：外层控制原有 `chatgpt 问题` 指令，`social.enable` 控制社交模式，两者可同时开启。社交模式始终调用 Chat Completions，不受 `useChatAPI` 影响。

`groups` 和 `privateUsers` 是明确启用的群号和私聊 QQ 号，空数组表示不启用任何对应会话。还需开启原项目的 `bot.enableGM` / `bot.enablePM`，并满足全局群白名单、封禁规则、ChatGPT 群黑白名单。调试模式沿用仅处理管理员消息的行为。

社交模式复用 `bot.chatgpt` 的 `apiKey`、`model`、`customChatAPI`、`organization`、`maxTokens`、`additionParams`，以及 `bot.proxy`。人设单独使用 `social.persona`；不读取命令正则对应的 `overrides`，也不拼入普通指令的 `prependMessages`。额外参数中的流式输出、多候选和工具调用选项会被固定或移除，以保持决策协议一致。

配置重载会清空社交上下文和定时任务，旧请求返回后不会继续发言。更改配置后可重启机器人，或使用项目已有的配置重载方式。

## 节奏与用量

机器人管理员（`bot.admin` 配置的 QQ 号）可在目标群发送 `--social-reset`，手动清除该群的社交会话。普通群成员及未配置为 `bot.admin` 的群主/群管理员无此权限。

命令清空本群上下文、取消待发送回复和定时唤醒，并让正在请求中的旧模型结果失效；下次普通聊天会从新会话开始。其他群和私聊不受影响，人设配置及全局每日用量不重置。已提交给 QQ 的发送无法撤回。请在目标群执行，私聊不支持指定群号清除。

上下文本身也有滚动上限：默认仅保留最近 30 条，每条最多 1000 字，并不会随聊天次数无限增长。若只是控制请求长度，可以调小 `contextMessages` 和 `messageMaxChars`。

完整默认值见 `config.default.jsonc` 的 `bot.chatgpt.social`。

| 配置 | 默认 | 含义 |
| --- | --- | --- |
| `contextMessages` | 30 | 每个会话最多保留的消息数 |
| `messageMaxChars` | 1000 | 每条输入文本的最大长度 |
| `maxReplyChars` | 500 | 单次发言最大长度 |
| `debounceMs` | 3000 | 首条消息到来后等待，合并连续聊天 |
| `decisionIntervalMs` | 15000 | 同会话两次模型请求最小间隔 |
| `replyIntervalMs` | 30000 | 同会话发言尝试后的冷却时间 |
| `requestTimeoutMs` | 60000 | 模型请求超时 |
| `maxWaitSeconds` | 300 | 模型单次等待/延迟发送的最大秒数 |
| `maxAutoTurns` | 2 | 没有新消息时最多自动重新判断次数；0 关闭自动唤醒 |
| `idleExpireMs` | 600000 | 距最后一条人类消息多久后停止唤醒/发送 |
| `dailyDecisionLimit` | 200 | 所有会话合计每日模型请求尝试上限 |
| `dailyReplyLimit` | 50 | 所有会话合计每日发言尝试上限 |
| `maxSessions` | 100 | 内存中最多保留的会话数 |

每日限额包含失败的尝试，按运行机器的本地日期重置；进程重启也会清零。它独立于原有 `userDailyLimit`。决策也会调用模型，即使最终沉默也会产生 API 用量。达到限额后停止决策/发言，次日收到消息可恢复。

新消息会取消尚未发出的旧回复。模型请求过程中收到新消息时，保留新消息、丢弃旧决策并在限频后重新判断。持续高速聊天时可能一直观望；模型不会在完全没有会话输入的情况下凭空启动聊天。成功发言后不自行循环续说，只有新消息或此前选择的 `wait` 才会推动下一次决策。

## 与现有功能的关系

- 原有管理员命令、语言库、ChatGPT 指令、语音等通用插件先处理。
- 搜图开关、搜图库选择、包含 `--` 的指令及图片等非文本消息继续交给原逻辑。
- 被社交模式接管的普通聊天不会触发默认回复或复读；模型选择沉默时不会发送占位文本。
- 各群和各私聊上下文隔离。“对谁说”是在当前会话选择对象，不会从群聊跳去私聊，也不会跨群发送。
- 所选 @ 用户和引用消息必须存在于该会话最近上下文中；模型正文中的 CQ 码按普通文本发送。
- API 错误、无效 JSON、伪造目标等只记录本地错误，不把报错刷进群。

本实现覆盖文本社交决策，不包含参考项目的图片理解、表情包库、联网搜索、黑话学习、管理控制台或持久化长期记忆。上下文、唤醒安排和次数保存在内存，重启清空。只观察启用后的、未被前置插件消费的普通聊天消息；已保留记录以外的引用不会自动调用 `get_msg` 拉取原文。

## 代码与验证

- `src/plugin/social/engine.mjs`：会话上下文、决策解析、调度和发送对象校验。
- `src/plugin/social/api.mjs`：Chat Completions HTTP 请求适配。
- `src/plugin/social/index.mjs`：与现有配置、权限和 QQ 回复函数对接。
- `src/index.mjs`：通用消息处理末尾接入社交插件。

运行 `npm run test:social` 执行离线测试，不启动 QQ、不调用真实 API。测试使用 Node.js 内置测试运行器和可控时钟，涵盖沉默/等待/发言、并发消息、权限撤销、限额、会话隔离和接口参数。
