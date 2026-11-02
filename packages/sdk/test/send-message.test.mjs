import assert from "node:assert/strict";
import { test } from "node:test";
import { Bot } from "../.test-dist/src/bot.js";
import { setContextToken } from "../.test-dist/src/messaging/inbound.js";

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
  const text = "[查看详情](https://example.com/a_b_(c))\nhttps://example.com/d_e_f";
  await bot.sendMessage(text);
  await bot.sendMessage({ text });

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.msg.context_token, "test-context");
    assert.equal(request.msg.item_list[0].text_item.text,
      "查看详情\nhttps://example.com/a_b_(c)\nhttps://example.com/d_e_f");
  }
});
