import path from "node:path";

import type { ChatResponse, ChatResponseMessage } from "../agent/interface.js";
import { downloadRemoteImageToTemp } from "../cdn/upload.js";
import { logger } from "../util/logger.js";

import { sendWeixinMediaFile } from "./send-media.js";
import { markdownToPlainText, sendMessageWeixin } from "./send.js";

const MEDIA_TEMP_DIR = "/tmp/weixin-agent/media";

type DeliverOpts = {
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
};

/** Send a single ChatResponseMessage (text and/or media) to a WeChat user. */
async function deliverOneMessage(
  msg: ChatResponseMessage,
  to: string,
  contextToken: string | undefined,
  opts: DeliverOpts,
): Promise<void> {
  if (msg.media) {
    let filePath: string;
    const mediaUrl = msg.media.url;
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
      to,
      text: msg.text ? markdownToPlainText(msg.text) : "",
      opts: { baseUrl: opts.baseUrl, token: opts.token, contextToken },
      cdnBaseUrl: opts.cdnBaseUrl,
    });
  } else if (msg.text) {
    await sendMessageWeixin({
      to,
      text: markdownToPlainText(msg.text),
      opts: { baseUrl: opts.baseUrl, token: opts.token, contextToken },
    });
  }
}

/**
 * Deliver a ChatResponse to a WeChat user.
 *
 * Handles both single-message (`text`/`media`) and multi-message
 * (`messages[]`) responses.  Streaming responses are NOT handled here —
 * use `sendStreamingMessageWeixin` directly for those.
 */
export async function deliverChatResponse(
  response: ChatResponse,
  to: string,
  contextToken: string | undefined,
  opts: DeliverOpts,
): Promise<void> {
  if (response.messages?.length) {
    for (const msg of response.messages) {
      await deliverOneMessage(msg, to, contextToken, opts);
    }
    return;
  }
  await deliverOneMessage(response, to, contextToken, opts);
}
