import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveStateDir } from "../storage/state-dir.js";
import { logger } from "../util/logger.js";

const accounts = new Map<string, Map<string, string>>();

function tokenFile(accountId: string): string {
  return path.join(
    resolveStateDir(),
    "openclaw-weixin",
    "accounts",
    `${encodeURIComponent(accountId)}.context-tokens.json`,
  );
}

export function restoreContextTokens(accountId: string): Map<string, string> {
  const file = tokenFile(accountId);
  const existing = accounts.get(file);
  if (existing) return existing;
  const tokens = new Map<string, string>();
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data && typeof data === "object" && !Array.isArray(data)) {
      for (const [user, token] of Object.entries(data)) {
        if (typeof token === "string" && token) tokens.set(user, token);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(
        "context tokens: unable to read cache; waiting for new inbound messages",
      );
    }
  }
  accounts.set(file, tokens);
  return tokens;
}

export function getContextToken(
  accountId: string,
  userId: string,
): string | undefined {
  return restoreContextTokens(accountId).get(userId);
}

export function setContextToken(
  accountId: string,
  userId: string,
  token: string,
): void {
  const tokens = restoreContextTokens(accountId);
  tokens.set(userId, token);
  const file = tokenFile(accountId);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(tokens)), {
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  } catch {
    logger.warn(
      "context tokens: unable to persist cache; keeping tokens in memory",
    );
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* best effort */
    }
  }
}

export function clearContextTokensForAccount(accountId: string): void {
  accounts.delete(tokenFile(accountId));
  fs.rmSync(tokenFile(accountId), { force: true });
}
