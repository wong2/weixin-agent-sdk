/**
 * Agent interface — any AI backend that can handle a chat message.
 *
 * Implement this interface to connect WeChat to your own AI service.
 * The WeChat bridge calls `chat()` for each inbound message and sends
 * the returned response back to the user.
 */

import type { OutputFormat } from "../messaging/markdown.js";

export interface Agent {
  /** Process a single message and return a reply. */
  chat(request: ChatRequest): Promise<ChatResponse>;
  /** Clear/reset the session for a given conversation. */
  clearSession?(conversationId: string): void;
}

export interface ChatRequest {
  /** Lossless provider message identifier. */
  messageId?: string;
  /** Resolved quote, also included in text for existing agents. */
  quote?: {
    messageId?: string;
    text: string;
    partialText?: string;
    media?: ChatRequest["media"];
    missing?: boolean;
  };
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

export interface ChatResponse {
  /** Override the bot's default output format for this response. */
  outputFormat?: OutputFormat;
  /** Reply text, formatted according to outputFormat (plain by default). */
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
