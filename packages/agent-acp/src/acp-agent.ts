import type { Agent, ChatRequest, ChatResponse } from "weixin-agent-sdk";
import type { SessionId } from "@agentclientprotocol/sdk";

import type { AcpAgentOptions } from "./types.js";
import { AcpConnection } from "./acp-connection.js";
import { convertRequestToContentBlocks } from "./content-converter.js";
import { ResponseCollector } from "./response-collector.js";
import { RouterStateStore } from "./router-state.js";

function log(msg: string) {
  console.log(`[acp] ${msg}`);
}

type RouterCommand =
  | { kind: "status" }
  | { kind: "switch"; backend: string; prompt?: string };

/**
 * Agent adapter that bridges ACP (Agent Client Protocol) agents
 * to the weixin-agent-sdk Agent interface.
 */
export class AcpAgent implements Agent {
  private singleConnection: AcpConnection | null = null;
  private connections = new Map<string, AcpConnection>();
  private sessions = new Map<string, SessionId>();
  private options: AcpAgentOptions;
  private routerState: RouterStateStore | null = null;
  private backendNames: string[];

  constructor(options: AcpAgentOptions) {
    this.options = options;
    this.backendNames = this.options.router
      ? Object.keys(this.options.router.backends)
      : ["default"];
    if (this.options.router) {
      this.routerState = new RouterStateStore(this.options.router.stateFile);
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const routed = this.routeRequest(request);
    if (routed.reply) {
      return { text: routed.reply };
    }

    const conn = await this.getConnection(routed.backend).ensureReady();

    // Get or create an ACP session for this conversation
    const sessionId = await this.getOrCreateSession(routed.backend, request.conversationId, conn);

    // Convert the ChatRequest to ACP ContentBlock[]
    const blocks = await convertRequestToContentBlocks(routed.request);
    if (blocks.length === 0) {
      return { text: "" };
    }

    // Register a collector, send the prompt, then gather the response
    const preview = routed.request.text?.slice(0, 50) || (routed.request.media ? `[${routed.request.media.type}]` : "");
    log(`prompt: "${preview}" (backend=${routed.backend}, session=${sessionId})`);

    const collector = new ResponseCollector();
    const connection = this.getConnection(routed.backend);
    connection.registerCollector(sessionId, collector);
    try {
      await conn.prompt({ sessionId, prompt: blocks });
    } finally {
      connection.unregisterCollector(sessionId);
    }

    const response = await collector.toResponse();
    log(`response: ${response.text?.slice(0, 80) ?? "[no text]"}${response.media ? " +media" : ""} (backend=${routed.backend})`);
    return response;
  }

  private async getOrCreateSession(
    backend: string,
    conversationId: string,
    conn: Awaited<ReturnType<AcpConnection["ensureReady"]>>,
  ): Promise<SessionId> {
    const sessionKey = `${backend}:${conversationId}`;
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;

    log(`creating new session for conversation=${conversationId} backend=${backend}`);
    const res = await conn.newSession({
      cwd: this.options.cwd ?? process.cwd(),
      mcpServers: [],
    });
    log(`session created: ${res.sessionId}`);
    this.sessions.set(sessionKey, res.sessionId);
    return res.sessionId;
  }

  private getConnection(backend: string): AcpConnection {
    if (!this.options.router) {
      if (!this.singleConnection) {
        this.singleConnection = new AcpConnection(this.options);
      }
      return this.singleConnection;
    }

    const existing = this.connections.get(backend);
    if (existing) return existing;

    const spec = this.options.router.backends[backend];
    if (!spec) {
      throw new Error(`unknown backend: ${backend}`);
    }
    const conn = new AcpConnection({
      ...spec,
      promptTimeoutMs: spec.promptTimeoutMs ?? this.options.promptTimeoutMs,
    });
    this.connections.set(backend, conn);
    return conn;
  }

  private routeRequest(request: ChatRequest): {
    backend: string;
    request: ChatRequest;
    reply?: string;
  } {
    if (!this.options.router) {
      return { backend: "default", request };
    }

    const command = this.parseRouterCommand(request.text);
    if (command?.kind === "status") {
      return {
        backend: this.getDefaultBackend(request.conversationId),
        request,
        reply: this.buildStatusMessage(request.conversationId),
      };
    }

    if (command?.kind === "switch") {
      const backend = this.requireBackend(command.backend);
      this.routerState?.setBackend(request.conversationId, backend);

      if (!command.prompt && !request.media) {
        return {
          backend,
          request,
          reply: `已切换到 ${backend}。\n之后未加前缀的消息都会走 ${backend}。\n可发送 /mode 查看当前状态。`,
        };
      }

      return {
        backend,
        request: {
          ...request,
          text: command.prompt ?? request.text,
        },
      };
    }

    const backend = this.getDefaultBackend(request.conversationId);
    return { backend, request };
  }

  private parseRouterCommand(text: string): RouterCommand | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return null;
    const router = this.options.router;
    if (!router) return null;

    const [rawCommand, ...restParts] = trimmed.split(/\s+/);
    const command = rawCommand.toLowerCase();
    const rest = restParts.join(" ").trim();

    if (command === "/mode") {
      if (!rest) return { kind: "status" };
      return { kind: "switch", backend: rest.toLowerCase() };
    }

    if (command === "/backends") {
      return { kind: "status" };
    }

    const backend = command.slice(1);
    if (router.backends[backend]) {
      return { kind: "switch", backend, prompt: rest || undefined };
    }

    return null;
  }

  private requireBackend(backend: string): string {
    if (!this.options.router?.backends[backend]) {
      throw new Error(`unknown backend "${backend}", available: ${this.backendNames.join(", ")}`);
    }
    return backend;
  }

  private getDefaultBackend(conversationId: string): string {
    if (!this.options.router) return "default";
    const routed = this.routerState?.getBackend(conversationId);
    if (routed && this.options.router.backends[routed]) {
      return routed;
    }
    return this.requireBackend(this.options.router.defaultBackend);
  }

  private buildStatusMessage(conversationId: string): string {
    if (!this.options.router) {
      return "当前为单后端模式。";
    }
    const current = this.getDefaultBackend(conversationId);
    const backends = this.backendNames.map((name) => `- ${name}`).join("\n");
    return [
      `当前默认后端：${current}`,
      "",
      "可用后端：",
      backends,
      "",
      "用法：",
      "- /claude",
      "- /codex",
      "- /claude 你的问题",
      "- /codex 你的问题",
      "- /mode claude",
      "- /mode codex",
    ].join("\n");
  }

  /**
   * Kill the ACP subprocess and clean up all sessions.
   */
  dispose(): void {
    this.sessions.clear();
    this.singleConnection?.dispose();
    this.singleConnection = null;
    for (const conn of this.connections.values()) {
      conn.dispose();
    }
    this.connections.clear();
  }
}
