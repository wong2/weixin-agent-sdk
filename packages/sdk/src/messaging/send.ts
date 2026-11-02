import { sendMessage as sendMessageApi } from "../api/api.js";
import type { WeixinApiOptions } from "../api/api.js";
import { logger } from "../util/logger.js";
import { generateId } from "../util/random.js";
import type { MessageItem, SendMessageReq } from "../api/types.js";
import { MessageItemType, MessageState, MessageType } from "../api/types.js";
import type { UploadedFileInfo } from "../cdn/upload.js";
import type { QuoteStore } from "./quote-store.js";

export type SendOptions = WeixinApiOptions & {
  contextToken?: string;
  accountId?: string;
  quoteStore?: QuoteStore | null;
  sourceMediaPath?: string;
  mediaMime?: string;
  mediaName?: string;
};

export { markdownToPlainText } from "./markdown.js";

export function generateClientId(): string {
  return generateId("openclaw-weixin");
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
  opts: SendOptions;
}): Promise<{ messageId: string; serverMessageId?: string }> {
  const { to, text, opts } = params;
  if (!opts.contextToken) {
    logger.error(
      `sendMessageWeixin: contextToken missing, refusing to send to=${to}`,
    );
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
    const response = await sendMessageApi({
      ...opts,
      baseUrl: opts.baseUrl,
      token: opts.token,
      timeoutMs: opts.timeoutMs,
      body: req,
    });
    await cacheSentMessage(opts, to, text, response.message_id, false);
    return { messageId: clientId, serverMessageId: response.message_id };
  } catch (err) {
    logger.error(
      `sendMessageWeixin: failed to=${to} clientId=${clientId} err=${String(err)}`,
    );
    throw err;
  }
}

/**
 * Send one or more MessageItems (optionally preceded by a text caption) downstream.
 * Each item is sent as its own request so that item_list always has exactly one entry.
 */
async function sendMediaItems(params: {
  to: string;
  text: string;
  mediaItem: MessageItem;
  opts: SendOptions;
  label: string;
}): Promise<{ messageId: string; serverMessageId?: string }> {
  const { to, text, mediaItem, opts, label } = params;

  const items: MessageItem[] = [];
  if (text) {
    items.push({ type: MessageItemType.TEXT, text_item: { text } });
  }
  items.push(mediaItem);

  let lastClientId = "";
  let serverMessageId: string | undefined;
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
      const response = await sendMessageApi({
        ...opts,
        baseUrl: opts.baseUrl,
        token: opts.token,
        timeoutMs: opts.timeoutMs,
        body: req,
      });
      serverMessageId = response.message_id;
      await cacheSentMessage(
        opts,
        to,
        item.text_item?.text ?? "",
        response.message_id,
        item.type !== MessageItemType.TEXT,
      );
    } catch (err) {
      logger.error(
        `${label}: failed to=${to} clientId=${lastClientId} err=${String(err)}`,
      );
      throw err;
    }
  }

  logger.debug(`${label}: success to=${to} clientId=${lastClientId}`);
  return { messageId: lastClientId, serverMessageId };
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
  opts: SendOptions;
}): Promise<{ messageId: string; serverMessageId?: string }> {
  const { to, text, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.error(
      `sendImageMessageWeixin: contextToken missing, refusing to send to=${to}`,
    );
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

  return sendMediaItems({
    to,
    text,
    mediaItem: imageItem,
    opts,
    label: "sendImageMessageWeixin",
  });
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
  opts: SendOptions;
}): Promise<{ messageId: string; serverMessageId?: string }> {
  const { to, text, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.error(
      `sendVideoMessageWeixin: contextToken missing, refusing to send to=${to}`,
    );
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

  return sendMediaItems({
    to,
    text,
    mediaItem: videoItem,
    opts,
    label: "sendVideoMessageWeixin",
  });
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
  opts: SendOptions;
}): Promise<{ messageId: string; serverMessageId?: string }> {
  const { to, text, fileName, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.error(
      `sendFileMessageWeixin: contextToken missing, refusing to send to=${to}`,
    );
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

  return sendMediaItems({
    to,
    text,
    mediaItem: fileItem,
    opts,
    label: "sendFileMessageWeixin",
  });
}

async function cacheSentMessage(
  opts: SendOptions,
  to: string,
  body: string,
  messageId: string | undefined,
  media: boolean,
): Promise<void> {
  if (!opts.quoteStore || !opts.accountId || !messageId) return;
  try {
    await opts.quoteStore.put({
      accountId: opts.accountId,
      conversationId: to,
      messageId,
      direction: "outbound",
      body: body || (media ? "[附件]" : ""),
      createdAt: Date.now(),
      ...(media
        ? {
            sourceMediaPath: opts.sourceMediaPath,
            mediaMime: opts.mediaMime,
            mediaName: opts.mediaName,
          }
        : {}),
    });
  } catch (err) {
    logger.warn(`Unable to cache sent message: ${String(err)}`);
  }
}
