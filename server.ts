#!/usr/bin/env bun
/**
 * multiagents MCP server — thin dispatcher
 *
 * Parses --agent-type from argv and delegates to the appropriate adapter.
 *
 * Usage:
 *   bun server.ts                    # defaults to claude
 *   bun server.ts --agent-type codex
 *   bun server.ts --agent-type gemini
 *   bun server.ts --agent-type kimi
 *   bun server.ts --agent-type copilot
 *   bun server.ts --agent-type qwen
 *   bun server.ts --agent-type jinn
 */

import type { AgentType } from "./shared/types.ts";

const typeFlag = process.argv.indexOf("--agent-type");
const agentType: AgentType =
  typeFlag !== -1 && process.argv[typeFlag + 1]
    ? (process.argv[typeFlag + 1] as AgentType)
    : "claude";

async function main() {
  switch (agentType) {
    case "claude": {
      const { ClaudeAdapter } = await import("./adapters/claude-adapter.ts");
      await new ClaudeAdapter().start();
      break;
    }
    case "codex": {
      const { CodexAdapter } = await import("./adapters/codex-adapter.ts");
      await new CodexAdapter().start();
      break;
    }
    case "gemini": {
      const { GeminiAdapter } = await import("./adapters/gemini-adapter.ts");
      await new GeminiAdapter().start();
      break;
    }
    case "kimi": {
      const { KimiAdapter } = await import("./adapters/kimi-adapter.ts");
      await new KimiAdapter().start();
      break;
    }
    case "copilot": {
      const { CopilotAdapter } = await import("./adapters/copilot-adapter.ts");
      await new CopilotAdapter().start();
      break;
    }
    case "qwen": {
      const { QwenAdapter } = await import("./adapters/qwen-adapter.ts");
      await new QwenAdapter().start();
      break;
    }
    case "jinn": {
      const { JinnAdapter } = await import("./adapters/jinn-adapter.ts");
      await new JinnAdapter().start();
      break;
    }
    default: {
      // For 'custom' or unknown types, fall back to Claude adapter behavior
      const { ClaudeAdapter } = await import("./adapters/claude-adapter.ts");
      await new ClaudeAdapter().start();
      break;
    }
  }
}

main().catch((e) => {
  console.error(`[multiagents] Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
