#!/usr/bin/env node

/**
 * WeChat + OpenAI example.
 *
 * Usage:
 *   npx tsx main.ts login              # QR-code login
 *   npx tsx main.ts start              # Start bot
 *
 * Environment variables:
 *   OPENAI_API_KEY      — Required
 *   OPENAI_BASE_URL     — Optional: custom API base URL
 *   OPENAI_MODEL        — Optional: model name (default: gpt-5.4)
 *   SYSTEM_PROMPT       — Optional: system prompt for the agent
 */

import { login, start } from "weixin-agent-sdk";

import { OpenAIAgent } from "./src/openai-agent.js";

const command = process.argv[2];

async function main() {
  switch (command) {
    case "login": {
      await login();
      break;
    }

    case "start": {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        console.error("错误: 请设置 OPENAI_API_KEY 环境变量");
        process.exit(1);
      }

      const agent = new OpenAIAgent({
        apiKey,
        baseURL: process.env.OPENAI_BASE_URL,
        model: process.env.OPENAI_MODEL,
        systemPrompt: process.env.SYSTEM_PROMPT,
      });

      // Graceful shutdown
      const ac = new AbortController();
      process.on("SIGINT", () => {
        console.log("\n正在停止...");
        ac.abort();
      });
      process.on("SIGTERM", () => ac.abort());

      const bot = start(agent, { abortSignal: ac.signal });
      await bot.promise;
      break;
    }

    default:
      console.log(`weixin-agent-openai — 微信 + OpenAI 示例

用法:
  npx tsx main.ts login    扫码登录微信
  npx tsx main.ts start    启动 bot

环境变量:
  OPENAI_API_KEY           OpenAI API Key (必填)
  OPENAI_BASE_URL          自定义 API 地址
  OPENAI_MODEL             模型名称 (默认 gpt-5.4)
  SYSTEM_PROMPT            系统提示词`);
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
