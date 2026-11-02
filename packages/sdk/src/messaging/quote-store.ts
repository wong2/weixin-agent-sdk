import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../storage/state-dir.js";
import { logger } from "../util/logger.js";

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_MESSAGES_PER_ACCOUNT = 10_000;
const DEFAULT_MEDIA_RETENTION_DAYS = 7;
const DEFAULT_MAX_MEDIA_BYTES_PER_ACCOUNT = 256 * 1024 * 1024;
const DEFAULT_MAX_SINGLE_MEDIA_BYTES = 25 * 1024 * 1024;
const GC_TIMER_MS = 60 * 60 * 1000;

type SqliteStatement = {
  run: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};

type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
};

type DatabaseSyncConstructor = new (filePath: string) => SqliteDatabase;

export type QuoteCachePolicy = {
  enabled: boolean;
  retentionMs: number;
  maxMessagesPerAccount: number;
  mediaRetentionMs: number;
  maxMediaBytesPerAccount: number;
  maxSingleMediaBytes: number;
};

export type QuoteMessageRecord = {
  accountId: string;
  conversationId: string;
  messageId: string;
  direction: "inbound" | "outbound";
  body: string;
  mediaPath?: string;
  mediaMime?: string;
  mediaName?: string;
  mediaSize?: number;
  createdAt: number;
};

export type QuoteMessageInput = Omit<
  QuoteMessageRecord,
  "mediaPath" | "mediaSize"
> & {
  sourceMediaPath?: string;
};

export type QuoteCacheOptions = {
  enabled?: boolean;
  retentionDays?: number;
  maxMessagesPerAccount?: number;
  mediaRetentionDays?: number;
  maxMediaBytesPerAccount?: number;
  maxSingleMediaBytes?: number;
};

type StoredRow = {
  account_id: string;
  conversation_id: string;
  message_id: string;
  direction: "inbound" | "outbound";
  body: string;
  media_path: string | null;
  media_mime: string | null;
  media_name: string | null;
  media_size: number | null;
  created_at: number;
};

type MediaRow = {
  media_path: string;
  media_size: number;
  newest_at: number;
};

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return Math.max(1, Math.floor(positiveNumber(value, fallback)));
}

export function resolveQuoteCachePolicy(
  quote?: QuoteCacheOptions,
): QuoteCachePolicy {
  return {
    enabled: quote?.enabled !== false,
    retentionMs:
      positiveNumber(quote?.retentionDays, DEFAULT_RETENTION_DAYS) *
      24 *
      60 *
      60 *
      1000,
    maxMessagesPerAccount: positiveInteger(
      quote?.maxMessagesPerAccount,
      DEFAULT_MAX_MESSAGES_PER_ACCOUNT,
    ),
    mediaRetentionMs:
      positiveNumber(quote?.mediaRetentionDays, DEFAULT_MEDIA_RETENTION_DAYS) *
      24 *
      60 *
      60 *
      1000,
    maxMediaBytesPerAccount: positiveInteger(
      quote?.maxMediaBytesPerAccount,
      DEFAULT_MAX_MEDIA_BYTES_PER_ACCOUNT,
    ),
    maxSingleMediaBytes: positiveInteger(
      quote?.maxSingleMediaBytes,
      DEFAULT_MAX_SINGLE_MEDIA_BYTES,
    ),
  };
}

function safePathSegment(raw: string): string {
  const safe = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/\.\.+/g, "_");
  return safe && safe !== "." && safe !== ".." ? safe : "default";
}

function accountMediaDirName(accountId: string): string {
  const readable = safePathSegment(accountId).slice(0, 48);
  const digest = crypto
    .createHash("sha256")
    .update(accountId, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `${readable}-${digest}`;
}

export function quoteCacheRoot(accountId: string): string {
  return path.join(
    resolveStateDir(),
    "weixin-agent-sdk",
    "quotes",
    accountMediaDirName(accountId),
  );
}

export function deleteQuoteCacheForAccount(accountId: string): void {
  fs.rmSync(quoteCacheRoot(accountId), { recursive: true, force: true });
}

function asStoredRow(value: unknown): StoredRow | null {
  if (!value || typeof value !== "object") return null;
  return value as StoredRow;
}

export class QuoteStore {
  private readonly db: SqliteDatabase;
  private readonly mediaRoot: string;
  private policy: QuoteCachePolicy;
  private gcRunning = false;
  private gcRequested = false;
  private gcScheduled = false;
  private closed = false;
  private readonly gcTimer: ReturnType<typeof setInterval>;

  private constructor(
    db: SqliteDatabase,
    mediaRoot: string,
    policy: QuoteCachePolicy,
  ) {
    this.db = db;
    this.mediaRoot = mediaRoot;
    this.policy = policy;
    this.initializeSchema();
    this.gcTimer = setInterval(() => this.requestGc(), GC_TIMER_MS);
    this.gcTimer.unref();
    this.runGc();
  }

  static async open(params: {
    policy: QuoteCachePolicy;
    rootDir: string;
    mediaRoot?: string;
  }): Promise<QuoteStore | null> {
    if (!params.policy.enabled) return null;
    let opened: SqliteDatabase | undefined;
    try {
      const sqlite = (await import("node:sqlite")) as unknown as {
        DatabaseSync: DatabaseSyncConstructor;
      };
      const rootDir = params.rootDir;
      const mediaRoot = params.mediaRoot ?? path.join(rootDir, "media");
      fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(mediaRoot, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(rootDir, 0o700);
      } catch {
        // best-effort on filesystems without POSIX permissions
      }
      const dbPath = path.join(rootDir, "ref-messages.sqlite");
      const db = new sqlite.DatabaseSync(dbPath);
      opened = db;
      try {
        fs.chmodSync(dbPath, 0o600);
      } catch {
        // best-effort
      }
      return new QuoteStore(db, mediaRoot, params.policy);
    } catch (err) {
      opened?.close();
      logger.warn(
        `quote cache disabled: node:sqlite is unavailable or the database could not be opened: ${String(err)}`,
      );
      return null;
    }
  }

  updatePolicy(policy: QuoteCachePolicy): void {
    this.policy = policy;
    this.requestGc();
  }

  private initializeSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS quote_messages (
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        media_path TEXT,
        media_mime TEXT,
        media_name TEXT,
        media_size INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, conversation_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS quote_messages_account_created
        ON quote_messages (account_id, created_at);
      CREATE INDEX IF NOT EXISTS quote_messages_media_path
        ON quote_messages (media_path);
    `);
  }

  find(
    accountId: string,
    conversationId: string,
    messageId: string,
  ): QuoteMessageRecord | null {
    if (this.closed || !messageId) return null;
    const row = asStoredRow(
      this.db
        .prepare(
          `
          SELECT account_id, conversation_id, message_id, direction, body,
                 media_path, media_mime, media_name, media_size, created_at
          FROM quote_messages
          WHERE account_id = ? AND conversation_id = ? AND message_id = ?
        `,
        )
        .get(accountId, conversationId, messageId),
    );
    if (!row) return null;
    if (Date.now() - row.created_at > this.policy.retentionMs) {
      this.deleteMessage(accountId, conversationId, messageId);
      return null;
    }
    if (
      row.media_path &&
      Date.now() - row.created_at > this.policy.mediaRetentionMs
    ) {
      this.detachMedia(row.media_path);
      row.media_path = null;
    }
    return {
      accountId: row.account_id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      direction: row.direction,
      body: row.body,
      ...(row.media_path ? { mediaPath: row.media_path } : {}),
      ...(row.media_mime ? { mediaMime: row.media_mime } : {}),
      ...(row.media_name ? { mediaName: row.media_name } : {}),
      ...(typeof row.media_size === "number"
        ? { mediaSize: row.media_size }
        : {}),
      createdAt: row.created_at,
    };
  }

  async put(input: QuoteMessageInput): Promise<void> {
    if (
      this.closed ||
      !input.messageId ||
      (!input.body && !input.sourceMediaPath)
    )
      return;
    const media = input.sourceMediaPath
      ? this.registerManagedMedia(
          input.accountId,
          input.sourceMediaPath,
          input.mediaMime,
        )
      : null;
    this.db
      .prepare(
        `
        INSERT INTO quote_messages (
          account_id, conversation_id, message_id, direction, body,
          media_path, media_mime, media_name, media_size, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, conversation_id, message_id) DO UPDATE SET
          direction = excluded.direction,
          body = excluded.body,
          media_path = COALESCE(excluded.media_path, quote_messages.media_path),
          media_mime = COALESCE(excluded.media_mime, quote_messages.media_mime),
          media_name = COALESCE(excluded.media_name, quote_messages.media_name),
          media_size = COALESCE(excluded.media_size, quote_messages.media_size),
          created_at = excluded.created_at
      `,
      )
      .run(
        input.accountId,
        input.conversationId,
        input.messageId,
        input.direction,
        input.body,
        media?.path ?? null,
        input.mediaMime ?? media?.mime ?? null,
        input.mediaName ?? media?.name ?? null,
        media?.size ?? null,
        Number.isFinite(input.createdAt) && input.createdAt > 0
          ? input.createdAt
          : Date.now(),
      );

    this.runGc();
  }

  deleteAccount(accountId: string): void {
    if (this.closed) return;
    this.db
      .prepare("DELETE FROM quote_messages WHERE account_id = ?")
      .run(accountId);
    const accountMediaDir = path.join(
      this.mediaRoot,
      accountMediaDirName(accountId),
    );
    try {
      fs.rmSync(accountMediaDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        `quote cache: failed to remove media for account=${accountId}: ${String(err)}`,
      );
    }
  }

  private deleteMessage(
    accountId: string,
    conversationId: string,
    messageId: string,
  ): void {
    const existing = this.findMediaPath(accountId, conversationId, messageId);
    this.db
      .prepare(
        "DELETE FROM quote_messages WHERE account_id = ? AND conversation_id = ? AND message_id = ?",
      )
      .run(accountId, conversationId, messageId);
    if (existing) this.removeMediaIfOrphaned(existing);
  }

  private findMediaPath(
    accountId: string,
    conversationId: string,
    messageId: string,
  ): string | null {
    const row = this.db
      .prepare(
        "SELECT media_path FROM quote_messages WHERE account_id = ? AND conversation_id = ? AND message_id = ?",
      )
      .get(accountId, conversationId, messageId) as
      | { media_path?: unknown }
      | undefined;
    return typeof row?.media_path === "string" ? row.media_path : null;
  }

  private registerManagedMedia(
    accountId: string,
    sourcePath: string,
    mime?: string,
  ): { path: string; mime?: string; name: string; size: number } | null {
    try {
      const stat = fs.statSync(sourcePath);
      if (!stat.isFile() || stat.size > this.policy.maxSingleMediaBytes)
        return null;
      const dir = path.join(this.mediaRoot, accountMediaDirName(accountId));
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const destination = path.join(
        dir,
        crypto.randomUUID() + path.extname(sourcePath),
      );
      fs.copyFileSync(sourcePath, destination, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(destination, 0o600);
      return {
        path: destination,
        mime,
        name: path.basename(sourcePath),
        size: stat.size,
      };
    } catch (err) {
      logger.warn(`quote cache: failed to retain media: ${String(err)}`);
      return null;
    }
  }

  private requestGc(): void {
    if (this.closed) return;
    if (this.gcRunning) {
      this.gcRequested = true;
      return;
    }
    if (this.gcScheduled) return;
    this.gcScheduled = true;
    queueMicrotask(() => {
      this.gcScheduled = false;
      this.runGc();
    });
  }

  runGc(now = Date.now()): void {
    if (this.closed || this.gcRunning) {
      this.gcRequested = true;
      return;
    }
    this.gcRunning = true;
    try {
      const messageCutoff = now - this.policy.retentionMs;
      this.db
        .prepare("DELETE FROM quote_messages WHERE created_at < ?")
        .run(messageCutoff);

      const accounts = this.db
        .prepare("SELECT DISTINCT account_id FROM quote_messages")
        .all() as Array<{ account_id: string }>;
      for (const { account_id: accountId } of accounts) {
        this.db
          .prepare(
            `
            DELETE FROM quote_messages
            WHERE rowid IN (
              SELECT rowid FROM quote_messages
              WHERE account_id = ?
              ORDER BY created_at DESC, rowid DESC
              LIMIT -1 OFFSET ?
            )
          `,
          )
          .run(accountId, this.policy.maxMessagesPerAccount);
        this.expireOldMedia(accountId, now - this.policy.mediaRetentionMs);
        this.enforceMediaBudget(accountId);
      }
      this.pruneOrphanMediaFiles();
    } catch (err) {
      logger.warn(`quote cache GC failed: ${String(err)}`);
    } finally {
      this.gcRunning = false;
      if (this.gcRequested) {
        this.gcRequested = false;
        this.requestGc();
      }
    }
  }

  private listMedia(accountId: string): MediaRow[] {
    return this.db
      .prepare(
        `
        SELECT media_path, MAX(COALESCE(media_size, 0)) AS media_size,
               MAX(created_at) AS newest_at
        FROM quote_messages
        WHERE account_id = ? AND media_path IS NOT NULL
        GROUP BY media_path
        ORDER BY newest_at ASC
      `,
      )
      .all(accountId) as MediaRow[];
  }

  private expireOldMedia(accountId: string, cutoff: number): void {
    for (const media of this.listMedia(accountId)) {
      if (media.newest_at >= cutoff) continue;
      this.detachMedia(media.media_path);
    }
  }

  private enforceMediaBudget(accountId: string): void {
    const rows = this.listMedia(accountId);
    let total = rows.reduce((sum, row) => sum + Math.max(0, row.media_size), 0);
    for (const row of rows) {
      if (total <= this.policy.maxMediaBytesPerAccount) break;
      this.detachMedia(row.media_path);
      total -= Math.max(0, row.media_size);
    }
  }

  private detachMedia(mediaPath: string): void {
    this.db
      .prepare(
        "UPDATE quote_messages SET media_path = NULL WHERE media_path = ?",
      )
      .run(mediaPath);
    this.removeMediaIfOrphaned(mediaPath);
  }

  private removeMediaIfOrphaned(mediaPath: string): void {
    const row = this.db
      .prepare(
        "SELECT 1 AS found FROM quote_messages WHERE media_path = ? LIMIT 1",
      )
      .get(mediaPath) as { found?: number } | undefined;
    if (row?.found) return;
    try {
      fs.unlinkSync(mediaPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(
          `quote cache: failed to remove media path=${mediaPath}: ${String(err)}`,
        );
      }
    }
  }

  private pruneOrphanMediaFiles(): void {
    if (!fs.existsSync(this.mediaRoot)) return;
    const known = new Set(
      (
        this.db
          .prepare(
            "SELECT DISTINCT media_path FROM quote_messages WHERE media_path IS NOT NULL",
          )
          .all() as Array<{ media_path: string }>
      ).map((row) => row.media_path),
    );
    const visit = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(fullPath);
        else if (entry.isFile() && !known.has(fullPath)) {
          try {
            fs.unlinkSync(fullPath);
          } catch {
            // retry during the next GC pass
          }
        }
      }
    };
    visit(this.mediaRoot);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.gcTimer);
    this.db.close();
  }
}
