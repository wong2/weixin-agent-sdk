import { sendTyping } from "../api/api.js";
import { WeixinConfigManager } from "../api/config-cache.js";
import { TypingStatus } from "../api/types.js";

const REFRESH_INTERVAL_MS = 10_000;

type ConversationTyping = {
  to: string;
  contextToken?: string;
  waiters: number;
  ticket?: string;
  started: boolean;
  pending: boolean;
  timer?: ReturnType<typeof setInterval>;
  running?: Promise<void>;
};

/** One manager per account monitor; all requests in a conversation share a loop. */
export class TypingManager {
  private conversations = new Map<string, ConversationTyping>();
  private config: WeixinConfigManager;
  private stopped = false;
  private onAbort = () => {
    void this.stop();
  };

  constructor(private opts: {
    baseUrl: string;
    token?: string;
    botAgent?: string;
    abortSignal?: AbortSignal;
    log: (message: string) => void;
  }) {
    this.config = new WeixinConfigManager(opts, opts.log);
    opts.abortSignal?.addEventListener("abort", this.onAbort, { once: true });
    if (opts.abortSignal?.aborted) void this.stop();
  }

  /** Acquire one wait, returning an idempotent release function. Never waits on IO. */
  acquire(to: string, contextToken?: string): () => void {
    if (this.stopped) return () => {};
    let state = this.conversations.get(to);
    if (!state) {
      state = { to, waiters: 0, started: false, pending: false };
      this.conversations.set(to, state);
    }
    state.contextToken = contextToken ?? state.contextToken;
    state.waiters++;
    const current = state;
    if (!state.timer) {
      state.timer = setInterval(() => this.schedule(current), REFRESH_INTERVAL_MS);
      this.schedule(state);
    }
    let released = false;
    return () => {
      if (released || this.stopped) return;
      released = true;
      if (--current.waiters === 0) {
        clearInterval(current.timer);
        current.timer = undefined;
        this.schedule(current);
      }
    };
  }

  /** Clear timers immediately, then best-effort cancel after any in-flight update. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.opts.abortSignal?.removeEventListener("abort", this.onAbort);
    for (const state of this.conversations.values()) {
      clearInterval(state.timer);
      state.timer = undefined;
      state.waiters = 0;
      this.schedule(state);
    }
    // A worker that was just finishing may schedule one final reconciliation
    // in its finally handler. Drain that too before monitor shutdown completes.
    while (this.conversations.size > 0) {
      await Promise.all([...this.conversations.values()].map((state) => state.running));
    }
  }

  private schedule(state: ConversationTyping): void {
    state.pending = true;
    if (state.running) return;
    state.running = this.update(state).finally(() => {
      state.running = undefined;
      if (state.pending) this.schedule(state);
      else if (state.waiters === 0) this.conversations.delete(state.to);
    });
  }

  private async update(state: ConversationTyping): Promise<void> {
    // Serialize updates AND cancellation. A delayed renewal must finish before
    // CANCEL; if a new waiter arrives during CANCEL, TYPING follows it in order.
    while (state.pending) {
      state.pending = false;
      try {
        let status: number;
        if (state.waiters > 0 && !this.stopped) {
          const config = await this.config.getForUser(state.to, state.contextToken);
          if (state.waiters === 0 || this.stopped) continue;
          if (!config.typingTicket) continue;
          state.ticket = config.typingTicket;
          // Even a failed request might have reached the server; cancel it later.
          state.started = true;
          status = TypingStatus.TYPING;
        } else {
          if (!state.started) continue;
          state.started = false;
          status = TypingStatus.CANCEL;
        }
        await sendTyping({
          // Keep cancellation independent of the already-aborted monitor signal.
          baseUrl: this.opts.baseUrl,
          token: this.opts.token,
          botAgent: this.opts.botAgent,
          body: {
            ilink_user_id: state.to,
            typing_ticket: state.ticket,
            status,
          },
        });
      } catch (err) {
        this.opts.log(`[weixin] typing failed for ${state.to} (ignored): ${String(err)}`);
      }
    }
  }
}
