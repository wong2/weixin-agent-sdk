/**
 * Example Agent implementation using the OpenAI Chat Completions API.
 *
 * Supports:
 *   - Multi-turn conversation (per-user message history)
 *   - Vision (image input via base64)
 *   - Configurable model, system prompt, and base URL
 */
import fs from "node:fs/promises";
import path from "node:path";

import OpenAI from "openai";
import type { Agent, ChatRequest, ChatResponse } from "weixin-agent-sdk";

export type OpenAIAgentOptions = {
  apiKey: string;
  /** Model name, defaults to "gpt-5.4". */
  model?: string;
  /** Custom base URL (for proxies or compatible APIs). */
  baseURL?: string;
  /** System prompt prepended to every conversation. */
  systemPrompt?: string;
  /** Max history messages to keep per conversation (default: 50). */
  maxHistory?: number;
};

type Message = OpenAI.ChatCompletionMessageParam;

export class OpenAIAgent implements Agent {
  private client: OpenAI;
  private model: string;
  private systemPrompt: string | undefined;
  private maxHistory: number;
  private conversations = new Map<string, Message[]>();

  constructor(opts: OpenAIAgentOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    this.model = opts.model ?? "gpt-5.4";
    this.systemPrompt = opts.systemPrompt;
    this.maxHistory = opts.maxHistory ?? 50;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const history = this.conversations.get(request.conversationId) ?? [];

    // Build user message content
    const content: OpenAI.ChatCompletionContentPart[] = [];

    if (request.text) {
      content.push({ type: "text", text: request.text });
    }

    const attachments = [request.media, request.quote?.media].filter(
      (media, index, all): media is NonNullable<ChatRequest["media"]> =>
        Boolean(media) &&
        all.findIndex((item) => item?.filePath === media?.filePath) === index,
    );
    for (const media of attachments) {
      if (media.type === "image") {
        // Send image as base64 for vision models
        const imageData = await fs.readFile(media.filePath);
        const base64 = imageData.toString("base64");
        const mimeType = media.mimeType || "image/jpeg";
        content.push({
          type: "image_url",
          image_url: { url: `data:${mimeType};base64,${base64}` },
        });
      } else {
        // Non-image media: describe as text attachment
        const fileName = media.fileName ?? path.basename(media.filePath);
        content.push({
          type: "text",
          text: `[Attachment: ${media.type} — ${fileName}]`,
        });
      }
    }

    if (content.length === 0) {
      return { text: "" };
    }

    const userMessage: Message = {
      role: "user" as const,
      content:
        content.length === 1 && content[0].type === "text"
          ? content[0].text
          : content,
    };
    history.push(userMessage);

    // Build messages array with optional system prompt
    const messages: Message[] = [];
    if (this.systemPrompt) {
      messages.push({ role: "system", content: this.systemPrompt });
    }
    messages.push(...history);

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
    });

    const reply = response.choices[0]?.message?.content ?? "";
    history.push({ role: "assistant", content: reply });

    // Trim history to prevent unbounded growth
    if (history.length > this.maxHistory) {
      history.splice(0, history.length - this.maxHistory);
    }

    this.conversations.set(request.conversationId, history);

    return { text: reply };
  }
}
