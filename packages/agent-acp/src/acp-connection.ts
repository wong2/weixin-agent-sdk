import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import type { SessionId } from "@agentclientprotocol/sdk";
import type { PermissionOption } from "@agentclientprotocol/sdk/dist/schema/types.gen.js";

import type { AcpAgentOptions, PermissionPolicy } from "./types.js";
import { ResponseCollector } from "./response-collector.js";

function log(msg: string) {
  console.log(`[acp] ${msg}`);
}

/**
 * Manages the ACP agent subprocess and ClientSideConnection lifecycle.
 */
export class AcpConnection {
  private process: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private ready = false;
  private collectors = new Map<SessionId, ResponseCollector>();
  /** Agent's negotiated prompt capabilities — populated after initialize(). */
  private _promptCapabilities: { image?: boolean; audio?: boolean; embeddedContext?: boolean } = {};

  constructor(private options: AcpAgentOptions) {}

  /** Prompt capabilities reported by the agent after initialization. */
  get promptCapabilities(): Readonly<{ image?: boolean; audio?: boolean; embeddedContext?: boolean }> {
    return this._promptCapabilities;
  }

  registerCollector(sessionId: SessionId, collector: ResponseCollector): void {
    this.collectors.set(sessionId, collector);
  }

  unregisterCollector(sessionId: SessionId): void {
    this.collectors.delete(sessionId);
  }

  /**
   * Ensure the subprocess is running and the connection is initialized.
   */
  async ensureReady(): Promise<ClientSideConnection> {
    if (this.ready && this.connection) {
      return this.connection;
    }

    const args = this.options.args ?? [];
    log(`spawning: ${this.options.command} ${args.join(" ")}`);

    const proc = spawn(this.options.command, args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...this.options.env },
      cwd: this.options.cwd,
    });
    this.process = proc;

    proc.on("exit", (code) => {
      log(`subprocess exited (code=${code})`);
      this.ready = false;
      this.connection = null;
      this.process = null;
    });

    const writable = Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>;
    const readable = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(writable, readable);

    const conn = new ClientSideConnection((_agent) => ({
      sessionUpdate: async (params) => {
        const update = params.update;
        switch (update.sessionUpdate) {
          case "tool_call":
            log(`tool_call: ${update.title} (${update.status ?? "started"})`);
            break;
          case "tool_call_update":
            if (update.status) {
              log(`tool_call_update: ${update.title ?? update.toolCallId} → ${update.status}`);
            }
            break;
          case "agent_thought_chunk":
            if (update.content.type === "text") {
              log(`thinking: ${update.content.text.slice(0, 100)}`);
            }
            break;
        }
        const collector = this.collectors.get(params.sessionId);
        if (collector) {
          collector.handleUpdate(params);
        }
      },
      requestPermission: async (params) => {
        const policy: PermissionPolicy = this.options.permissionPolicy ?? "reject";
        const opts = params.options;

        if (typeof policy === "function") {
          const mapped = opts.map((o: PermissionOption) => ({ id: o.optionId, kind: o.kind, name: o.name }));
          const chosen = policy(mapped);
          if (chosen) {
            log(`permission: policy callback chose "${chosen}"`);
            return { outcome: { outcome: "selected" as const, optionId: chosen } };
          }
          log("permission: policy callback cancelled");
          return { outcome: { outcome: "cancelled" as const } };
        }

        if (policy === "allow-once") {
          // Pick the "allow_once" option if available, otherwise fall through to reject.
          const allowOnce = opts.find((o: PermissionOption) => o.kind === "allow_once");
          if (allowOnce) {
            log(`permission: allow-once "${allowOnce.optionId}"`);
            return { outcome: { outcome: "selected" as const, optionId: allowOnce.optionId } };
          }
          log("permission: no allow_once option found, rejecting");
        }

        // Default: reject (safest for unattended bots).
        const reject = opts.find((o: PermissionOption) => o.kind === "reject_once" || o.kind === "reject_always");
        if (reject) {
          log(`permission: rejected "${reject.optionId}"`);
          return { outcome: { outcome: "selected" as const, optionId: reject.optionId } };
        }
        log("permission: no reject option, cancelling");
        return { outcome: { outcome: "cancelled" as const } };
      },
    }), stream);

    log("initializing connection...");
    const initResult = await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "weixin-agent-sdk", version: "0.1.0" },
      clientCapabilities: {},
    });

    // Save agent's prompt capabilities for content conversion.
    const caps = initResult.agentCapabilities?.promptCapabilities;
    this._promptCapabilities = {
      image: caps?.image,
      audio: caps?.audio,
      embeddedContext: caps?.embeddedContext,
    };
    log(`connection initialized (capabilities: image=${!!caps?.image} audio=${!!caps?.audio} embeddedContext=${!!caps?.embeddedContext})`);

    this.connection = conn;
    this.ready = true;
    return conn;
  }

  /**
   * Kill the subprocess and clean up.
   */
  dispose(): void {
    this.ready = false;
    this.collectors.clear();
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.connection = null;
  }
}
