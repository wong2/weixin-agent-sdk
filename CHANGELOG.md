# Changelog

## Unreleased

### Breaking changes 与升级注意事项

- **运行环境**：`weixin-agent-sdk` 和 `weixin-acp` 的最低 Node.js 版本均从 `22` 提升至 `22.13.0`，使用 Node.js 22.0～22.12 的应用需要先升级运行环境。
- **发送错误处理**：HTTP 200 但服务端返回非零 `ret` 时，`bot.sendMessage()` 现在会 reject，自动回复流程也会进入错误处理；此前此类失败可能被当作成功。调用方应捕获发送异常，尤其是定时任务中的主动发送。
- **非交互登录**：服务端要求验证码时，交互 CLI 会提示输入；非交互应用需要通过 `login({ onVerifyCode })` 提供验证码，并处理回调中的取消信号，否则登录会明确失败。
- **默认持久化**：context token 会落盘并在重启后恢复；引用缓存默认开启，文字保留 30 天、每账号最多 10,000 条，附件保留 7 天、每账号最多 256 MiB、单文件最多 25 MiB。可通过 `start(agent, { quoteCache: { enabled: false } })` 关闭引用缓存；该选项不关闭 context token 持久化。
- **Agent 输入变化**：按 ID 还原的引用及局部引用会补入 `request.text`；未缓存或附件过期时也会加入文字提示。依赖完整输入文本严格匹配的应用需要适配。结构化引用通过可选的 `request.quote` 提供。
- **启停时序**：启动和停止新增状态通知，请求失败不阻断运行，但可能增加等待时间；停止通知使用独立的 10 秒默认超时，因此取消长轮询后 `bot.wait()` 可能继续等待通知结束。
- **保持兼容的部分**：`Agent.chat()`、`start()`、`bot.sendMessage()` 的现有调用方式和返回类型保持不变；新增公开字段均可选。默认仍为 `plain` 输出，只有显式指定 `outputFormat: "markdown"` 或 CLI 的 `--output-format markdown` 才启用 Markdown 模式。

### weixin-agent-sdk

- **feat**: 同步 `@tencent-weixin/openclaw-weixin@2.4.10` 的 SDK 相关能力：验证码与已绑定登录、context token 持久化、无损消息 ID、引用文字/附件 SQLite 缓存、生命周期通知、应用标识及网络错误分类
- **feat**: 新增 `StartOptions.outputFormat` 与单条回复 `outputFormat`，支持保留部分 Markdown；默认仍为纯文本
- **feat**: 新增 `beforeSend` / `afterSend` 应用消息 hooks，自动回复和主动发送共用发送流程
- **fix**: 校验发送接口业务返回值，服务端拒绝发送时抛错；移除手动 Content-Length，构建时嵌入版本号，并补齐应用请求头
- **change**: Node.js 最低版本提升至 `22.13.0`；引用缓存默认启用，可配置保留时间、容量或关闭；此次不包含工具调用进度
- **fix**: Markdown 链接转换为标题和换行后的完整 URL，标题与 URL 相同时仅保留一次；支持链接地址中的嵌套括号，并避免格式清理破坏 URL 中的下划线等字符

### weixin-acp

- **feat**: 新增 `--output-format plain|markdown`，并支持同时向 Agent 提供当前附件和引用附件

## 0.5.0 (2026-04-19)

### weixin-agent-sdk

- **fix**: `start(agent)` 现在会立即返回 `Bot` 实例，并新增 `bot.wait()` 用于等待后台消息循环结束，修复主动发送示例在停止前拿不到 `bot` 的问题

## 0.4.0 (2026-04-05)

### weixin-agent-sdk

- **feat**: `start(agent)` 现在返回 `Bot` 实例，支持通过 `bot.sendMessage()` 主动向当前登录账号发送文本、图片、视频和文件
- **fix**: 会话过期时给出更明确的重新登录提示
- **docs**: 补充 `Bot.sendMessage()` 的使用说明和注意事项

## 0.5.0 (2026-03-24)

### weixin-acp

- **feat**: 启动 agent 时自动检测登录状态，未登录则自动触发扫码登录
- **feat**: 新增 `logout` 命令，支持清除已保存的登录凭证
- **fix**: 定期重发 typing 状态，防止超时
- **fix**: 改进 ACP tool-call 日志的 fallback 链
- **fix**: 修复 ACP 权限自动审批中的 optionId 字段

### weixin-agent-sdk

- **feat**: 新增 `isLoggedIn()` 函数，检查是否已登录
- **feat**: 新增 `logout()` 函数，清除所有账号凭证

## 0.4.0 (2026-03-24)

### weixin-acp

- **feat**: 内置 `claude-code` 和 `codex` 快捷命令，无需单独安装 `@zed-industries/claude-agent-acp` 和 `@zed-industries/codex-acp`
- **feat**: 添加 `/clear` 斜杠命令，支持重置对话会话
- **fix**: Ctrl+C 时立即中断长轮询请求，不再卡住等待超时
- **fix**: ACP 子进程退出时自动清除会话缓存
- **fix**: 改进二维码显示的中文提示，始终显示 URL 链接

## 0.2.0 (2026-03-23)

### weixin-acp

- **feat**: 支持 Windows 平台（修复 `child_process.spawn` 对特殊后缀的识别问题）
- **fix**: 修复 README 中 shell 示例的注释语法

### weixin-agent-sdk

- 首次发布到 npm

## 0.1.0 (2026-03-22)

- 初始发布
- **weixin-agent-sdk**: 微信 AI Agent 桥接 SDK，支持文本、图片、语音、视频、文件收发
- **weixin-acp**: ACP (Agent Client Protocol) 适配器，可接入任意 ACP 兼容 agent
- **example-openai**: 基于 OpenAI 的完整示例，支持多轮对话和图片输入
