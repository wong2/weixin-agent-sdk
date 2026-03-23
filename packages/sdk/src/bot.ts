import type { Agent, ChatResponse } from "./agent/interface.js";
import {
  DEFAULT_BASE_URL,
  listWeixinAccountIds,
  normalizeAccountId,
  registerWeixinAccountId,
  resolveWeixinAccount,
  saveWeixinAccount,
} from "./auth/accounts.js";
import {
  DEFAULT_ILINK_BOT_TYPE,
  startWeixinLoginWithQr,
  waitForWeixinLogin,
} from "./auth/login-qr.js";
import { getContextToken } from "./messaging/inbound.js";
import { deliverChatResponse } from "./messaging/deliver.js";
import { monitorWeixinProvider } from "./monitor/monitor.js";
import { logger } from "./util/logger.js";

export type LoginOptions = {
  /** Override the API base URL. */
  baseUrl?: string;
  /** Log callback (defaults to console.log). */
  log?: (msg: string) => void;
};

/**
 * A handle returned by `start()` that lets you push messages to users
 * without waiting for them to write first.
 *
 * > **Note:** `send()` requires a `contextToken` that is only available after
 * > the target user has sent at least one message to the bot in the current
 * > process session. Calling `send()` before that will throw.
 */
export interface MessageSender {
  /**
   * Proactively send a message to a WeChat user.
   *
   * @param to - The WeChat user ID (same as `ChatRequest.conversationId`).
   * @param response - The message to send (text, media, or multiple messages).
   * @throws If the user has not messaged the bot yet in this session.
   */
  send(to: string, response: ChatResponse): Promise<void>;
}

export type StartOptions = {
  /** Account ID to use. Auto-selects the first registered account if omitted. */
  accountId?: string;
  /** AbortSignal to stop the bot. */
  abortSignal?: AbortSignal;
  /** Log callback (defaults to console.log). */
  log?: (msg: string) => void;
  /**
   * Called once the bot is initialised and ready to receive **and send**
   * messages.  Use the provided `MessageSender` to push proactive messages.
   *
   * @example
   * await start(agent, {
   *   onReady(sender) {
   *     // Send a daily digest every hour
   *     setInterval(async () => {
   *       await sender.send(userId, { text: "⏰ Hourly update: everything looks good!" });
   *     }, 3_600_000);
   *   },
   * });
   */
  onReady?: (sender: MessageSender) => void;
};

/**
 * Interactive QR-code login. Prints the QR code to the terminal and waits
 * for the user to scan it with WeChat.
 *
 * Returns the normalized account ID on success.
 */
export async function login(opts?: LoginOptions): Promise<string> {
  const log = opts?.log ?? console.log;
  const apiBaseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL;

  log("正在启动微信扫码登录...");

  const startResult = await startWeixinLoginWithQr({
    apiBaseUrl,
    botType: DEFAULT_ILINK_BOT_TYPE,
  });

  if (!startResult.qrcodeUrl) {
    throw new Error(startResult.message);
  }

  log("\n使用微信扫描以下二维码，以完成连接：\n");
  try {
    const qrcodeterminal = await import("qrcode-terminal");
    await new Promise<void>((resolve) => {
      qrcodeterminal.default.generate(startResult.qrcodeUrl!, { small: true }, (qr: string) => {
        console.log(qr);
        resolve();
      });
    });
  } catch {
    log(`二维码链接: ${startResult.qrcodeUrl}`);
  }

  log("\n等待扫码...\n");

  const waitResult = await waitForWeixinLogin({
    sessionKey: startResult.sessionKey,
    apiBaseUrl,
    timeoutMs: 480_000,
    botType: DEFAULT_ILINK_BOT_TYPE,
  });

  if (!waitResult.connected || !waitResult.botToken || !waitResult.accountId) {
    throw new Error(waitResult.message);
  }

  const normalizedId = normalizeAccountId(waitResult.accountId);
  saveWeixinAccount(normalizedId, {
    token: waitResult.botToken,
    baseUrl: waitResult.baseUrl,
    userId: waitResult.userId,
  });
  registerWeixinAccountId(normalizedId);

  log("\n✅ 与微信连接成功！");
  return normalizedId;
}

/**
 * Start the bot — long-polls for new messages and dispatches them to the agent.
 * Blocks until the abort signal fires or an unrecoverable error occurs.
 *
 * If `opts.onReady` is provided it is called synchronously before the long-poll
 * loop starts, receiving a `MessageSender` that can be used to push messages
 * proactively to users who have previously initiated a conversation.
 */
export async function start(agent: Agent, opts?: StartOptions): Promise<void> {
  const log = opts?.log ?? console.log;

  // Resolve account
  let accountId = opts?.accountId;
  if (!accountId) {
    const ids = listWeixinAccountIds();
    if (ids.length === 0) {
      throw new Error("没有已登录的账号，请先运行 login");
    }
    accountId = ids[0];
    if (ids.length > 1) {
      log(`[weixin] 检测到多个账号，使用第一个: ${accountId}`);
    }
  }

  const account = resolveWeixinAccount(accountId);
  if (!account.configured) {
    throw new Error(
      `账号 ${accountId} 未配置 (缺少 token)，请先运行 login`,
    );
  }

  log(`[weixin] 启动 bot, account=${account.accountId}`);

  // Build MessageSender and notify caller before the long-poll loop starts.
  if (opts?.onReady) {
    const sender: MessageSender = {
      async send(to: string, response: ChatResponse): Promise<void> {
        const contextToken = getContextToken(account.accountId, to);
        if (!contextToken) {
          throw new Error(
            `[weixin] MessageSender.send: no context token for user "${to}". ` +
            `The user must send at least one message to the bot first.`,
          );
        }
        await deliverChatResponse(response, to, contextToken, {
          baseUrl: account.baseUrl,
          cdnBaseUrl: account.cdnBaseUrl,
          token: account.token,
        });
      },
    };
    opts.onReady(sender);
    logger.debug("start: onReady callback fired");
  }

  await monitorWeixinProvider({
    baseUrl: account.baseUrl,
    cdnBaseUrl: account.cdnBaseUrl,
    token: account.token,
    accountId: account.accountId,
    agent,
    abortSignal: opts?.abortSignal,
    log,
  });
}
