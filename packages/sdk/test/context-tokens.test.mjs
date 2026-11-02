import { stateDir } from "./test-state.mjs";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getContextToken,
  setContextToken,
  clearContextTokensForAccount,
} from "../.test-dist/src/messaging/context-tokens.js";

test("context tokens survive process restarts and account deletion clears disk and memory", () => {
  setContextToken("persisted-account", "user", "test-context");
  const file = path.join(
    stateDir,
    "openclaw-weixin/accounts/persisted-account.context-tokens.json",
  );
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const script = `import {getContextToken} from './.test-dist/src/messaging/context-tokens.js'; process.stdout.write(getContextToken('persisted-account','user'));`;
  assert.equal(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    }),
    "test-context",
  );
  assert.equal(getContextToken("another-account", "user"), undefined);
  clearContextTokensForAccount("persisted-account");
  assert.equal(getContextToken("persisted-account", "user"), undefined);
  assert.equal(fs.existsSync(file), false);
});

test("corrupt context cache does not prevent receipt of a fresh token", () => {
  const file = path.join(
    stateDir,
    "openclaw-weixin/accounts/corrupt.context-tokens.json",
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "invalid json");
  assert.equal(getContextToken("corrupt", "user"), undefined);
  setContextToken("corrupt", "user", "fresh-test-context");
  assert.equal(getContextToken("corrupt", "user"), "fresh-test-context");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    user: "fresh-test-context",
  });
});
