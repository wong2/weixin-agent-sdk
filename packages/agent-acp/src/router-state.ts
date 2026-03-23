import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type RouterState = {
  conversations: Record<string, string>;
};

function defaultState(): RouterState {
  return { conversations: {} };
}

function resolveDefaultStatePath(): string {
  return path.join(os.homedir(), ".openclaw", "openclaw-weixin", "acp-router-state.json");
}

export class RouterStateStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath?.trim() || resolveDefaultStatePath();
  }

  getBackend(conversationId: string): string | undefined {
    const state = this.readState();
    const backend = state.conversations[conversationId];
    return backend?.trim() || undefined;
  }

  setBackend(conversationId: string, backend: string): void {
    const state = this.readState();
    state.conversations[conversationId] = backend;
    this.writeState(state);
  }

  private readState(): RouterState {
    try {
      if (!fs.existsSync(this.filePath)) {
        return defaultState();
      }
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<RouterState>;
      return {
        conversations: parsed.conversations ?? {},
      };
    } catch {
      return defaultState();
    }
  }

  private writeState(state: RouterState): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, this.filePath);
  }
}
