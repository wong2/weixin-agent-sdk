import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ChatResponse } from "weixin-agent-sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";

const ACP_MEDIA_OUT_DIR = path.join(os.tmpdir(), "weixin-agent", "media", "acp-out");

/**
 * Collects sessionUpdate notifications for a single prompt round-trip
 * and converts the accumulated result into a ChatResponse.
 */
export class ResponseCollector {
  private textChunks: string[] = [];
  private imageData: { base64: string; mimeType: string } | null = null;

  /**
   * Feed a sessionUpdate notification into the collector.
   */
  handleUpdate(notification: SessionNotification): void {
    const update = notification.update;

    if (update.sessionUpdate === "agent_message_chunk") {
      const content = update.content;

      if (content.type === "text") {
        this.textChunks.push(content.text);
      } else if (content.type === "image") {
        this.imageData = {
          base64: content.data,
          mimeType: content.mimeType,
        };
      }
    }
  }

  /**
   * Build a ChatResponse from all collected chunks.
   */
  async toResponse(): Promise<ChatResponse> {
    const response: ChatResponse = {};

    const text = this.textChunks.join("");
    if (text) {
      response.text = text;
    }

    if (this.imageData) {
      await fs.mkdir(ACP_MEDIA_OUT_DIR, { recursive: true });
      const ext = this.imageData.mimeType.split("/")[1] ?? "png";
      const filename = `${crypto.randomUUID()}.${ext}`;
      const filePath = path.join(ACP_MEDIA_OUT_DIR, filename);
      await fs.writeFile(filePath, Buffer.from(this.imageData.base64, "base64"));
      response.media = { type: "image", url: filePath };
    }

    return response;
  }
}
