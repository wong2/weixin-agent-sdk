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
import type { Agent, ChatRequest, ChatResponse, ChatStreamChunk } from "weixin-agent-sdk";

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

  /**
   * Build the user message content parts from a ChatRequest.
   * Returns null if the request has no meaningful content.
   */
  private async buildUserContent(
    request: ChatRequest,
  ): Promise<OpenAI.ChatCompletionContentPart[] | null> {
    const content: OpenAI.ChatCompletionContentPart[] = [];

    if (request.text) {
      content.push({ type: "text", text: request.text });
    }

    if (request.media?.type === "image") {
      const imageData = await fs.readFile(request.media.filePath);
      const base64 = imageData.toString("base64");
      const mimeType = request.media.mimeType || "image/jpeg";
      content.push({
        type: "image_url",
        image_url: { url: `data:${mimeType};base64,${base64}` },
      });
    } else if (request.media) {
      const fileName =
        request.media.fileName ?? path.basename(request.media.filePath);
      content.push({
        type: "text",
        text: `[Attachment: ${request.media.type} — ${fileName}]`,
      });
    }

    return content.length > 0 ? content : null;
  }

  /**
   * Prepare the messages array for the OpenAI API call.
   *
   * Returns a **snapshot** of the conversation including the new user message.
   * The shared `history` is NOT mutated until the caller explicitly commits.
   */
  private prepareMessages(
    history: Message[],
    userMessage: Message,
  ): Message[] {
    const messages: Message[] = [];
    if (this.systemPrompt) {
      messages.push({ role: "system", content: this.systemPrompt });
    }
    messages.push(...history, userMessage);
    return messages;
  }

  /**
   * Commit user + assistant messages to the per-conversation history.
   *
   * Builds a **new** array from the snapshot so that the Map is only updated
   * atomically on success — no in-place mutation of shared state.
   */
  private commitHistory(
    conversationId: string,
    historySnapshot: Message[],
    userMessage: Message,
    assistantContent: string,
  ): void {
    const updated = [
      ...historySnapshot,
      userMessage,
      { role: "assistant" as const, content: assistantContent },
    ];
    if (updated.length > this.maxHistory) {
      updated.splice(0, updated.length - this.maxHistory);
    }
    this.conversations.set(conversationId, updated);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    // Snapshot: work on a copy so that failures never pollute the shared history.
    const history = [...(this.conversations.get(request.conversationId) ?? [])];

    const content = await this.buildUserContent(request);
    if (!content) {
      return { text: "" };
    }

    const userMessage: Message = {
      role: "user" as const,
      content:
        content.length === 1 && content[0].type === "text"
          ? content[0].text
          : content,
    };

    const messages = this.prepareMessages(history, userMessage);

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
    });

    const reply = response.choices[0]?.message?.content ?? "";

    // Only commit history after a successful API call.
    this.commitHistory(request.conversationId, history, userMessage, reply);

    return { text: reply };
  }

  async *chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
    // Snapshot: work on a copy so that failures never pollute the shared history.
    const history = [...(this.conversations.get(request.conversationId) ?? [])];

    const content = await this.buildUserContent(request);
    if (!content) return;

    const userMessage: Message = {
      role: "user" as const,
      content:
        content.length === 1 && content[0].type === "text"
          ? content[0].text
          : content,
    };

    const messages = this.prepareMessages(history, userMessage);

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      stream: true,
    });

    let accumulated = "";
    for await (const part of stream) {
      const delta = part.choices[0]?.delta?.content;
      if (delta) {
        accumulated += delta;
        yield { text: accumulated };
      }
    }

    // Commit history only after the stream completes successfully.
    this.commitHistory(
      request.conversationId,
      history,
      userMessage,
      accumulated,
    );
  }
}
