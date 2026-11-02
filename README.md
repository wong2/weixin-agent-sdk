# weixin-agent-sdk

> 本项目非微信官方项目，代码由 [@tencent-weixin/openclaw-weixin](https://npmx.dev/package/@tencent-weixin/openclaw-weixin) 改造而来，仅供学习交流使用。

微信 AI Agent 桥接框架 —— 通过简单的 Agent 接口，将任意 AI 后端接入微信。

运行环境：Node.js **>=22.13.0**。

## 项目结构

```
packages/
  sdk/                  weixin-agent-sdk —— 微信桥接 SDK
  weixin-acp/           ACP (Agent Client Protocol) 适配器
  example-openai/       基于 OpenAI 的示例
```

## 通过 ACP 接入 Claude Code, Codex, kimi-cli 等 Agent

[ACP (Agent Client Protocol)](https://agentclientprotocol.com/) 是一个开放的 Agent 通信协议。如果你已有兼容 ACP 的 agent，可以直接通过 [`weixin-acp`](https://www.npmjs.com/package/weixin-acp) 接入微信，无需编写任何代码。


### Claude Code

```bash
npx weixin-acp claude-code
```

### Codex

```bash
npx weixin-acp codex
```

启用微信 ClawBot 的部分 Markdown 格式支持：

```bash
npx weixin-acp codex --output-format markdown
npx weixin-acp claude-code --output-format markdown
npx weixin-acp start --output-format markdown -- kimi acp
```

默认 `--output-format plain`，保持原有纯文本输出。

### 其它 ACP Agent

比如 kimi-cli：

```bash
npx weixin-acp start -- kimi acp
```

`--` 后面的部分就是你的 ACP agent 启动命令，`weixin-acp` 会自动以子进程方式启动它，通过 JSON-RPC over stdio 进行通信。

更多 ACP 兼容 agent 请参考 [ACP agent 列表](https://agentclientprotocol.com/get-started/agents)。

## 自定义 Agent

SDK 主要导出三样东西：

- **`Agent`** 接口 —— 实现它就能接入微信
- **`login()`** —— 扫码登录
- **`start(agent)`** —— 启动消息循环，立即返回可主动发消息的 `Bot`

### Agent 接口

```typescript
interface Agent {
  chat(request: ChatRequest): Promise<ChatResponse>;
}

interface ChatRequest {
  messageId?: string;             // 无损保存的微信消息 ID
  conversationId: string;         // 用户标识，可用于维护多轮对话
  text: string;                   // 文本内容
  quote?: {                       // 还原的引用，也会拼入 text 以兼容已有 Agent
    messageId?: string;
    text: string;
    partialText?: string;
    media?: ChatRequest["media"];
    missing?: boolean;
  };
  media?: {                       // 附件（图片/语音/视频/文件）
    type: "image" | "audio" | "video" | "file";
    filePath: string;             // 本地文件路径（已下载解密）
    mimeType: string;
    fileName?: string;
  };
}

interface ChatResponse {
  text?: string;
  outputFormat?: "plain" | "markdown"; // 覆盖 start() 的默认输出格式
  media?: {                       // 回复媒体
    type: "image" | "video" | "file";
    url: string;                  // 本地路径或 HTTPS URL
    fileName?: string;
  };
}
```

### 最简示例

```typescript
import { login, start, type Agent } from "weixin-agent-sdk";

const echo: Agent = {
  async chat(req) {
    return { text: `你说了: ${req.text}` };
  },
};

await login();
const bot = start(echo);
await bot.wait();
```

### 完整示例（自己管理对话历史）

```typescript
import { login, start, type Agent } from "weixin-agent-sdk";

const conversations = new Map<string, string[]>();

const myAgent: Agent = {
  async chat(req) {
    const history = conversations.get(req.conversationId) ?? [];
    history.push(req.text);

    // 调用你的 AI 服务...
    const reply = await callMyAI(history);

    history.push(reply);
    conversations.set(req.conversationId, history);
    return { text: reply };
  },
};

await login();
const bot = start(myAgent);
await bot.wait();
```

### 主动发送消息

`start()` 会立即返回 `Bot` 实例。`Bot` 提供了 `sendMessage()`，可以在收到微信消息之外，主动给当前登录用户发送内容；如果是 CLI/脚本程序，可以用 `bot.wait()` 等待消息循环结束。

```typescript
import { login, start, type Agent } from "weixin-agent-sdk";

const agent: Agent = {
  async chat(req) {
    if (req.text === "ping") {
      return { text: "pong" };
    }
    return { text: `收到：${req.text}` };
  },
};

await login();
const bot = start(agent);

setInterval(() => {
  void bot.sendMessage("定时提醒：记得查看最新状态");
}, 60_000);

await bot.wait();
```

也可以主动发送完整的 `ChatResponse`，包括图片、视频或文件：

```typescript
await bot.sendMessage({
  text: "这是最新报表",
  media: {
    type: "file",
    url: "./reports/daily.pdf",
    fileName: "daily.pdf",
  },
});
```

注意事项：

- 主动发送依赖微信下发的 `context_token`
- 至少收到过当前账号的一条入站消息后，token 会持久化，重启时自动恢复
- `context_token` 的有效期由微信服务端决定；过期后需要再次收到新消息
- HTTP 请求成功但服务端返回非零 `ret` 时，`sendMessage()` 也会抛错；调用方应处理异常

### 输出格式与发送 hooks

```typescript
const bot = start(agent, {
  outputFormat: "markdown",              // 默认 plain
  botAgent: "MyAssistant/1.0",            // 可选，应用观测标识，不参与鉴权
  hooks: {
    beforeSend(message, context) {
      // 返回修改后的 ChatResponse；返回 false 取消；返回 undefined 保持原样
      return message;
    },
    afterSend({ conversationId, error }) {
      if (error) console.error("发送失败", conversationId, error);
    },
  },
});

await bot.sendMessage("**更新完成**\n[查看详情](https://example.com/a_b_c)");
await bot.sendMessage({ text: "**纯文本通知**", outputFormat: "plain" });
```

两种格式都用于 Agent 自动回复、主动发送和媒体说明。`plain` 将链接转换为「标题 + 换行 + URL」，标题与 URL 相同则只保留一次。`markdown` 保留链接、粗体、代码块、行内代码和表格，过滤图片语法、五六级标题以及含中日韩文字的斜体；链接中的下划线和括号保持完整。具体渲染效果取决于微信客户端版本。

Hooks 作用于 Agent 回复和 `Bot.sendMessage()`，不拦截 SDK 自己生成的斜杠命令回复或错误提示。`beforeSend` 在格式转换和媒体上传之前运行；抛错时记录日志并继续发送原消息。`afterSend` 在一次回复的全部发送操作成功或失败后调用，失败不会覆盖发送结果。被取消的消息不触发 `afterSend`。

### 验证码登录

CLI 遇到二次验证会提示输入手机微信显示的数字。非交互应用通过回调提供验证码：

```typescript
await login({
  onVerifyCode: async ({ retry, signal }) => {
    return await requestCodeFromYourUI({ retry, signal });
  },
  abortSignal: controller.signal,
  timeoutMs: 480_000,
});
```

`signal` 表示此次登录取消或超时，应用应结束对应的输入流程。验证码最多提交三次；服务端返回验证码阻止状态时会有限次刷新二维码。微信提示已绑定且本地账号可确定时，`login()` 返回已有账号 ID。

### 引用消息缓存

默认启用 SQLite 缓存，还原新版微信仅携带 `svr_id` 的引用，包括局部文字和附件。消息 ID 始终为字符串。缓存按账号、会话隔离，位于 `~/.openclaw/weixin-agent-sdk/quotes/`（可通过 `OPENCLAW_STATE_DIR` 修改根目录）。

```typescript
const bot = start(agent, {
  quoteCache: {
    enabled: true,
    retentionDays: 30,
    maxMessagesPerAccount: 10_000,
    mediaRetentionDays: 7,
    maxMediaBytesPerAccount: 256 * 1024 * 1024,
    maxSingleMediaBytes: 25 * 1024 * 1024,
  },
});
```

以上为默认值。设置 `quoteCache: { enabled: false }` 可关闭缓存；SQLite 不可用时也会自动关闭，正常收发继续。缓存未命中时会给 Agent「引用消息内容未缓存」提示；附件过期时会标明附件已过期。只有启用缓存后收发并成功记录的消息才能按 ID 还原。

引用附件通过 `request.quote.media` 提供；当前消息没有附件时，也会填入 `request.media` 以兼容已有 Agent。ACP 和 OpenAI 示例能同时处理当前附件和引用附件。`logout()` 会删除当前注册账号的 context token 和引用缓存；退出前应先停止 bot。

### OpenAI 示例

`packages/example-openai/` 是一个完整的 OpenAI Agent 实现，支持多轮对话和图片输入：

```bash
pnpm install

# 扫码登录微信
pnpm run login -w packages/example-openai

# 启动 bot
OPENAI_API_KEY=sk-xxx pnpm run start -w packages/example-openai
```

支持的环境变量：

| 变量 | 必填 | 说明 |
|------|------|------|
| `OPENAI_API_KEY` | 是 | OpenAI API Key |
| `OPENAI_BASE_URL` | 否 | 自定义 API 地址（兼容 OpenAI 接口的第三方服务） |
| `OPENAI_MODEL` | 否 | 模型名称，默认 `gpt-5.4` |
| `SYSTEM_PROMPT` | 否 | 系统提示词 |

## 支持的消息类型

### 接收（微信 → Agent）

| 类型 | `media.type` | 说明 |
|------|-------------|------|
| 文本 | — | `request.text` 直接拿到文字 |
| 图片 | `image` | 自动从 CDN 下载解密，`filePath` 指向本地文件 |
| 语音 | `audio` | SILK 格式自动转 WAV（需安装 `silk-wasm`） |
| 视频 | `video` | 自动下载解密 |
| 文件 | `file` | 自动下载解密，保留原始文件名 |
| 引用消息 | — | 被引用的文本拼入 `request.text`，被引用的媒体作为 `media` 传入 |
| 语音转文字 | — | 微信侧转写的文字直接作为 `request.text` |

### 发送（Agent → 微信）

| 类型 | 用法 |
|------|------|
| 文本 | 返回 `{ text: "..." }` |
| 图片 | 返回 `{ media: { type: "image", url: "/path/to/img.png" } }` |
| 视频 | 返回 `{ media: { type: "video", url: "/path/to/video.mp4" } }` |
| 文件 | 返回 `{ media: { type: "file", url: "/path/to/doc.pdf" } }` |
| 文本 + 媒体 | `text` 和 `media` 同时返回，文本作为附带说明发送 |
| 远程图片 | `url` 填 HTTPS 链接，SDK 自动下载后上传到微信 CDN |
| 主动发送 | 通过 `const bot = start(agent)` 后调用 `bot.sendMessage(...)` |

## 内置斜杠命令

在微信中发送以下命令：

- `/echo <消息>` —— 直接回复（不经过 Agent），附带通道耗时统计
- `/toggle-debug` —— 开关 debug 模式，启用后每条回复追加全链路耗时

## 技术细节

- 使用 **长轮询** (`getUpdates`) 接收消息，无需公网服务器
- 媒体文件通过微信 CDN 中转，**AES-128-ECB** 加密传输
- 单账号模式：每次 `login` 覆盖之前的账号
- 断点续传：`get_updates_buf` 持久化到 `~/.openclaw/`，重启后从上次位置继续
- token 失效（errcode -14）触发 1 小时冷却，并提示重新登录
- 启停时发送 `notifyStart` / `notifyStop`；通知失败不阻断消息循环
- Node.js >= 22.13.0

## Star History

<a href="https://www.star-history.com/?repos=wong2%2Fweixin-agent-sdk&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=wong2/weixin-agent-sdk&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=wong2/weixin-agent-sdk&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=wong2/weixin-agent-sdk&type=date&legend=top-left" />
 </picture>
</a>
