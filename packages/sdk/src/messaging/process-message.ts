import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { Agent, ChatRequest } from "../agent/interface.js";
import { sendTyping } from "../api/api.js";
import type { WeixinMessage, MessageItem } from "../api/types.js";
import { MessageItemType, TypingStatus } from "../api/types.js";
import { downloadMediaFromItem } from "../media/media-download.js";
import { getExtensionFromMime } from "../media/mime.js";
import { logger } from "../util/logger.js";

import { setContextToken, bodyFromItemList, isMediaItem } from "./inbound.js";
import { sendWeixinErrorNotice } from "./error-notice.js";
import { deliverChatResponse } from "./deliver.js";
import { sendStreamingMessageWeixin } from "./send.js";
import { handleSlashCommand } from "./slash-commands.js";

const MEDIA_TEMP_DIR = "/tmp/weixin-agent/media";

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

  // Direct media: IMAGE > VIDEO > FILE > VOICE
  // Voice items are always downloaded — even when WeChat provides a
  // transcription text — so that audio-aware agents can choose between
  // the transcript and the original waveform.
  const direct =
    itemList.find(
      (i) => i.type === MessageItemType.IMAGE && i.image_item?.media?.encrypt_query_param,
    ) ??
    itemList.find(
      (i) => i.type === MessageItemType.VIDEO && i.video_item?.media?.encrypt_query_param,
    ) ??
    itemList.find(
      (i) => i.type === MessageItemType.FILE && i.file_item?.media?.encrypt_query_param,
    ) ??
    itemList.find(
      (i) =>
        i.type === MessageItemType.VOICE &&
        i.voice_item?.media?.encrypt_query_param,
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
 *
 * Supports three reply modes based on what the Agent returns:
 *   1. **Streaming** — if `agent.chatStream` is defined, the reply is streamed
 *      using WeChat's GENERATING → FINISH protocol so the bubble updates live.
 *   2. **Multiple messages** — if `response.messages` is set, each entry is
 *      sent as a separate WeChat message in order.
 *   3. **Single message** — the default: `response.text` and/or `response.media`.
 */
export async function processOneMessage(
  full: WeixinMessage,
  deps: ProcessMessageDeps,
): Promise<void> {
  const receivedAt = Date.now();
  const textBody = extractTextBody(full.item_list);

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

  // --- Store context token ---
  const contextToken = full.context_token;
  if (contextToken) {
    setContextToken(deps.accountId, full.from_user_id ?? "", contextToken);
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
        media = { type: "image", filePath: downloaded.decryptedPicPath, mimeType: "image/*" };
      } else if (downloaded.decryptedVideoPath) {
        media = { type: "video", filePath: downloaded.decryptedVideoPath, mimeType: "video/mp4" };
      } else if (downloaded.decryptedFilePath) {
        media = {
          type: "file",
          filePath: downloaded.decryptedFilePath,
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

  // --- Build ChatRequest ---
  const request: ChatRequest = {
    conversationId: full.from_user_id ?? "",
    text: bodyFromItemList(full.item_list),
    media,
  };

  // --- Typing indicator (start) ---
  const to = full.from_user_id ?? "";
  if (deps.typingTicket) {
    sendTyping({
      baseUrl: deps.baseUrl,
      token: deps.token,
      body: {
        ilink_user_id: to,
        typing_ticket: deps.typingTicket,
        status: TypingStatus.TYPING,
      },
    }).catch(() => {});
  }

  // --- Call agent & send reply ---
  try {
    const deliverOpts = { baseUrl: deps.baseUrl, cdnBaseUrl: deps.cdnBaseUrl, token: deps.token };

    // 1. Streaming path — preferred when the agent supports it AND the agent
    //    does not explicitly opt out for this request via shouldStream().
    const useStream =
      deps.agent.chatStream &&
      (deps.agent.shouldStream ? deps.agent.shouldStream(request) : true);

    if (useStream && deps.agent.chatStream) {
      // Cancel typing before streaming — the GENERATING frames serve as the
      // visual indicator from here on.
      if (deps.typingTicket) {
        sendTyping({
          baseUrl: deps.baseUrl,
          token: deps.token,
          body: {
            ilink_user_id: to,
            typing_ticket: deps.typingTicket,
            status: TypingStatus.CANCEL,
          },
        }).catch(() => {});
      }
      await sendStreamingMessageWeixin({
        to,
        chunks: deps.agent.chatStream(request),
        opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
      });
      return;
    }

    // 2. Single-message or multiple-messages path.
    const response = await deps.agent.chat(request);
    await deliverChatResponse(response, to, contextToken, deliverOpts);
  } catch (err) {
    logger.error(`processOneMessage: agent or send failed: ${err instanceof Error ? err.stack ?? err.message : JSON.stringify(err)}`);
    void sendWeixinErrorNotice({
      to,
      contextToken,
      message: `⚠️ 处理消息失败：${err instanceof Error ? err.message : JSON.stringify(err)}`,
      baseUrl: deps.baseUrl,
      token: deps.token,
      errLog: deps.errLog,
    });
  } finally {
    // --- Typing indicator (cancel) ---
    if (deps.typingTicket) {
      sendTyping({
        baseUrl: deps.baseUrl,
        token: deps.token,
        body: {
          ilink_user_id: to,
          typing_ticket: deps.typingTicket,
          status: TypingStatus.CANCEL,
        },
      }).catch(() => {});
    }
  }
}
