import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const stateDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "weixin-sdk-test-"),
);
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG = path.join(stateDir, "openclaw.json");
process.env.OPENCLAW_LOG_LEVEL = "FATAL";
process.on("exit", () => fs.rmSync(stateDir, { recursive: true, force: true }));
