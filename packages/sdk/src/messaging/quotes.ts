import fs from "node:fs";
import type { ChatRequest } from "../agent/interface.js";
import type { WeixinMessage, MessageItem } from "../api/types.js";
import { bodyFromItemList } from "./inbound.js";
import { resolvePartialQuote } from "./partial-quote.js";
import type { QuoteStore } from "./quote-store.js";
import { logger } from "../util/logger.js";

export function messageId(message: WeixinMessage): string | undefined {
  return (
    message.message_id || message.item_list?.find((item) => item.msg_id)?.msg_id
  );
}

export function messageBody(items?: MessageItem[]): string {
  const text = bodyFromItemList(
    items?.map((item) => ({ ...item, ref_msg: undefined })),
  );
  if (text) return text;
  const type = items?.find((item) => item.type && item.type > 1)?.type;
  return (
    (
      { 2: "[图片]", 3: "[语音]", 4: "[文件]", 5: "[视频]" } as Record<
        number,
        string
      >
    )[type ?? 0] ?? ""
  );
}

export function resolveQuote(
  message: WeixinMessage,
  accountId: string,
  store?: QuoteStore | null,
): ChatRequest["quote"] {
  const ref = message.item_list?.find((item) => item.ref_msg)?.ref_msg;
  if (!ref) return;
  const id = ref.svr_id || ref.message_item?.msg_id;
  const inline = [
    ref.title,
    ref.message_item && messageBody([ref.message_item]),
  ]
    .filter(Boolean)
    .join(" | ");
  if (inline) return { messageId: id, text: inline };
  if (!id) return;
  try {
    const record = store?.find(accountId, message.from_user_id ?? "", id);
    if (!record)
      return { messageId: id, text: "[引用消息内容未缓存]", missing: true };
    let media: ChatRequest["media"];
    if (record.mediaPath && fs.existsSync(record.mediaPath)) {
      const mimeType = record.mediaMime ?? "application/octet-stream";
      const type = mimeType.startsWith("image/")
        ? "image"
        : mimeType.startsWith("video/")
          ? "video"
          : mimeType.startsWith("audio/")
            ? "audio"
            : "file";
      media = {
        type,
        filePath: record.mediaPath,
        mimeType,
        fileName: record.mediaName,
      };
    }
    const expiredMedia =
      !media && Boolean(record.mediaMime || record.mediaName);
    const partial =
      ref.partial_text && resolvePartialQuote(record.body, ref.partial_text);
    return {
      messageId: id,
      text: expiredMedia
        ? `[引用附件已过期${record.mediaName ? `: ${record.mediaName}` : ""}]`
        : record.body,
      partialText:
        partial && !partial.fallback
          ? (partial.resolved ?? undefined)
          : undefined,
      media,
    };
  } catch (err) {
    logger.warn(`Unable to resolve quote: ${String(err)}`);
    return { messageId: id, text: "[引用消息内容未缓存]", missing: true };
  }
}
