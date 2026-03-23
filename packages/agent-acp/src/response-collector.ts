import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { ChatResponse, ChatResponseMessage } from "weixin-agent-sdk";
import type { SessionNotification, ContentBlock } from "@agentclientprotocol/sdk";

const ACP_MEDIA_OUT_DIR = "/tmp/weixin-agent/media/acp-out";

/**
 * Collects sessionUpdate notifications for a single prompt round-trip
 * and converts the accumulated result into a ChatResponse.
 */
export class ResponseCollector {
  private textChunks: string[] = [];
  private imageData: { base64: string; mimeType: string } | null = null;
  /** Non-image binary resources (files, video, etc.) */
  private resourceOutputs: { base64: string; mimeType: string; uri: string }[] = [];

  /**
   * Feed a sessionUpdate notification into the collector.
   */
  handleUpdate(notification: SessionNotification): void {
    const update = notification.update;

    if (update.sessionUpdate === "agent_message_chunk") {
      const content: ContentBlock = update.content;

      if (content.type === "text") {
        this.textChunks.push(content.text);
      } else if (content.type === "image") {
        this.imageData = {
          base64: content.data,
          mimeType: content.mimeType,
        };
      } else if (content.type === "resource") {
        // EmbeddedResource — save binary blobs for later delivery.
        const res = content.resource;
        if ("blob" in res && res.blob) {
          this.resourceOutputs.push({
            base64: res.blob,
            mimeType: res.mimeType ?? "application/octet-stream",
            uri: res.uri,
          });
        }
        // TextResourceContents is ignored (already covered by text chunks).
      }
      // resource_link is not handled here — it has no inline data.
    }
  }

  /**
   * Build a ChatResponse from all collected chunks.
   *
   * If the response contains multiple media outputs, they are returned via
   * the `messages[]` array so each one becomes a separate WeChat message.
   */
  async toResponse(): Promise<ChatResponse> {
    await fs.mkdir(ACP_MEDIA_OUT_DIR, { recursive: true });

    const text = this.textChunks.join("");

    // Collect all media messages
    const mediaMessages: ChatResponseMessage[] = [];

    // Image output
    if (this.imageData) {
      const ext = this.imageData.mimeType.split("/")[1] ?? "png";
      const filename = `${crypto.randomUUID()}.${ext}`;
      const filePath = path.join(ACP_MEDIA_OUT_DIR, filename);
      await fs.writeFile(filePath, Buffer.from(this.imageData.base64, "base64"));
      mediaMessages.push({ media: { type: "image", url: filePath } });
    }

    // Resource (file/binary) outputs
    for (const res of this.resourceOutputs) {
      const ext = mimeToExt(res.mimeType);
      const filename = `${crypto.randomUUID()}.${ext}`;
      const filePath = path.join(ACP_MEDIA_OUT_DIR, filename);
      await fs.writeFile(filePath, Buffer.from(res.base64, "base64"));

      const mediaType = res.mimeType.startsWith("video/") ? "video" as const : "file" as const;
      mediaMessages.push({
        media: {
          type: mediaType,
          url: filePath,
          fileName: uriToFilename(res.uri) ?? filename,
        },
      });
    }

    // If there are multiple outputs, use messages[] for ordered delivery.
    if (mediaMessages.length > 0) {
      const messages: ChatResponseMessage[] = [];
      if (text) messages.push({ text });
      messages.push(...mediaMessages);

      if (messages.length === 1 && !text) {
        // Single media, no text — use flat response.
        return { ...mediaMessages[0] };
      }
      if (messages.length === 1 && text && mediaMessages.length === 0) {
        return { text };
      }
      return { messages };
    }

    return text ? { text } : {};
  }
}

/** Best-effort extension from MIME type. */
function mimeToExt(mimeType: string): string {
  const sub = mimeType.split("/")[1];
  if (!sub) return "bin";
  // Handle common types: application/pdf → pdf, image/png → png, etc.
  return sub.replace(/^x-/, "").split("+")[0] ?? "bin";
}

/** Extract a human-readable filename from a file:// URI. */
function uriToFilename(uri: string): string | undefined {
  try {
    const p = uri.startsWith("file://") ? uri.slice(7) : uri;
    return path.basename(p) || undefined;
  } catch {
    return undefined;
  }
}
