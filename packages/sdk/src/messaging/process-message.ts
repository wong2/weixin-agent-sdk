import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Agent, ChatRequest } from "../agent/interface.js";
import { sendTyping } from "../api/api.js";
import type { WeixinMessage, MessageItem } from "../api/types.js";
import { MessageItemType, TypingStatus } from "../api/types.js";
import { downloadMediaFromItem } from "../media/media-download.js";
import { getExtensionFromMime } from "../media/mime.js";
import { logger } from "../util/logger.js";

import { setContextToken, isMediaItem } from "./inbound.js";
import { sendWeixinErrorNotice } from "./error-notice.js";
import { sendChatResponse, type MessageHooks } from "./outbound.js";
import type { OutputFormat } from "./markdown.js";
import type { QuoteStore } from "./quote-store.js";
import { messageId, messageBody, resolveQuote } from "./quotes.js";
import { handleSlashCommand } from "./slash-commands.js";

const MEDIA_TEMP_DIR = path.join(os.tmpdir(), "weixin-agent/media");

/** Save a buffer to a temporary file, returning the file path. */
async function saveMediaBuffer(
  buffer: Buffer,
  contentType?: string,
  subdir?: string,
  _maxBytes?: number,
  originalFilename?: string,
): Promise<{ path: string }> {
  const dir = path.join(MEDIA_TEMP_DIR, subdir ?? "");
  await fs.mkdir(dir, { recursive: true });
  let ext = ".bin";
  if (originalFilename) {
    ext = path.extname(originalFilename) || ".bin";
  } else if (contentType) {
    ext = getExtensionFromMime(contentType);
  }
  const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, buffer);
  return { path: filePath };
}

/** Dependencies for processOneMessage. */
export type ProcessMessageDeps = {
  outputFormat?: OutputFormat;
  botAgent?: string;
  hooks?: MessageHooks;
  quoteStore?: QuoteStore | null;
  accountId: string;
  agent: Agent;
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  typingTicket?: string;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
};

/** Extract raw text from item_list (for slash command detection). */
function extractTextBody(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
  }
  return "";
}

/** Find the first downloadable media item from a message. */
function findMediaItem(itemList?: MessageItem[]): MessageItem | undefined {
  if (!itemList?.length) return undefined;

  const hasDownloadableMedia = (m?: {
    encrypt_query_param?: string;
    full_url?: string;
  }) => m?.encrypt_query_param || m?.full_url;

  // Direct media: IMAGE > VIDEO > FILE > VOICE (skip voice with transcription)
  const direct =
    itemList.find(
      (i) =>
        i.type === MessageItemType.IMAGE &&
        hasDownloadableMedia(i.image_item?.media),
    ) ??
    itemList.find(
      (i) =>
        i.type === MessageItemType.VIDEO &&
        hasDownloadableMedia(i.video_item?.media),
    ) ??
    itemList.find(
      (i) =>
        i.type === MessageItemType.FILE &&
        hasDownloadableMedia(i.file_item?.media),
    ) ??
    itemList.find(
      (i) =>
        i.type === MessageItemType.VOICE &&
        hasDownloadableMedia(i.voice_item?.media) &&
        !i.voice_item?.text,
    );
  if (direct) return direct;

  // Quoted media: check ref_msg
  const refItem = itemList.find(
    (i) =>
      i.type === MessageItemType.TEXT &&
      i.ref_msg?.message_item &&
      isMediaItem(i.ref_msg.message_item),
  );
  return refItem?.ref_msg?.message_item ?? undefined;
}

/**
 * Process a single inbound message:
 *   slash command check → download media → call agent → send reply.
 */
export async function processOneMessage(
  full: WeixinMessage,
  deps: ProcessMessageDeps,
): Promise<void> {
  const receivedAt = Date.now();
  const textBody = extractTextBody(full.item_list);

  // --- Store context token ---
  const contextToken = full.context_token;
  if (contextToken) {
    setContextToken(deps.accountId, full.from_user_id ?? "", contextToken);
  }

  // --- Slash commands ---
  if (textBody.startsWith("/")) {
    const conversationId = full.from_user_id ?? "";
    const slashResult = await handleSlashCommand(
      textBody,
      {
        to: conversationId,
        contextToken: full.context_token,
        baseUrl: deps.baseUrl,
        token: deps.token,
        botAgent: deps.botAgent,
        accountId: deps.accountId,
        log: deps.log,
        errLog: deps.errLog,
        onClear: () => deps.agent.clearSession?.(conversationId),
      },
      receivedAt,
      full.create_time_ms,
    );
    if (slashResult.handled) return;
  }

  // --- Download media ---
  let media: ChatRequest["media"];
  const mediaItem = findMediaItem(full.item_list);
  if (mediaItem) {
    try {
      const downloaded = await downloadMediaFromItem(mediaItem, {
        cdnBaseUrl: deps.cdnBaseUrl,
        saveMedia: saveMediaBuffer,
        log: deps.log,
        errLog: deps.errLog,
        label: "inbound",
      });
      if (downloaded.decryptedPicPath) {
        media = {
          type: "image",
          filePath: downloaded.decryptedPicPath,
          mimeType: "image/*",
        };
      } else if (downloaded.decryptedVideoPath) {
        media = {
          type: "video",
          filePath: downloaded.decryptedVideoPath,
          mimeType: "video/mp4",
        };
      } else if (downloaded.decryptedFilePath) {
        media = {
          type: "file",
          filePath: downloaded.decryptedFilePath,
          fileName: mediaItem.file_item?.file_name,
          mimeType: downloaded.fileMediaType ?? "application/octet-stream",
        };
      } else if (downloaded.decryptedVoicePath) {
        media = {
          type: "audio",
          filePath: downloaded.decryptedVoicePath,
          mimeType: downloaded.voiceMediaType ?? "audio/wav",
        };
      }
    } catch (err) {
      logger.error(`media download failed: ${String(err)}`);
    }
  }

  // Cache the current message, never treating an inline quoted attachment as its own.
  const id = messageId(full);
  const ownMedia = full.item_list?.includes(mediaItem!) ? media : undefined;
  if (id && deps.quoteStore) {
    try {
      await deps.quoteStore.put({
        accountId: deps.accountId,
        conversationId: full.from_user_id ?? "",
        messageId: id,
        direction: "inbound",
        body: messageBody(full.item_list),
        createdAt: full.create_time_ms ?? receivedAt,
        sourceMediaPath: ownMedia?.filePath,
        mediaMime: ownMedia?.mimeType,
        mediaName: ownMedia?.fileName,
      });
    } catch (err) {
      logger.warn(`Unable to cache inbound message: ${String(err)}`);
    }
  }
  const quote = resolveQuote(full, deps.accountId, deps.quoteStore);
  const body = messageBody(full.item_list);
  const request: ChatRequest = {
    conversationId: full.from_user_id ?? "",
    messageId: id,
    text: quote ? `[引用: ${quote.partialText ?? quote.text}]\n${body}` : body,
    media: media ?? quote?.media,
    quote,
  };

  // --- Typing indicator (start + periodic refresh) ---
  const to = full.from_user_id ?? "";
  let typingTimer: ReturnType<typeof setInterval> | undefined;
  const startTyping = () => {
    if (!deps.typingTicket) return;
    sendTyping({
      baseUrl: deps.baseUrl,
      token: deps.token,
      botAgent: deps.botAgent,
      body: {
        ilink_user_id: to,
        typing_ticket: deps.typingTicket,
        status: TypingStatus.TYPING,
      },
    }).catch(() => {});
  };
  if (deps.typingTicket) {
    startTyping();
    typingTimer = setInterval(startTyping, 10_000);
  }

  // --- Call agent & send reply ---
  try {
    const response = await deps.agent.chat(request);

    if (response.text || response.media) {
      await sendChatResponse(response, {
        to,
        accountId: deps.accountId,
        cdnBaseUrl: deps.cdnBaseUrl,
        outputFormat: deps.outputFormat,
        hooks: deps.hooks,
        opts: {
          baseUrl: deps.baseUrl,
          token: deps.token,
          contextToken,
          botAgent: deps.botAgent,
          accountId: deps.accountId,
          quoteStore: deps.quoteStore,
        },
      });
    }
  } catch (err) {
    logger.error(
      `processOneMessage: agent or send failed: ${err instanceof Error ? (err.stack ?? err.message) : JSON.stringify(err)}`,
    );
    void sendWeixinErrorNotice({
      to,
      contextToken,
      message: `⚠️ 处理消息失败：${err instanceof Error ? err.message : JSON.stringify(err)}`,
      baseUrl: deps.baseUrl,
      token: deps.token,
      botAgent: deps.botAgent,
      errLog: deps.errLog,
    });
  } finally {
    // --- Typing indicator (cancel) ---
    if (typingTimer) clearInterval(typingTimer);
    if (deps.typingTicket) {
      sendTyping({
        baseUrl: deps.baseUrl,
        token: deps.token,
        botAgent: deps.botAgent,
        body: {
          ilink_user_id: to,
          typing_ticket: deps.typingTicket,
          status: TypingStatus.CANCEL,
        },
      }).catch(() => {});
    }
  }
}
