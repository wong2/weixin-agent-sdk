import "./test-state.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  startWeixinLoginWithQr,
  waitForWeixinLogin,
} from "../.test-dist/src/auth/login-qr.js";
import {
  registerWeixinAccountId,
  saveWeixinAccount,
} from "../.test-dist/src/auth/accounts.js";
import { login } from "../.test-dist/src/bot.js";
import qrcodeTerminal from "qrcode-terminal";

const base = "https://test.invalid";
function mockLogin(t, statuses, inspect) {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.includes("get_bot_qrcode")) {
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body).local_token_list, [
        "local-test-token",
      ]);
      return new Response(
        JSON.stringify({
          qrcode: "qr",
          qrcode_img_content: "https://test.invalid/qr",
        }),
      );
    }
    inspect?.(new URL(url));
    return new Response(JSON.stringify(statuses.shift() ?? { status: "wait" }));
  });
  saveWeixinAccount("login-test", {
    token: "local-test-token",
    userId: "test-user",
  });
  registerWeixinAccountId("login-test");
}

test("QR POST, verifier retry and encoded submission", async (t) => {
  const codes = [];
  mockLogin(
    t,
    [
      { status: "need_verifycode" },
      { status: "need_verifycode" },
      {
        status: "confirmed",
        ilink_bot_id: "new-bot",
        bot_token: "new-test-token",
      },
    ],
    (url) => codes.push(url.searchParams.get("verify_code")),
  );
  const start = await startWeixinLoginWithQr({ apiBaseUrl: base });
  const retries = [];
  const result = await waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: base,
    onVerifyCode: ({ retry }) => {
      retries.push(retry);
      return retry ? "654321" : "123456";
    },
  });
  assert.equal(result.connected, true);
  assert.deepEqual(retries, [false, true]);
  assert.deepEqual(codes, [null, "123456", "654321"]);
});

test("verification without a handler fails explicitly", async (t) => {
  mockLogin(t, [{ status: "need_verifycode" }]);
  const start = await startWeixinLoginWithQr({ apiBaseUrl: base });
  const result = await waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: base,
  });
  assert.equal(result.connected, false);
  assert.match(result.message, /onVerifyCode/);
});

test("login cancellation interrupts a pending application verification callback", async (t) => {
  mockLogin(t, [{ status: "need_verifycode" }]);
  const start = await startWeixinLoginWithQr({ apiBaseUrl: base });
  const controller = new AbortController();
  const result = await waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: base,
    abortSignal: controller.signal,
    onVerifyCode: () => {
      controller.abort();
      return new Promise(() => {});
    },
  });
  assert.equal(result.connected, false);
  assert.match(result.message, /abort/i);
});

test("already-bound login returns the existing account successfully", async (t) => {
  mockLogin(t, [{ status: "binded_redirect" }]);
  t.mock.method(qrcodeTerminal, "generate", (_url, _options, callback) =>
    callback?.(""),
  );
  assert.equal(await login({ log: () => {} }), "login-test");
});

test("verification attempts are bounded", async (t) => {
  mockLogin(
    t,
    Array.from({ length: 4 }, () => ({ status: "need_verifycode" })),
  );
  const start = await startWeixinLoginWithQr({ apiBaseUrl: base });
  let prompts = 0;
  const result = await waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: base,
    onVerifyCode: () => {
      prompts++;
      return "123456";
    },
  });
  assert.equal(prompts, 3);
  assert.equal(result.connected, false);
  assert.match(result.message, /上限/);
});

test("blocked verification refreshes QR and resumes polling", async (t) => {
  mockLogin(t, [
    { status: "verify_code_blocked" },
    { status: "confirmed", ilink_bot_id: "new-bot", bot_token: "test-token" },
  ]);
  t.mock.method(qrcodeTerminal, "generate", () => {});
  const start = await startWeixinLoginWithQr({ apiBaseUrl: base });
  const result = await waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: base,
  });
  assert.equal(result.connected, true);
  assert.equal(
    globalThis.fetch.mock.calls.filter((call) =>
      call.arguments[0].includes("get_bot_qrcode"),
    ).length,
    2,
  );
});

test("IDC redirects retain HTTPS and continue on the redirected host", async (t) => {
  const hosts = [];
  mockLogin(
    t,
    [
      { status: "scaned_but_redirect", redirect_host: "redirect.invalid" },
      { status: "confirmed", ilink_bot_id: "bot", bot_token: "test-token" },
    ],
    (url) => hosts.push(url.origin),
  );
  const start = await startWeixinLoginWithQr({ apiBaseUrl: base });
  assert.equal(
    (
      await waitForWeixinLogin({
        sessionKey: start.sessionKey,
        apiBaseUrl: base,
      })
    ).connected,
    true,
  );
  assert.deepEqual(hosts, [
    "https://ilinkai.weixin.qq.com",
    "https://redirect.invalid",
  ]);
});
