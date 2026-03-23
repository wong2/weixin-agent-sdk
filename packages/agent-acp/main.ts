#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

/**
 * WeChat + ACP (Agent Client Protocol) adapter.
 *
 * Usage:
 *   npx weixin-acp login                          # QR-code login
 *   npx weixin-acp start --router-config file.json # Start bot with multi-backend router
 *   npx weixin-acp start -- <command> [args...]    # Start bot
 *
 * Examples:
 *   npx weixin-acp start -- codex-acp
 *   npx weixin-acp start -- node ./my-agent.js
 */

import { login, start } from "weixin-agent-sdk";

import { AcpAgent } from "./src/acp-agent.js";
import type { AcpRouterConfig } from "./src/types.js";

const command = process.argv[2];

function resolveRouterConfigPath(input: string): string {
  return path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
}

function loadRouterConfig(configPath: string): AcpRouterConfig {
  const resolvedPath = resolveRouterConfigPath(configPath);
  const raw = fs.readFileSync(resolvedPath, "utf8");
  const parsed = JSON.parse(raw) as AcpRouterConfig;
  if (!parsed.defaultBackend?.trim()) {
    throw new Error("router config 缺少 defaultBackend");
  }
  if (!parsed.backends || Object.keys(parsed.backends).length === 0) {
    throw new Error("router config 缺少 backends");
  }
  return parsed;
}

async function main() {
  switch (command) {
    case "login": {
      await login();
      break;
    }

    case "start": {
      const routerArgIndex = process.argv.indexOf("--router-config");
      if (routerArgIndex !== -1) {
        const configPath = process.argv[routerArgIndex + 1];
        if (!configPath) {
          console.error("错误: --router-config 后必须跟 JSON 文件路径");
          process.exit(1);
        }

        const agent = new AcpAgent({
          command: "",
          router: loadRouterConfig(configPath),
        });

        const ac = new AbortController();
        process.on("SIGINT", () => {
          console.log("\n正在停止...");
          agent.dispose();
          ac.abort();
        });
        process.on("SIGTERM", () => {
          agent.dispose();
          ac.abort();
        });

        await start(agent, { abortSignal: ac.signal });
        break;
      }

      const ddIndex = process.argv.indexOf("--");
      if (ddIndex === -1 || ddIndex + 1 >= process.argv.length) {
        console.error("错误: 请在 -- 后指定 ACP agent 启动命令");
        console.error("示例: npx weixin-acp start -- codex-acp");
        console.error("或:   npx weixin-acp start --router-config ./router.json");
        process.exit(1);
      }

      const [acpCommand, ...acpArgs] = process.argv.slice(ddIndex + 1);

      const agent = new AcpAgent({
        command: acpCommand,
        args: acpArgs,
      });

      // Graceful shutdown
      const ac = new AbortController();
      process.on("SIGINT", () => {
        console.log("\n正在停止...");
        agent.dispose();
        ac.abort();
      });
      process.on("SIGTERM", () => {
        agent.dispose();
        ac.abort();
      });

      await start(agent, { abortSignal: ac.signal });
      break;
    }

    default:
      console.log(`weixin-acp — 微信 + ACP 适配器

用法:
  npx weixin-acp login                          扫码登录微信
  npx weixin-acp start --router-config file.json 启动多后端路由
  npx weixin-acp start -- <command> [args...]    启动 bot

示例:
  npx weixin-acp start --router-config ./router.json
  npx weixin-acp start -- codex-acp
  npx weixin-acp start -- node ./my-agent.js`);
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
