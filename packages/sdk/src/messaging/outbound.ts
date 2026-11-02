import os from "node:os";
import path from "node:path";
import type { ChatResponse } from "../agent/interface.js";
import { downloadRemoteImageToTemp } from "../cdn/upload.js";
import { logger } from "../util/logger.js";
import { formatMessageText, type OutputFormat } from "./markdown.js";
import { sendMessageWeixin, type SendOptions } from "./send.js";
import { sendWeixinMediaFile } from "./send-media.js";

export type OutboundContext = { accountId: string; conversationId: string };
export type MessageHooks = {
  /** Return false to cancel, a response to replace, or void to leave unchanged. Hook errors fail open. */
  beforeSend?: (
    message: ChatResponse,
    context: OutboundContext,
  ) => ChatResponse | false | void | Promise<ChatResponse | false | void>;
  /** Called once after delivery succeeds or fails; observer errors do not affect delivery. */
  afterSend?: (
    event: OutboundContext & { message: ChatResponse; error?: unknown },
  ) => void | Promise<void>;
};

export async function sendChatResponse(
  response: ChatResponse,
  deps: {
    to: string;
    accountId: string;
    cdnBaseUrl: string;
    opts: SendOptions;
    outputFormat?: OutputFormat;
    hooks?: MessageHooks;
  },
): Promise<void> {
  const context = { accountId: deps.accountId, conversationId: deps.to };
  let message = response;
  try {
    const changed = await deps.hooks?.beforeSend?.(
      { ...response, media: response.media && { ...response.media } },
      context,
    );
    if (changed === false) return;
    if (changed) message = changed;
  } catch (err) {
    logger.warn(`beforeSend hook failed: ${String(err)}`);
  }
  let error: unknown;
  try {
    const text = formatMessageText(
      message.text ?? "",
      message.outputFormat ?? deps.outputFormat,
    );
    if (message.media) {
      const url = message.media.url;
      const filePath = /^https?:\/\//.test(url)
        ? await downloadRemoteImageToTemp(
            url,
            path.join(os.tmpdir(), "weixin-agent/media/outbound"),
          )
        : path.resolve(url);
      await sendWeixinMediaFile({
        filePath,
        to: deps.to,
        text,
        cdnBaseUrl: deps.cdnBaseUrl,
        opts: { ...deps.opts, mediaName: message.media.fileName },
      });
    } else if (text) {
      await sendMessageWeixin({ to: deps.to, text, opts: deps.opts });
    } else {
      throw new Error("消息必须包含 text 或 media");
    }
  } catch (err) {
    error = err;
    throw err;
  } finally {
    try {
      await deps.hooks?.afterSend?.({ ...context, message, error });
    } catch (err) {
      logger.warn(`afterSend hook failed: ${String(err)}`);
    }
  }
}
