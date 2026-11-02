import type { Agent } from "../agent/interface.js";
import type { OutputFormat } from "../messaging/markdown.js";
import type { MessageHooks } from "../messaging/outbound.js";
import type { QuoteStore } from "../messaging/quote-store.js";
import { getUpdates, classifyFetchError } from "../api/api.js";
import { WeixinConfigManager } from "../api/config-cache.js";
import {
  STALE_TOKEN_ERRCODE,
  pauseSession,
  getRemainingPauseMs,
} from "../api/session-guard.js";
import { processOneMessage } from "../messaging/process-message.js";
import {
  getSyncBufFilePath,
  loadGetUpdatesBuf,
  saveGetUpdatesBuf,
} from "../storage/sync-buf.js";
import { logger } from "../util/logger.js";
import { redactBody } from "../util/redact.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

export type MonitorWeixinOpts = {
  outputFormat?: OutputFormat;
  botAgent?: string;
  hooks?: MessageHooks;
  quoteStore?: QuoteStore | null;
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  accountId: string;
  agent: Agent;
  abortSignal?: AbortSignal;
  longPollTimeoutMs?: number;
  log?: (msg: string) => void;
};

/**
 * Long-poll loop: getUpdates → process message → call agent → send reply.
 * Runs until aborted.
 */
export async function monitorWeixinProvider(
  opts: MonitorWeixinOpts,
): Promise<void> {
  const {
    baseUrl,
    cdnBaseUrl,
    token,
    accountId,
    agent,
    abortSignal,
    longPollTimeoutMs,
  } = opts;
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const errLog = (msg: string) => {
    log(msg);
    logger.error(msg);
  };
  const aLog = logger.withAccount(accountId);

  log(`[weixin] monitor started (${baseUrl}, account=${accountId})`);
  aLog.info(`Monitor started: baseUrl=${baseUrl}`);

  const syncFilePath = getSyncBufFilePath(accountId);
  const previousGetUpdatesBuf = loadGetUpdatesBuf(syncFilePath);
  let getUpdatesBuf = previousGetUpdatesBuf ?? "";

  if (previousGetUpdatesBuf) {
    log(
      `[weixin] resuming from previous sync buf (${getUpdatesBuf.length} bytes)`,
    );
  } else {
    log(`[weixin] no previous sync buf, starting fresh`);
  }

  const configManager = new WeixinConfigManager(
    { baseUrl, token, botAgent: opts.botAgent },
    log,
  );

  let nextTimeoutMs = longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  while (!abortSignal?.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: getUpdatesBuf,
        botAgent: opts.botAgent,
        timeoutMs: nextTimeoutMs,
        abortSignal,
      });

      if (
        resp.longpolling_timeout_ms != null &&
        resp.longpolling_timeout_ms > 0
      ) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        const isSessionExpired =
          resp.errcode === STALE_TOKEN_ERRCODE ||
          resp.ret === STALE_TOKEN_ERRCODE;

        if (isSessionExpired) {
          pauseSession(accountId);
          const pauseMs = getRemainingPauseMs(accountId);
          errLog(
            `[weixin] token stale (errcode ${STALE_TOKEN_ERRCODE}), pausing for ${Math.ceil(pauseMs / 60_000)} min. Please run \`npx weixin-acp login\` to re-login.`,
          );
          consecutiveFailures = 0;
          await sleep(pauseMs, abortSignal);
          continue;
        }

        consecutiveFailures += 1;
        errLog(
          `[weixin] getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          errLog(
            `[weixin] ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`,
          );
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
        saveGetUpdatesBuf(syncFilePath, resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      const list = resp.msgs ?? [];
      for (const full of list) {
        if (abortSignal?.aborted) return;
        aLog.info(
          `inbound: from=${full.from_user_id} types=${full.item_list?.map((i) => i.type).join(",") ?? "none"}`,
        );

        const fromUserId = full.from_user_id ?? "";
        const cachedConfig = await configManager.getForUser(
          fromUserId,
          full.context_token,
        );

        await processOneMessage(full, {
          outputFormat: opts.outputFormat,
          botAgent: opts.botAgent,
          hooks: opts.hooks,
          quoteStore: opts.quoteStore,
          accountId,
          agent,
          baseUrl,
          cdnBaseUrl,
          token,
          typingTicket: cachedConfig.typingTicket,
          log,
          errLog,
        });
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        aLog.info(`Monitor stopped (aborted)`);
        return;
      }
      consecutiveFailures += 1;
      errLog(
        `[weixin] getUpdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)} (${classifyFetchError(err).type})`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }
  aLog.info(`Monitor ended`);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    const { setTimeout } = await import("node:timers/promises");
    await setTimeout(ms, undefined, { signal });
  } catch (err) {
    if (!signal?.aborted) throw err;
  }
}
