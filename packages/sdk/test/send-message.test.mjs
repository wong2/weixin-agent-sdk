import { stateDir } from "./test-state.mjs";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Bot } from "../.test-dist/src/bot.js";
import { setContextToken } from "../.test-dist/src/messaging/inbound.js";
import { processOneMessage } from "../.test-dist/src/messaging/process-message.js";
import {
  QuoteStore,
  resolveQuoteCachePolicy,
} from "../.test-dist/src/messaging/quote-store.js";

test("Bot.sendMessage retains link destinations in string and ChatResponse payloads", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
  });
  setContextToken("markdown-test", "test-user", "test-context");
  const bot = new Bot({
    accountId: "markdown-test",
    userId: "test-user",
    baseUrl: "https://weixin.invalid",
    cdnBaseUrl: "https://cdn.invalid",
    token: "test-token",
    monitorPromise: Promise.resolve(),
  });
  const text =
    "[查看详情](https://example.com/a_b_(c))\nhttps://example.com/d_e_f";
  await bot.sendMessage(text);
  await bot.sendMessage({ text });

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.msg.context_token, "test-context");
    assert.equal(
      request.msg.item_list[0].text_item.text,
      "查看详情\nhttps://example.com/a_b_(c)\nhttps://example.com/d_e_f",
    );
  }
});

function bot(options = {}, quoteStore) {
  setContextToken("send-test", "test-user", "test-context");
  return new Bot({
    accountId: "send-test",
    userId: "test-user",
    baseUrl: "https://weixin.invalid",
    cdnBaseUrl: "https://cdn.invalid",
    monitorPromise: Promise.resolve(),
    options,
    quoteStore,
  });
}

test("Markdown default and per-response override cover proactive and automatic replies", async (t) => {
  const texts = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    texts.push(JSON.parse(options.body).msg.item_list[0].text_item.text);
    return new Response("{}");
  });
  const client = bot({ outputFormat: "markdown" });
  const text = "**标题** [详情](https://example.com/a_中文_c)";
  await client.sendMessage(text);
  await client.sendMessage({ text, outputFormat: "plain" });
  await processOneMessage(
    {
      from_user_id: "test-user",
      context_token: "test-context",
      item_list: [{ type: 1, text_item: { text: "hello" } }],
    },
    {
      accountId: "send-test",
      baseUrl: "https://weixin.invalid",
      cdnBaseUrl: "https://cdn.invalid",
      outputFormat: "markdown",
      agent: { chat: async () => ({ text }) },
      log: () => {},
      errLog: () => {},
    },
  );
  assert.deepEqual(texts, [
    text,
    "标题 详情\nhttps://example.com/a_中文_c",
    text,
  ]);
});

test("hooks can replace/cancel and observe delivery failure without hiding it", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls++;
    assert.equal(
      JSON.parse(options.body).msg.item_list[0].text_item.text,
      "changed",
    );
    return new Response('{"ret":-1,"errmsg":"test rejection"}');
  });
  let observed;
  const client = bot({
    hooks: {
      beforeSend: () => ({ text: "changed" }),
      afterSend: (event) => {
        observed = event;
        throw new Error("observer failed");
      },
    },
  });
  await assert.rejects(client.sendMessage("original"), /test rejection/);
  assert.match(observed.error.message, /test rejection/);
  assert.equal(observed.conversationId, "test-user");
  await bot({ hooks: { beforeSend: () => false } }).sendMessage("cancelled");
  assert.equal(calls, 1);
});

test("text and media sends cache the exact sent content and server IDs separately", async (t) => {
  const store = await QuoteStore.open({
    rootDir: path.join(stateDir, "outbound-quotes"),
    policy: resolveQuoteCachePolicy(),
  });
  t.after(() => store.close());
  let sequence = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.includes("getuploadurl"))
      return new Response('{"upload_full_url":"https://cdn.invalid/upload"}');
    if (url.includes("cdn.invalid"))
      return new Response("", {
        headers: { "x-encrypted-param": "test-param" },
      });
    assert.equal(JSON.parse(options.body).msg.item_list.length, 1);
    return new Response(
      JSON.stringify({ ret: 0, message_id: String(++sequence) }),
    );
  });
  const client = bot({ outputFormat: "markdown" }, Promise.resolve(store));
  await client.sendMessage("**text**");
  const file = path.join(stateDir, "upload.txt");
  fs.writeFileSync(file, "test attachment");
  await client.sendMessage({
    text: "**caption**",
    media: { type: "file", url: file, fileName: "original.txt" },
  });
  assert.equal(store.find("send-test", "test-user", "1").body, "**text**");
  assert.equal(store.find("send-test", "test-user", "2").body, "**caption**");
  const media = store.find("send-test", "test-user", "3");
  assert.equal(media.mediaName, "original.txt");
  assert.equal(fs.readFileSync(media.mediaPath, "utf8"), "test attachment");
});
