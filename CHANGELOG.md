# Changelog

## Unreleased

### weixin-agent-sdk

- **fix**: Markdown 链接转换为标题和换行后的完整 URL，标题与 URL 相同时仅保留一次；支持链接地址中的嵌套括号，并避免格式清理破坏 URL 中的下划线等字符

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
