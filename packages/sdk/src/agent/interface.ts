/**
 * Agent interface — any AI backend that can handle a chat message.
 *
 * Implement this interface to connect WeChat to your own AI service.
 * The WeChat bridge calls `chat()` (or `chatStream()` if defined) for each
 * inbound message and sends the returned response back to the user.
 */

export interface Agent {
  /** Process a single message and return a reply. */
  chat(request: ChatRequest): Promise<ChatResponse>;
  /** Clear/reset the session for a given conversation. */
  clearSession?(conversationId: string): void;
  /**
   * Optional streaming variant. When defined, the SDK calls this instead of
   * `chat()` and renders the output incrementally in the WeChat message bubble.
   *
   * Each yielded chunk should carry the **accumulated** text so far (not a
   * delta), so that the WeChat client can update the bubble in-place.
   *
   * @example
   * async *chatStream(req) {
   *   let acc = "";
   *   for await (const delta of myLLM.stream(req.text)) {
   *     acc += delta;
   *     yield { text: acc };
   *   }
   * }
   */
  chatStream?(request: ChatRequest): AsyncIterable<ChatStreamChunk>;
}

export interface ChatRequest {
  /** Conversation / user identifier. Use this to maintain per-user context. */
  conversationId: string;
  /** Text content of the message. */
  text: string;
  /** Attached media file (image, audio, video, or generic file). */
  media?: {
    type: "image" | "audio" | "video" | "file";
    /** Local file path (already downloaded and decrypted). */
    filePath: string;
    /** MIME type, e.g. "image/jpeg", "audio/wav". */
    mimeType: string;
    /** Original filename (available for file attachments). */
    fileName?: string;
  };
}

/** A single outbound message (text and/or one media attachment). */
export interface ChatResponseMessage {
  /** Reply text (may contain markdown — will be converted to plain text before sending). */
  text?: string;
  /** Reply media file. */
  media?: {
    type: "image" | "video" | "file";
    /** Local file path or HTTPS URL. */
    url: string;
    /** Filename hint (for file attachments). */
    fileName?: string;
  };
}

export interface ChatResponse extends ChatResponseMessage {
  /**
   * Send multiple messages sequentially.
   *
   * When set, the top-level `text` and `media` fields are **ignored** and each
   * entry in `messages` is sent as a separate WeChat message in order.
   *
   * @example
   * return {
   *   messages: [
   *     { text: "Here is the summary:" },
   *     { media: { type: "file", url: "/tmp/report.pdf" } },
   *     { text: "Let me know if you have questions." },
   *   ],
   * };
   */
  messages?: ChatResponseMessage[];
}

/**
 * One chunk yielded by `Agent.chatStream()`.
 * The `text` field should carry the **accumulated** text so far (not a delta).
 */
export interface ChatStreamChunk {
  /** Accumulated text content so far. */
  text: string;
}
