import { stateDir } from "./test-state.mjs";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  QuoteStore,
  resolveQuoteCachePolicy,
} from "../.test-dist/src/messaging/quote-store.js";
import { processOneMessage } from "../.test-dist/src/messaging/process-message.js";
import { resolveQuote } from "../.test-dist/src/messaging/quotes.js";
import { createHash } from "node:crypto";

async function openStore(t, options = {}) {
  const rootDir = fs.mkdtempSync(path.join(stateDir, "quotes-"));
  const policy = resolveQuoteCachePolicy(options);
  const store = await QuoteStore.open({ policy, rootDir });
  assert.ok(store);
  t.after(() => store.close());
  return { store, rootDir, policy };
}
const input = (messageId, extra = {}) => ({
  accountId: "account",
  conversationId: "user",
  messageId,
  direction: "inbound",
  body: "one two three",
  createdAt: Date.now(),
  ...extra,
});
const reference = (extra = {}) => ({
  from_user_id: "user",
  item_list: [
    {
      type: 1,
      text_item: { text: "解释一下" },
      ref_msg: { svr_id: "18446744073709551615", ...extra },
    },
  ],
});

test("quote cache persists and isolates accounts and conversations", async (t) => {
  const { store, rootDir, policy } = await openStore(t);
  await store.put(input("18446744073709551615"));
  assert.equal(
    store.find("account", "other-user", "18446744073709551615"),
    null,
  );
  assert.equal(
    store.find("other-account", "user", "18446744073709551615"),
    null,
  );
  store.close();
  const reopened = await QuoteStore.open({ rootDir, policy });
  t.after(() => reopened.close());
  assert.equal(
    reopened.find("account", "user", "18446744073709551615").body,
    "one two three",
  );
});

test("quoted text and partial quote reach existing Agent.chat consumers", async (t) => {
  const { store } = await openStore(t);
  await store.put(input("18446744073709551615"));
  let received;
  await processOneMessage(
    reference({
      partial_text: {
        start: "two",
        end: "two",
        startindex: 0,
        endindex: 0,
        quotemd5: createHash("md5").update("two").digest("hex"),
      },
    }),
    {
      accountId: "account",
      quoteStore: store,
      baseUrl: "https://test.invalid",
      cdnBaseUrl: "https://cdn.invalid",
      agent: {
        chat: async (request) => {
          received = request;
          return {};
        },
      },
      log: () => {},
      errLog: () => {},
    },
  );
  assert.equal(received.text, "[引用: two]\n解释一下");
  assert.equal(received.quote.messageId, "18446744073709551615");
  assert.equal(received.quote.text, "one two three");
  assert.equal(
    resolveQuote(reference(), "different-account", store).missing,
    true,
  );
  assert.equal(
    resolveQuote(reference({ title: "inline" }), "account", store).text,
    "inline",
  );
});

test("media copies survive source removal and expire independently of text", async (t) => {
  const { store } = await openStore(t, { mediaRetentionDays: 1 });
  const source = path.join(stateDir, "document.txt");
  fs.writeFileSync(source, "file contents");
  await store.put(
    input("18446744073709551615", {
      sourceMediaPath: source,
      mediaName: "document.txt",
      mediaMime: "text/plain",
    }),
  );
  fs.unlinkSync(source);
  const quote = resolveQuote(reference(), "account", store);
  assert.equal(fs.readFileSync(quote.media.filePath, "utf8"), "file contents");
  store.runGc(Date.now() + 2 * 86400000);
  assert.equal(fs.existsSync(quote.media.filePath), false);
  assert.match(resolveQuote(reference(), "account", store).text, /附件已过期/);
});

test("cache enforces message count, age, individual file and media budgets", async (t) => {
  const { store } = await openStore(t, {
    maxMessagesPerAccount: 2,
    maxSingleMediaBytes: 4,
    maxMediaBytesPerAccount: 4,
  });
  const source = path.join(stateDir, "small.bin");
  fs.writeFileSync(source, "1234");
  await store.put(input("old", { createdAt: Date.now() - 40 * 86400000 }));
  assert.equal(store.find("account", "user", "old"), null);
  for (let i = 0; i < 3; i++)
    await store.put(
      input(String(i), {
        sourceMediaPath: source,
        mediaMime: "application/octet-stream",
      }),
    );
  assert.equal(store.find("account", "user", "0"), null);
  assert.equal(store.find("account", "user", "1").mediaPath, undefined);
  assert.ok(store.find("account", "user", "2").mediaPath);
  fs.writeFileSync(source, "12345");
  await store.put(input("large", { sourceMediaPath: source }));
  assert.equal(store.find("account", "user", "large").mediaPath, undefined);
  store.deleteAccount("account");
  assert.equal(store.find("account", "user", "large"), null);
  assert.equal(fs.readFileSync(source, "utf8"), "12345");
});

test("disabled and unavailable cache degrade without affecting normal messages", async (t) => {
  const rootDir = path.join(stateDir, "disabled");
  assert.equal(
    await QuoteStore.open({
      rootDir,
      policy: resolveQuoteCachePolicy({ enabled: false }),
    }),
    null,
  );
  assert.equal(fs.existsSync(rootDir), false);
  fs.writeFileSync(rootDir, "not a directory");
  assert.equal(
    await QuoteStore.open({ rootDir, policy: resolveQuoteCachePolicy() }),
    null,
  );
  const quote = resolveQuote(reference(), "account", null);
  assert.equal(quote.missing, true);
});
