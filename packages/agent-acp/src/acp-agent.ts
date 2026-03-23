import type { Agent, ChatRequest, ChatResponse } from "weixin-agent-sdk";
import type { SessionId } from "@agentclientprotocol/sdk";

import type { AcpAgentOptions } from "./types.js";
import { AcpConnection } from "./acp-connection.js";
import { convertRequestToContentBlocks } from "./content-converter.js";
import { ResponseCollector } from "./response-collector.js";

function log(msg: string) {
  console.log(`[acp] ${msg}`);
}

const DEFAULT_PROMPT_TIMEOUT_MS = 120_000;

/**
 * Agent adapter that bridges ACP (Agent Client Protocol) agents
 * to the weixin-agent-sdk Agent interface.
 */
export class AcpAgent implements Agent {
  private connection: AcpConnection;
  private sessions = new Map<string, SessionId>();
  private options: AcpAgentOptions;

  constructor(options: AcpAgentOptions) {
    this.options = options;
    this.connection = new AcpConnection(options);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const conn = await this.connection.ensureReady();

    // Get or create an ACP session for this conversation
    const sessionId = await this.getOrCreateSession(request.conversationId, conn);

    // Convert the ChatRequest to ACP ContentBlock[]
    const blocks = await convertRequestToContentBlocks(request);
    if (blocks.length === 0) {
      return { text: "" };
    }

    // Register a collector, send the prompt, then gather the response
    const preview = request.text?.slice(0, 50) || (request.media ? `[${request.media.type}]` : "");
    log(`prompt: "${preview}" (session=${sessionId})`);

    const collector = new ResponseCollector();
    this.connection.registerCollector(sessionId, collector);
    try {
      await this.runPromptWithTimeout(conn, sessionId, blocks);
    } finally {
      this.connection.unregisterCollector(sessionId);
    }

    const response = await collector.toResponse();
    log(`response: ${response.text?.slice(0, 80) ?? "[no text]"}${response.media ? " +media" : ""}`);
    return response;
  }

  private async getOrCreateSession(
    conversationId: string,
    conn: Awaited<ReturnType<AcpConnection["ensureReady"]>>,
  ): Promise<SessionId> {
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;

    log(`creating new session for conversation=${conversationId}`);
    const res = await conn.newSession({
      cwd: this.options.cwd ?? process.cwd(),
      mcpServers: [],
    });
    log(`session created: ${res.sessionId}`);
    this.sessions.set(conversationId, res.sessionId);
    return res.sessionId;
  }

  private async runPromptWithTimeout(
    conn: Awaited<ReturnType<AcpConnection["ensureReady"]>>,
    sessionId: SessionId,
    prompt: ChatRequest["text"] extends string ? Awaited<ReturnType<typeof convertRequestToContentBlocks>> : never,
  ): Promise<void> {
    const timeoutMs = this.options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    const promptPromise = conn.prompt({ sessionId, prompt });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    try {
      await Promise.race([
        promptPromise.then(() => undefined),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            log(`prompt timeout after ${timeoutMs}ms, cancelling session=${sessionId}`);
            void conn.cancel({ sessionId }).catch((err) => {
              log(`cancel failed for session=${sessionId}: ${String(err)}`);
            });
            reject(new Error(`ACP prompt timeout after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } catch (err) {
      if (timedOut) {
        await promptPromise.catch(() => {});
      }
      throw err;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Clear/reset the session for a given conversation.
   * The next message will automatically create a fresh session.
   */
  clearSession(conversationId: string): void {
    const sessionId = this.sessions.get(conversationId);
    if (sessionId) {
      log(`clearing session for conversation=${conversationId} (session=${sessionId})`);
      this.connection.unregisterCollector(sessionId);
      this.sessions.delete(conversationId);
    }
  }

  /**
   * Kill the ACP subprocess and clean up all sessions.
   */
  dispose(): void {
    this.sessions.clear();
    this.connection.dispose();
  }
}
