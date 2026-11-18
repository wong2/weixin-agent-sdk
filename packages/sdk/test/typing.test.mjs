import "./test-state.mjs";
import assert from "node:assert/strict";
import { setImmediate as flush } from "node:timers/promises";
import { test } from "node:test";
import { TypingManager } from "../.test-dist/src/messaging/typing.js";
import { processOneMessage } from "../.test-dist/src/messaging/process-message.js";
import { start } from "../.test-dist/src/bot.js";
import { saveWeixinAccount } from "../.test-dist/src/auth/accounts.js";

const deferred = () => Promise.withResolvers();
const ok = () => new Response('{"ret":0}');
const message = (text = "hello", from = "user") => ({
  from_user_id: from,
  context_token: "context",
  item_list: [{ type: 1, text_item: { text } }],
});

function setup(t, handle = () => {}, options = {}) {
  const requests = [];
  const logs = [];
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.mock.method(globalThis, "fetch", async (url, opts) => {
    const endpoint = new URL(url).pathname.split("/").at(-1);
    const body = JSON.parse(opts.body);
    requests.push({ endpoint, body, token: opts.headers.Authorization });
    const result = await handle(endpoint, body, opts);
    if (result) return result;
    return endpoint === "getconfig"
      ? new Response('{"ret":0,"typing_ticket":"ticket"}')
      : ok();
  });
  const managerOptions = {
    baseUrl: "https://weixin.invalid",
    token: "token",
    botAgent: "TypingTest/1",
    log: (msg) => logs.push(msg),
    ...options,
  };
  const typing = new TypingManager(managerOptions);
  t.after(() => typing.stop());
  return {
    typing, requests, logs, managerOptions,
    statuses: () => requests.filter((r) => r.endpoint === "sendtyping").map((r) => r.body.status),
    process: (chat, full = message()) => processOneMessage(full, {
      accountId: "typing-test",
      baseUrl: "https://weixin.invalid",
      cdnBaseUrl: "https://cdn.invalid",
      agent: { chat },
      typing,
      log: () => {},
      errLog: () => {},
    }),
  };
}

test("overlapping async waits share renewals and allow later ordinary chat", async (t) => {
  const f = setup(t);
  const first = deferred();
  const second = deferred();
  await f.process(async () => ({ typingUntil: first.promise }));
  await f.process(async () => ({ typingUntil: second.promise }));
  await flush();
  assert.deepEqual(f.statuses(), [1]);

  // A later ordinary request must not cancel either background wait.
  await f.process(async () => ({ text: "ordinary reply" }));
  first.resolve();
  await flush();
  t.mock.timers.tick(10_000);
  await flush();
  assert.deepEqual(f.statuses(), [1, 1]);
  second.resolve();
  await flush();
  assert.deepEqual(f.statuses(), [1, 1, 2]);
  t.mock.timers.tick(30_000);
  await flush();
  assert.deepEqual(f.statuses(), [1, 1, 2]);
});

for (const earlyCompletion of [false, true]) {
  test(`automatic delivery retains typing (early async completion: ${earlyCompletion})`, async (t) => {
    const reply = deferred();
    const delivered = deferred();
    const f = setup(t, (endpoint) => endpoint === "sendmessage" ? delivered.promise : undefined);
    const processing = f.process(() => reply.promise);
    await flush();
    assert.deepEqual(f.statuses(), [1]);
    reply.resolve({
      text: "automatic reply",
      ...(earlyCompletion ? { typingUntil: Promise.resolve() } : {}),
    });
    await flush();
    t.mock.timers.tick(10_000);
    await flush();
    assert.deepEqual(f.statuses(), [1, 1]);
    delivered.resolve(ok());
    await processing;
    await flush();
    assert.deepEqual(f.statuses(), [1, 1, 2]);
    const body = f.requests.find((r) => r.endpoint === "sendmessage").body;
    assert.equal(JSON.stringify(body).includes("typingUntil"), false);
  });
}

test("rejecting typingUntil releases only its wait and sends no error notice", async (t) => {
  const f = setup(t);
  const pending = deferred();
  await f.process(async () => ({ typingUntil: pending.promise }));
  await flush();
  pending.reject(new Error("backend failed"));
  await flush();
  assert.deepEqual(f.statuses(), [1, 2]);
  assert.equal(f.requests.some((r) => r.endpoint === "sendmessage"), false);
  // A rejection already queued when chat returns is also observed immediately.
  await f.process(async () => ({ typingUntil: Promise.reject(new Error("early failure")) }));
  await flush();
  assert.equal(f.requests.some((r) => r.endpoint === "sendmessage"), false);
  const count = f.requests.length;
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(f.requests.length, count);
});

test("chat failure releases ordinary typing without ending an older async wait", async (t) => {
  const f = setup(t);
  const pending = deferred();
  await f.process(async () => ({ typingUntil: pending.promise }));
  await flush();
  await f.process(async () => { throw new Error("chat failed"); });
  await flush();
  assert.deepEqual(f.statuses(), [1]);
  pending.resolve();
  await flush();
  assert.deepEqual(f.statuses(), [1, 2]);
  assert.equal(f.requests.filter((r) => r.endpoint === "sendmessage").length, 1);
  const chat = deferred();
  const processing = f.process(() => chat.promise);
  await flush();
  chat.reject(new Error("standalone chat failed"));
  await processing;
  await flush();
  assert.deepEqual(f.statuses(), [1, 2, 1, 2]);
});

test("cancellation follows a delayed renewal, and stop clears all renewal timers", async (t) => {
  const renewal = deferred();
  let starts = 0;
  const f = setup(t, (endpoint, body) => {
    if (endpoint === "sendtyping" && body.status === 1 && ++starts === 2) return renewal.promise;
  });
  const release = f.typing.acquire("user", "context");
  await flush();
  t.mock.timers.tick(10_000);
  await flush();
  release();
  const stopped = f.typing.stop();
  t.mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(f.statuses(), [1, 1]);
  renewal.resolve(ok());
  await stopped;
  assert.deepEqual(f.statuses(), [1, 1, 2]);
  f.typing.acquire("user", "context")();
  t.mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(f.statuses(), [1, 1, 2]);
});

test("a request arriving during cancellation restarts typing after cancellation finishes", async (t) => {
  const cancel = deferred();
  const f = setup(t, (endpoint, body) =>
    endpoint === "sendtyping" && body.status === 2 ? cancel.promise : undefined);
  const release = f.typing.acquire("user");
  await flush();
  release();
  await flush();
  const releaseNext = f.typing.acquire("user");
  await flush();
  assert.deepEqual(f.statuses(), [1, 2]);
  cancel.resolve(ok());
  await flush();
  assert.deepEqual(f.statuses(), [1, 2, 1]);
  releaseNext();
  await flush();
  assert.deepEqual(f.statuses(), [1, 2, 1, 2]);
});

test("abort during a delayed ticket lookup never starts typing or blocks chat", async (t) => {
  const controller = new AbortController();
  const config = deferred();
  const f = setup(t, (endpoint) => endpoint === "getconfig" ? config.promise : undefined,
    { abortSignal: controller.signal });
  const pending = deferred();
  await f.process(async () => ({ text: "reply", typingUntil: pending.promise }));
  assert.equal(f.requests.filter((r) => r.endpoint === "sendmessage").length, 1);
  controller.abort();
  config.resolve(new Response('{"ret":0,"typing_ticket":"late-ticket"}'));
  await f.typing.stop();
  pending.reject(new Error("late rejection"));
  t.mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(f.statuses(), []);
});

test("abort cancels typing even while chat is still running", async (t) => {
  const controller = new AbortController();
  const f = setup(t, undefined, { abortSignal: controller.signal });
  const chat = deferred();
  const pending = deferred();
  const processing = f.process(() => chat.promise);
  await flush();
  controller.abort();
  await flush();
  assert.deepEqual(f.statuses(), [1, 2]);
  chat.resolve({ typingUntil: pending.promise });
  await processing;
  pending.reject(new Error("after abort"));
  t.mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(f.statuses(), [1, 2]);
});

test("different accounts and conversations have independent waits", async (t) => {
  const f = setup(t);
  const other = new TypingManager({ ...f.managerOptions, token: "other-account" });
  t.after(() => other.stop());
  const a = f.typing.acquire("same-user");
  const b = f.typing.acquire("other-user");
  const c = other.acquire("same-user");
  await flush();
  a();
  await flush();
  const cancellations = () => f.requests.filter((r) => r.endpoint === "sendtyping" && r.body.status === 2);
  assert.deepEqual(cancellations().map((r) => [r.token, r.body.ilink_user_id]), [["Bearer token", "same-user"]]);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(f.statuses().filter((s) => s === 1).length, 5);
  b(); c();
  await flush();
  assert.equal(cancellations().length, 3);
});

for (const endpoint of ["getconfig", "sendtyping"]) {
  for (const failure of ["network", "service"]) {
    test(`${endpoint} ${failure} failure is logged and does not prevent replies`, async (t) => {
      const f = setup(t, (name) => {
        if (name !== endpoint) return;
        if (failure === "network") throw new Error("network failure");
        return new Response('{"ret":-1,"errmsg":"service failure"}');
      });
      const pending = deferred();
      await f.process(async () => ({ text: "reply", typingUntil: pending.promise }));
      await flush();
      assert.equal(f.requests.filter((r) => r.endpoint === "sendmessage").length, 1);
      assert.ok(f.logs.some((line) => line.includes("failed") && line.includes(`${failure} failure`)));
      pending.resolve();
      await flush();
      await f.typing.stop();
      const count = f.requests.length;
      t.mock.timers.tick(60_000);
      await flush();
      assert.equal(f.requests.length, count);
    });
  }
}

test("bot polls subsequent messages, sends progress independently, and cleans up on exit", { timeout: 5000 }, async (t) => {
  const controller = new AbortController();
  const first = deferred();
  const second = deferred();
  const bothReceived = deferred();
  let polls = 0;
  const f = setup(t, (endpoint, _body, opts) => {
    if (endpoint !== "getupdates") return;
    if (++polls === 1) return new Response(JSON.stringify({ ret: 0, msgs: [message("first"), message("second")] }));
    return new Promise((_, reject) => {
      opts.signal.throwIfAborted();
      opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
    });
  });
  saveWeixinAccount("typing-integration", { token: "token", userId: "user" });
  const received = [];
  const bot = start({
    async chat(request) {
      received.push(request.text);
      if (received.length === 2) bothReceived.resolve();
      return { typingUntil: received.length === 1 ? first.promise : second.promise };
    },
  }, {
    accountId: "typing-integration",
    abortSignal: controller.signal,
    quoteCache: { enabled: false },
    log: () => {},
  });
  t.after(async () => { controller.abort(); await bot.wait(); });
  await bothReceived.promise;
  await flush();
  assert.deepEqual(received, ["first", "second"]);
  assert.ok(polls >= 2);
  await bot.sendMessage("progress");
  await bot.sendMessage({ text: "part one" });
  await bot.sendMessage({ text: "part two" });
  t.mock.timers.tick(10_000);
  await flush();
  assert.deepEqual(f.statuses(), [1, 1]);
  first.resolve();
  await flush();
  assert.deepEqual(f.statuses(), [1, 1]);
  controller.abort();
  await bot.wait();
  assert.deepEqual(f.statuses(), [1, 1, 2]);
  const count = f.requests.length;
  second.reject(new Error("backend stopped"));
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(f.requests.length, count);
});
