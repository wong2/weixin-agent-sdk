import { createInterface } from "node:readline/promises";

import type { Agent, ChatResponse } from "./agent/interface.js";
import {
  clearAllWeixinAccounts,
  DEFAULT_BASE_URL,
  listWeixinAccountIds,
  loadWeixinAccount,
  normalizeAccountId,
  registerWeixinAccountId,
  resolveWeixinAccount,
  saveWeixinAccount,
} from "./auth/accounts.js";
import {
  DEFAULT_ILINK_BOT_TYPE,
  startWeixinLoginWithQr,
  waitForWeixinLogin,
  type VerifyCodeHandler,
} from "./auth/login-qr.js";
import { getContextToken } from "./messaging/inbound.js";
import {
  clearContextTokensForAccount,
  restoreContextTokens,
} from "./messaging/context-tokens.js";
import { sendChatResponse, type MessageHooks } from "./messaging/outbound.js";
import type { OutputFormat } from "./messaging/markdown.js";
import {
  QuoteStore,
  quoteCacheRoot,
  resolveQuoteCachePolicy,
  deleteQuoteCacheForAccount,
  type QuoteCacheOptions,
} from "./messaging/quote-store.js";
import { notifyStart, notifyStop } from "./api/api.js";
import { monitorWeixinProvider } from "./monitor/monitor.js";

export type LoginOptions = {
  /** Called when WeChat requests the digits shown on the phone. Defaults to terminal input on a TTY. */
  onVerifyCode?: VerifyCodeHandler;
  abortSignal?: AbortSignal;
  /** Overall login deadline, including QR acquisition and verification (default 8 minutes). */
  timeoutMs?: number;
  /** Override the API base URL. */
  baseUrl?: string;
  /** Log callback (defaults to console.log). */
  log?: (msg: string) => void;
};

export type StartOptions = {
  /** Plain text remains the default. */
  outputFormat?: OutputFormat;
  botAgent?: string;
  quoteCache?: QuoteCacheOptions;
  hooks?: MessageHooks;
  /** Account ID to use. Auto-selects the first registered account if omitted. */
  accountId?: string;
  /** AbortSignal to stop the bot. */
  abortSignal?: AbortSignal;
  /** Log callback (defaults to console.log). */
  log?: (msg: string) => void;
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
  const signal = AbortSignal.any([
    AbortSignal.timeout(opts?.timeoutMs ?? 480_000),
    ...(opts?.abortSignal ? [opts.abortSignal] : []),
  ]);
  const onVerifyCode: VerifyCodeHandler =
    opts?.onVerifyCode ??
    (async ({ retry, signal }) => {
      if (!process.stdin.isTTY)
        throw new Error("非交互登录需要提供 onVerifyCode 回调");
      const terminal = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return await terminal.question(
          retry ? "验证码不匹配，请重新输入：" : "请输入手机微信显示的数字：",
          { signal },
        );
      } finally {
        terminal.close();
      }
    });

  log("正在启动微信扫码登录...");

  const startResult = await startWeixinLoginWithQr({
    apiBaseUrl,
    botType: DEFAULT_ILINK_BOT_TYPE,
    abortSignal: signal,
  });

  if (!startResult.qrcodeUrl) {
    throw new Error(startResult.message);
  }

  log("\n使用微信扫描以下二维码，以完成连接：\n");
  try {
    const qrcodeterminal = await import("qrcode-terminal");
    await new Promise<void>((resolve) => {
      qrcodeterminal.default.generate(
        startResult.qrcodeUrl!,
        { small: true },
        (qr: string) => {
          console.log(qr);
          resolve();
        },
      );
    });
  } catch {
    log(`二维码链接: ${startResult.qrcodeUrl}`);
  }

  log("\n等待扫码...\n");

  const waitResult = await waitForWeixinLogin({
    sessionKey: startResult.sessionKey,
    apiBaseUrl,
    timeoutMs: opts?.timeoutMs ?? 480_000,
    onVerifyCode,
    botType: DEFAULT_ILINK_BOT_TYPE,
    abortSignal: signal,
  });

  if (waitResult.alreadyConnected) {
    const ids = listWeixinAccountIds();
    const id = waitResult.accountId
      ? normalizeAccountId(waitResult.accountId)
      : ids.length === 1
        ? ids[0]
        : undefined;
    if (!id || !loadWeixinAccount(id)?.token)
      throw new Error("微信提示已绑定，但无法确定对应的本地账号，请重新登录");
    log(waitResult.message);
    return id;
  }

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
 * Remove all stored WeChat account credentials.
 */
export function logout(opts?: { log?: (msg: string) => void }): void {
  const log = opts?.log ?? console.log;
  const ids = listWeixinAccountIds();
  if (ids.length === 0) {
    log("当前没有已登录的账号");
    return;
  }
  for (const id of ids) {
    clearContextTokensForAccount(id);
    deleteQuoteCacheForAccount(id);
  }
  clearAllWeixinAccounts();
  log("✅ 已退出登录");
}

/**
 * Check whether at least one WeChat account is logged in and configured.
 */
export function isLoggedIn(): boolean {
  const ids = listWeixinAccountIds();
  if (ids.length === 0) return false;
  const account = resolveWeixinAccount(ids[0]);
  return account.configured;
}

/**
 * A running bot instance — provides proactive messaging capability.
 *
 * - `sendMessage(text)` — send a text message to the logged-in user.
 * - `sendMessage(response)` — send a ChatResponse (text and/or media).
 */
export class Bot {
  private readonly _accountId: string;
  private readonly _baseUrl: string;
  private readonly _cdnBaseUrl: string;
  private readonly _token?: string;
  private readonly _userId: string;
  private readonly _monitorPromise: Promise<void>;
  private readonly _options: StartOptions;
  private readonly _quoteStore: Promise<QuoteStore | null>;

  /** @internal */
  constructor(params: {
    accountId: string;
    baseUrl: string;
    cdnBaseUrl: string;
    token?: string;
    userId: string;
    monitorPromise: Promise<void>;
    options?: StartOptions;
    quoteStore?: Promise<QuoteStore | null>;
  }) {
    this._options = params.options ?? {};
    this._quoteStore = params.quoteStore ?? Promise.resolve(null);
    this._accountId = params.accountId;
    this._baseUrl = params.baseUrl;
    this._cdnBaseUrl = params.cdnBaseUrl;
    this._token = params.token;
    this._userId = params.userId;
    this._monitorPromise = params.monitorPromise;
    this._monitorPromise.catch(() => {
      // Errors are re-thrown to callers that explicitly wait for the bot.
    });
  }

  /**
   * Wait until the background WeChat monitor stops.
   *
   * This is useful for CLI programs that should keep running until the bot is
   * aborted, and for surfacing unrecoverable monitor errors to the caller.
   */
  async wait(): Promise<void> {
    await this._monitorPromise;
  }

  /**
   * Proactively send a message to the logged-in WeChat user.
   *
   * Accepts either a plain string (sent as text) or a full `ChatResponse`
   * object (text and/or media).
   *
   * Requires a context token from an inbound message. Tokens are restored
   * across restarts; expiration is determined by the WeChat server.
   */
  async sendMessage(message: string | ChatResponse): Promise<void> {
    const response: ChatResponse =
      typeof message === "string" ? { text: message } : message;

    const contextToken = getContextToken(this._accountId, this._userId);
    if (!contextToken) {
      throw new Error(
        "没有找到 context_token，需要至少收到过一条消息（重启后会恢复缓存）",
      );
    }

    await sendChatResponse(response, {
      to: this._userId,
      accountId: this._accountId,
      cdnBaseUrl: this._cdnBaseUrl,
      outputFormat: this._options.outputFormat,
      hooks: this._options.hooks,
      opts: {
        baseUrl: this._baseUrl,
        token: this._token,
        contextToken,
        botAgent: this._options.botAgent,
        accountId: this._accountId,
        quoteStore: await this._quoteStore,
      },
    });
  }
}

/**
 * Start the bot — long-polls for new messages and dispatches them to the agent.
 *
 * Returns a `Bot` instance immediately. Use `bot.wait()` when a CLI program
 * should block until the background monitor stops.
 */
export function start(agent: Agent, opts?: StartOptions): Bot {
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
    throw new Error(`账号 ${accountId} 未配置 (缺少 token)，请先运行 login`);
  }

  const accountData = loadWeixinAccount(account.accountId);
  const userId = accountData?.userId;
  if (!userId) {
    throw new Error(`账号 ${accountId} 没有关联的用户 ID，请重新运行 login`);
  }

  log(`[weixin] 启动 bot, account=${account.accountId}`);

  restoreContextTokens(account.accountId);
  const quoteStore = QuoteStore.open({
    policy: resolveQuoteCachePolicy(opts?.quoteCache),
    rootDir: quoteCacheRoot(account.accountId),
  });
  const apiOpts = {
    baseUrl: account.baseUrl,
    token: account.token,
    botAgent: opts?.botAgent,
  };
  const notify = async (event: "start" | "stop") => {
    try {
      const response = await (event === "start" ? notifyStart : notifyStop)({
        ...apiOpts,
        abortSignal: event === "start" ? opts?.abortSignal : undefined,
      });
      if (response.ret)
        log(`[weixin] notify ${event} failed: ret=${response.ret}`);
    } catch (err) {
      log(`[weixin] notify ${event} failed (ignored): ${String(err)}`);
    }
  };
  const monitorPromise = (async () => {
    const store = await quoteStore;
    let started = false;
    try {
      if (opts?.abortSignal?.aborted) return;
      started = true;
      await notify("start");
      await monitorWeixinProvider({
        baseUrl: account.baseUrl,
        cdnBaseUrl: account.cdnBaseUrl,
        token: account.token,
        accountId: account.accountId,
        agent,
        abortSignal: opts?.abortSignal,
        outputFormat: opts?.outputFormat,
        botAgent: opts?.botAgent,
        hooks: opts?.hooks,
        quoteStore: store,
        log,
      });
    } finally {
      try {
        if (started) await notify("stop");
      } finally {
        store?.close();
      }
    }
  })();

  return new Bot({
    accountId: account.accountId,
    baseUrl: account.baseUrl,
    cdnBaseUrl: account.cdnBaseUrl,
    token: account.token,
    userId,
    monitorPromise,
    options: opts,
    quoteStore,
  });
}
