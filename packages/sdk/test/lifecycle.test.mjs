import "./test-state.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { start, logout } from "../.test-dist/src/bot.js";
import {
  registerWeixinAccountId,
  saveWeixinAccount,
} from "../.test-dist/src/auth/accounts.js";
import {
  getContextToken,
  setContextToken,
} from "../.test-dist/src/messaging/context-tokens.js";

test("start/stop notifications and immediate long-poll cancellation", async (t) => {
  const controller = new AbortController();
  const endpoints = [];
  saveWeixinAccount("lifecycle", { token: "test-token", userId: "test-user" });
  registerWeixinAccountId("lifecycle");
  setContextToken("lifecycle", "test-user", "test-context");
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const endpoint = new URL(url).pathname;
    endpoints.push(endpoint);
    assert.equal(JSON.parse(options.body).base_info.bot_agent, "Lifecycle/1");
    if (endpoint.endsWith("getupdates")) {
      controller.abort();
      options.signal.throwIfAborted();
    }
    return new Response('{"ret":0}');
  });
  const bot = start(
    { chat: async () => ({}) },
    {
      abortSignal: controller.signal,
      botAgent: "Lifecycle/1",
      quoteCache: { enabled: false },
      log: () => {},
    },
  );
  await bot.wait();
  assert.deepEqual(endpoints, [
    "/ilink/bot/msg/notifystart",
    "/ilink/bot/getupdates",
    "/ilink/bot/msg/notifystop",
  ]);
  logout({ log: () => {} });
  assert.equal(getContextToken("lifecycle", "test-user"), undefined);
});

test("lifecycle notification failure does not prevent polling", async (t) => {
  const controller = new AbortController();
  saveWeixinAccount("lifecycle-failure", {
    token: "test-token",
    userId: "test-user",
  });
  let polled = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.includes("getupdates")) {
      polled = true;
      controller.abort();
      options.signal.throwIfAborted();
    }
    throw new Error("notification failed");
  });
  await start(
    { chat: async () => ({}) },
    {
      accountId: "lifecycle-failure",
      abortSignal: controller.signal,
      quoteCache: { enabled: false },
      log: () => {},
    },
  ).wait();
  assert.equal(polled, true);
});
