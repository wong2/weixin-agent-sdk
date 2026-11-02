import "./test-state.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  apiPostFetch,
  apiGetFetch,
  buildBaseInfo,
  classifyFetchError,
  getUpdates,
  parseWeixinApiJson,
  sanitizeBotAgent,
  sendMessage,
} from "../.test-dist/src/api/api.js";
import { redactBody } from "../.test-dist/src/util/redact.js";

test("send rejects service errors even on HTTP 200", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response('{"ret":-14,"errmsg":"expired"}'),
  );
  await assert.rejects(
    sendMessage({ baseUrl: "https://test.invalid", body: {} }),
    /ret=-14.*expired/,
  );
});

test("request metadata, headers and lossless send result", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.headers["iLink-App-Id"], "bot");
    assert.equal(options.headers["iLink-App-ClientVersion"], "1280");
    assert.equal(options.headers["Content-Length"], undefined);
    assert.equal(options.headers.Authorization, "Bearer test-token");
    assert.deepEqual(JSON.parse(options.body).base_info, {
      channel_version: "0.5.0",
      bot_agent: "MyApp/1.0 (test)",
    });
    return new Response('{"ret":0,"message_id":18446744073709551615}');
  });
  const response = await sendMessage({
    baseUrl: "https://test.invalid",
    token: "test-token",
    botAgent: "MyApp/1.0 (test)",
    body: {},
  });
  assert.equal(response.message_id, "18446744073709551615");
  assert.equal(buildBaseInfo().channel_version, "0.5.0");
  assert.equal(sanitizeBotAgent("bad\nvalue"), "weixin-agent-sdk/0.5.0");
  assert.ok(sanitizeBotAgent(Array(100).fill("App/1").join(" ")).length <= 256);
});

test("ID parsing preserves strings, nested IDs, ordinary numbers and rejects malformed JSON", () => {
  const data = parseWeixinApiJson(
    '{"message_id":18446744073709551615,"nested":{"svr_id":9007199254740993,"msg_id":"123"},"seq":7,"text":"\\\"message_id\\\":123"}',
  );
  assert.deepEqual(data, {
    message_id: "18446744073709551615",
    nested: { svr_id: "9007199254740993", msg_id: "123" },
    seq: 7,
    text: '"message_id":123',
  });
  assert.throws(() => parseWeixinApiJson('{"message_id":}'));
});

test("getUpdates uses lossless parsing", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response('{"ret":0,"msgs":[{"message_id":18446744073709551615}]}'),
  );
  assert.equal(
    (await getUpdates({ baseUrl: "https://test.invalid" })).msgs[0].message_id,
    "18446744073709551615",
  );
});

test("GET and POST observe pre-aborted signals", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    options.signal.throwIfAborted();
  });
  const signal = AbortSignal.abort();
  const params = {
    baseUrl: "https://test.invalid",
    endpoint: "test",
    label: "test",
    abortSignal: signal,
  };
  await assert.rejects(apiGetFetch(params), { name: "AbortError" });
  await assert.rejects(
    apiPostFetch({ ...params, body: "{}", timeoutMs: 100 }),
    { name: "AbortError" },
  );
});

test("timeouts cover response-body reads", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, options) => ({
    ok: true,
    status: 200,
    text: () =>
      new Promise((_, reject) =>
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        ),
      ),
  }));
  const params = {
    baseUrl: "https://test.invalid",
    endpoint: "test",
    label: "test",
    timeoutMs: 10,
  };
  await assert.rejects(apiGetFetch(params), { name: "AbortError" });
  await assert.rejects(apiPostFetch({ ...params, body: "{}" }), {
    name: "AbortError",
  });
});

test("network diagnostics and credential redaction", () => {
  for (const [code, type] of [
    ["ENOTFOUND", "dns"],
    ["ECONNREFUSED", "tcp"],
    ["CERT_HAS_EXPIRED", "tls"],
  ]) {
    assert.equal(
      classifyFetchError(new Error("fetch failed", { cause: { code } })).type,
      type,
    );
  }
  assert.equal(
    classifyFetchError(new DOMException("aborted", "AbortError")).type,
    "timeout",
  );
  const body = redactBody(
    JSON.stringify({
      local_token_list: ["secret-token"],
      verify_code: "123456",
      context_token: "context-secret",
      aeskey: "aes-secret",
    }),
    1000,
  );
  for (const secret of [
    "secret-token",
    "123456",
    "context-secret",
    "aes-secret",
  ])
    assert.ok(!body.includes(secret));
});
