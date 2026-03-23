import { sendMessage as sendMessageApi } from "../api/api.js";
import type { WeixinApiOptions } from "../api/api.js";
import { logger } from "../util/logger.js";
import { generateId } from "../util/random.js";
import type { MessageItem, SendMessageReq } from "../api/types.js";
import { MessageItemType, MessageState, MessageType } from "../api/types.js";
import type { UploadedFileInfo } from "../cdn/upload.js";
import type { ChatStreamChunk } from "../agent/interface.js";

export function generateClientId(): string {
  return generateId("openclaw-weixin");
}

/**
 * Convert markdown-formatted model reply to plain text for Weixin delivery.
 * Preserves newlines; strips markdown syntax.
 */
export function markdownToPlainText(text: string): string {
  let result = text;
  // Code blocks: strip fences, keep code content
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  // Images: remove entirely
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  // Links: keep display text only
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Tables: remove separator rows, then strip leading/trailing pipes and convert inner pipes to spaces
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner: string) =>
    inner.split("|").map((cell) => cell.trim()).join("  "),
  );
  // Strip inline markdown formatting
  result = result
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`(.+?)`/g, "$1");
  return result;
}


/** Build a SendMessageReq containing a single text message. */
function buildTextMessageReq(params: {
  to: string;
  text: string;
  contextToken?: string;
  clientId: string;
}): SendMessageReq {
  const { to, text, contextToken, clientId } = params;
  const item_list: MessageItem[] = text
    ? [{ type: MessageItemType.TEXT, text_item: { text } }]
    : [];
  return {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: item_list.length ? item_list : undefined,
      context_token: contextToken ?? undefined,
    },
  };
}

/** Build a SendMessageReq from a text payload. */
function buildSendMessageReq(params: {
  to: string;
  contextToken?: string;
  text: string;
  clientId: string;
}): SendMessageReq {
  const { to, contextToken, text, clientId } = params;
  return buildTextMessageReq({ to, text, contextToken, clientId });
}

/**
 * Send a plain text message downstream.
 * contextToken is required for all reply sends; missing it breaks conversation association.
 */
export async function sendMessageWeixin(params: {
  to: string;
  text: string;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, opts } = params;
  if (!opts.contextToken) {
    logger.error(`sendMessageWeixin: contextToken missing, refusing to send to=${to}`);
    throw new Error("sendMessageWeixin: contextToken is required");
  }
  const clientId = generateClientId();
  const req = buildSendMessageReq({
    to,
    contextToken: opts.contextToken,
    text,
    clientId,
  });
  try {
    await sendMessageApi({
      baseUrl: opts.baseUrl,
      token: opts.token,
      timeoutMs: opts.timeoutMs,
      body: req,
    });
  } catch (err) {
    logger.error(`sendMessageWeixin: failed to=${to} clientId=${clientId} err=${String(err)}`);
    throw err;
  }
  return { messageId: clientId };
}

/**
 * Send one or more MessageItems (optionally preceded by a text caption) downstream.
 * Each item is sent as its own request so that item_list always has exactly one entry.
 */
async function sendMediaItems(params: {
  to: string;
  text: string;
  mediaItem: MessageItem;
  opts: WeixinApiOptions & { contextToken?: string };
  label: string;
}): Promise<{ messageId: string }> {
  const { to, text, mediaItem, opts, label } = params;

  const items: MessageItem[] = [];
  if (text) {
    items.push({ type: MessageItemType.TEXT, text_item: { text } });
  }
  items.push(mediaItem);

  let lastClientId = "";
  for (const item of items) {
    lastClientId = generateClientId();
    const req: SendMessageReq = {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: lastClientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [item],
        context_token: opts.contextToken ?? undefined,
      },
    };
    try {
      await sendMessageApi({
        baseUrl: opts.baseUrl,
        token: opts.token,
        timeoutMs: opts.timeoutMs,
        body: req,
      });
    } catch (err) {
      logger.error(
        `${label}: failed to=${to} clientId=${lastClientId} err=${String(err)}`,
      );
      throw err;
    }
  }

  logger.debug(`${label}: success to=${to} clientId=${lastClientId}`);
  return { messageId: lastClientId };
}

/**
 * Send an image message downstream using a previously uploaded file.
 * Optionally include a text caption as a separate TEXT item before the image.
 *
 * ImageItem fields:
 *   - media.encrypt_query_param: CDN download param
 *   - media.aes_key: AES key, base64-encoded
 *   - mid_size: original ciphertext file size
 */
export async function sendImageMessageWeixin(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.error(`sendImageMessageWeixin: contextToken missing, refusing to send to=${to}`);
    throw new Error("sendImageMessageWeixin: contextToken is required");
  }
  logger.debug(
    `sendImageMessageWeixin: to=${to} filekey=${uploaded.filekey} fileSize=${uploaded.fileSize} aeskey=present`,
  );

  const imageItem: MessageItem = {
    type: MessageItemType.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      mid_size: uploaded.fileSizeCiphertext,
    },
  };

  return sendMediaItems({ to, text, mediaItem: imageItem, opts, label: "sendImageMessageWeixin" });
}

/**
 * Send a video message downstream using a previously uploaded file.
 * VideoItem: media (CDN ref), video_size (ciphertext bytes).
 * Includes an optional text caption sent as a separate TEXT item first.
 */
export async function sendVideoMessageWeixin(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.error(`sendVideoMessageWeixin: contextToken missing, refusing to send to=${to}`);
    throw new Error("sendVideoMessageWeixin: contextToken is required");
  }

  const videoItem: MessageItem = {
    type: MessageItemType.VIDEO,
    video_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      video_size: uploaded.fileSizeCiphertext,
    },
  };

  return sendMediaItems({ to, text, mediaItem: videoItem, opts, label: "sendVideoMessageWeixin" });
}

/**
 * Send a file attachment downstream using a previously uploaded file.
 * FileItem: media (CDN ref), file_name, len (plaintext bytes as string).
 * Includes an optional text caption sent as a separate TEXT item first.
 */
export async function sendFileMessageWeixin(params: {
  to: string;
  text: string;
  fileName: string;
  uploaded: UploadedFileInfo;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, fileName, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.error(`sendFileMessageWeixin: contextToken missing, refusing to send to=${to}`);
    throw new Error("sendFileMessageWeixin: contextToken is required");
  }
  const fileItem: MessageItem = {
    type: MessageItemType.FILE,
    file_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(uploaded.fileSize),
    },
  };

  return sendMediaItems({ to, text, mediaItem: fileItem, opts, label: "sendFileMessageWeixin" });
}

/** Minimum interval (ms) between GENERATING frame sends to avoid rate limiting. */
const STREAM_THROTTLE_MS = 300;

/**
 * Send a FINISH frame for the given clientId / text, best-effort.
 * Used both for normal completion and for error-recovery cleanup.
 */
async function sendFinishFrame(
  to: string,
  clientId: string,
  text: string,
  opts: WeixinApiOptions & { contextToken?: string },
): Promise<void> {
  const finishReq: SendMessageReq = {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: text
        ? [{ type: MessageItemType.TEXT, text_item: { text } }]
        : undefined,
      context_token: opts.contextToken,
    },
  };
  await sendMessageApi({ baseUrl: opts.baseUrl, token: opts.token, body: finishReq });
}

/**
 * Stream a text response using WeChat's GENERATING → FINISH message-state protocol.
 *
 * All chunks share the same `client_id`, so the WeChat client can update the
 * message bubble in-place rather than appending new bubbles.  Each chunk must
 * carry the **accumulated** text so far (not a delta).
 *
 * The final FINISH frame is sent automatically after the iterable is exhausted,
 * containing the last accumulated text.
 *
 * **Error recovery:** if a chunk send fails, the function tries to send a
 * FINISH frame so the bubble does not get stuck in GENERATING state.
 *
 * **Throttling:** consecutive GENERATING frames are rate-limited to one every
 * `STREAM_THROTTLE_MS` milliseconds to avoid hitting WeChat API rate limits.
 */
export async function sendStreamingMessageWeixin(params: {
  to: string;
  chunks: AsyncIterable<ChatStreamChunk>;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, chunks, opts } = params;
  if (!opts.contextToken) {
    logger.error(`sendStreamingMessageWeixin: contextToken missing, refusing to send to=${to}`);
    throw new Error("sendStreamingMessageWeixin: contextToken is required");
  }

  const clientId = generateClientId();
  let lastText = "";
  let lastSendTime = 0;

  try {
    for await (const chunk of chunks) {
      lastText = chunk.text;

      // Throttle: skip this frame if it arrives too soon after the last send.
      const now = Date.now();
      if (now - lastSendTime < STREAM_THROTTLE_MS) {
        continue;
      }

      const req: SendMessageReq = {
        msg: {
          from_user_id: "",
          to_user_id: to,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.GENERATING,
          item_list: lastText
            ? [{ type: MessageItemType.TEXT, text_item: { text: lastText } }]
            : undefined,
          context_token: opts.contextToken,
        },
      };
      await sendMessageApi({ baseUrl: opts.baseUrl, token: opts.token, body: req });
      lastSendTime = Date.now();
    }
  } catch (err) {
    logger.error(`sendStreamingMessageWeixin: chunk send failed to=${to} err=${String(err)}`);
    // Best-effort: send a FINISH frame so the bubble doesn't stay stuck in GENERATING.
    try {
      await sendFinishFrame(to, clientId, lastText, opts);
    } catch { /* swallow — original error is more important */ }
    throw err;
  }

  // Final FINISH frame — marks the end of the stream.
  try {
    await sendFinishFrame(to, clientId, lastText, opts);
  } catch (err) {
    logger.error(`sendStreamingMessageWeixin: finish frame failed to=${to} err=${String(err)}`);
    throw err;
  }

  logger.debug(`sendStreamingMessageWeixin: done to=${to} clientId=${clientId}`);
  return { messageId: clientId };
}
