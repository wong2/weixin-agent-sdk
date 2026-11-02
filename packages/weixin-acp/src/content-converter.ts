import fs from "node:fs/promises";

import type { ChatRequest } from "weixin-agent-sdk";
import type { ContentBlock } from "@agentclientprotocol/sdk";

/**
 * Convert a ChatRequest into ACP ContentBlock[].
 */
export async function convertRequestToContentBlocks(
  request: ChatRequest,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];

  if (request.text) {
    blocks.push({ type: "text", text: request.text });
  }

  const attachments = [request.media, request.quote?.media].filter(
    (media, index, all): media is NonNullable<ChatRequest["media"]> =>
      Boolean(media) &&
      all.findIndex((item) => item?.filePath === media?.filePath) === index,
  );
  for (const media of attachments) {
    const data = await fs.readFile(media.filePath);
    const base64 = data.toString("base64");
    const mimeType = media.mimeType;

    switch (media.type) {
      case "image":
        blocks.push({ type: "image", data: base64, mimeType });
        break;
      case "audio":
        blocks.push({ type: "audio", data: base64, mimeType });
        break;
      case "video":
      case "file": {
        const uri = `file://${media.filePath}`;
        blocks.push({
          type: "resource",
          resource: { uri, blob: base64, mimeType },
        });
        break;
      }
    }
  }

  return blocks;
}
