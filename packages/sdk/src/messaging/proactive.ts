import path from "node:path";

import type { ChatResponse } from "../agent/interface.js";
import {
  listWeixinAccountIds,
  resolveWeixinAccount,
} from "../auth/accounts.js";
import { downloadRemoteImageToTemp } from "../cdn/upload.js";
import { getContextToken } from "./inbound.js";
import { sendWeixinMediaFile } from "./send-media.js";
import { markdownToPlainText, sendMessageWeixin } from "./send.js";

const MEDIA_TEMP_DIR = "/tmp/weixin-agent/media";

export type SendMessageOptions = {
  accountId?: string;
};

/**
 * Proactively send a message to a WeChat user outside the normal reply loop.
 *
 * Requires `start()` to be running so that a `context_token` has been cached
 * for the target user (the user must have sent at least one message previously).
 * The token is valid for approximately 24 hours.
 */
export async function sendMessage(
  userId: string,
  response: ChatResponse,
  opts?: SendMessageOptions,
): Promise<void> {
  // 1. Resolve account
  let accountId = opts?.accountId;
  if (!accountId) {
    const ids = listWeixinAccountIds();
    if (ids.length === 0) {
      throw new Error("没有已登录的账号，请先运行 login()");
    }
    accountId = ids[0];
  }
  const account = resolveWeixinAccount(accountId);
  if (!account.configured) {
    throw new Error(`账号 ${accountId} 未配置 (缺少 token)，请先运行 login()`);
  }

  // 2. Look up cached context token
  const contextToken = getContextToken(account.accountId, userId);
  if (!contextToken) {
    throw new Error(
      `没有找到用户 "${userId}" 的 context_token，` +
        `该用户需要在 start() 运行期间至少发送过一条消息`,
    );
  }

  const apiOpts = {
    baseUrl: account.baseUrl,
    token: account.token,
    contextToken,
  };

  // 3. Send media or text (mirrors process-message.ts logic)
  if (response.media) {
    let filePath: string;
    const mediaUrl = response.media.url;
    if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
      filePath = await downloadRemoteImageToTemp(
        mediaUrl,
        path.join(MEDIA_TEMP_DIR, "outbound"),
      );
    } else {
      filePath = path.isAbsolute(mediaUrl) ? mediaUrl : path.resolve(mediaUrl);
    }
    await sendWeixinMediaFile({
      filePath,
      to: userId,
      text: response.text ? markdownToPlainText(response.text) : "",
      opts: apiOpts,
      cdnBaseUrl: account.cdnBaseUrl,
    });
    return;
  }

  if (response.text) {
    await sendMessageWeixin({
      to: userId,
      text: markdownToPlainText(response.text),
      opts: apiOpts,
    });
    return;
  }

  throw new Error("ChatResponse 必须包含 text 或 media");
}
