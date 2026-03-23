import fs from "node:fs/promises";

import type { ChatRequest } from "weixin-agent-sdk";
import type { ContentBlock } from "@agentclientprotocol/sdk";

/** Subset of ACP PromptCapabilities we care about for content conversion. */
export type ContentCapabilities = {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
};

/**
 * Convert a ChatRequest into ACP ContentBlock[].
 *
 * The conversion honours the agent's negotiated `promptCapabilities`.
 * When a capability is missing the content is degraded:
 *   - image/audio without capability → text description
 *   - video/file without embeddedContext → resource_link (always supported)
 */
export async function convertRequestToContentBlocks(
  request: ChatRequest,
  capabilities: ContentCapabilities = {},
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];

  if (request.text) {
    blocks.push({ type: "text", text: request.text });
  }

  if (request.media) {
    const mimeType = request.media.mimeType;

    switch (request.media.type) {
      case "image":
        if (capabilities.image) {
          const data = await fs.readFile(request.media.filePath);
          blocks.push({ type: "image", data: data.toString("base64"), mimeType });
        } else {
          // Degrade: describe as text
          blocks.push({
            type: "text",
            text: `[Image attachment: ${request.media.fileName ?? request.media.filePath} (${mimeType})]`,
          });
        }
        break;

      case "audio":
        if (capabilities.audio) {
          const data = await fs.readFile(request.media.filePath);
          blocks.push({ type: "audio", data: data.toString("base64"), mimeType });
        } else {
          blocks.push({
            type: "text",
            text: `[Audio attachment: ${request.media.fileName ?? request.media.filePath} (${mimeType})]`,
          });
        }
        break;

      case "video":
      case "file": {
        const uri = `file://${request.media.filePath}`;
        if (capabilities.embeddedContext) {
          const data = await fs.readFile(request.media.filePath);
          blocks.push({
            type: "resource",
            resource: { uri, blob: data.toString("base64"), mimeType },
          });
        } else {
          // Degrade: use resource_link (always supported per ACP baseline)
          blocks.push({
            type: "resource_link",
            uri,
            mimeType,
            name: request.media.fileName ?? request.media.filePath,
          });
        }
        break;
      }
    }
  }

  return blocks;
}
