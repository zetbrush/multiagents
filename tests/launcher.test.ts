// ============================================================================
// Tests for orchestrator/launcher.ts
// Covers: MCP injection, CLI arg building, config file generation, detection
// ============================================================================

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildCliArgs,
  mcpServerCommand,
  ensureMcpConfigs,
  detectAgent,
  buildTeamContext,
} from "../orchestrator/launcher.ts";
import { DEFAULT_BROKER_PORT } from "../shared/constants.ts";

// Temp directory for file-system tests
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join("/tmp", "launcher-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// mcpServerCommand
// ---------------------------------------------------------------------------
describe("mcpServerCommand", () => {
  test("returns bun + cli.ts path for claude", () => {
    const result = mcpServerCommand("claude");
    expect(result.command).toBe("bun");
    expect(result.args).toContain("mcp-server");
    expect(result.args).toContain("--agent-type");
    expect(result.args).toContain("claude");
    expect(result.args[0]).toEndWith("cli.ts");
  });

  test("returns bun + cli.ts path for codex", () => {
    const result = mcpServerCommand("codex");
    expect(result.command).toBe("bun");
    expect(result.args).toContain("codex");
  });

  test("returns bun + cli.ts path for gemini", () => {
    const result = mcpServerCommand("gemini");
    expect(result.command).toBe("bun");
    expect(result.args).toContain("gemini");
  });

  test("cli.ts path is absolute", () => {
    const result = mcpServerCommand("claude");
    expect(path.isAbsolute(result.args[0])).toBe(true);
  });

  test("cli.ts path points to a real file", () => {
    const result = mcpServerCommand("claude");
    expect(fs.existsSync(result.args[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildCliArgs — Claude
// ---------------------------------------------------------------------------
describe("buildCliArgs — claude", () => {
  const task = "Do something";

  test("starts with --print for headless mode", () => {
    const args = buildCliArgs("claude", task);
    expect(args[0]).toBe("--print");
  });

  test("includes --verbose (required for stream-json)", () => {
    const args = buildCliArgs("claude", task);
    expect(args).toContain("--verbose");
  });

  test("includes --output-format stream-json", () => {
    const args = buildCliArgs("claude", task);
    const idx = args.indexOf("--output-format");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("stream-json");
  });

  test("includes --max-turns 200", () => {
    const args = buildCliArgs("claude", task);
    const idx = args.indexOf("--max-turns");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("200");
  });

  test("includes --dangerously-skip-permissions", () => {
    const args = buildCliArgs("claude", task);
    expect(args).toContain("--dangerously-skip-permissions");
  });

  test("includes --mcp-config with valid JSON containing multiagents", () => {
    const args = buildCliArgs("claude", task);
    const idx = args.indexOf("--mcp-config");
    expect(idx).toBeGreaterThan(-1);

    const mcpJson = args[idx + 1];
    const parsed = JSON.parse(mcpJson);
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers["multiagents-peer"]).toBeDefined();
    expect(parsed.mcpServers["multiagents-peer"].command).toBe("bun");
    expect(parsed.mcpServers["multiagents-peer"].args).toBeArray();
    expect(parsed.mcpServers["multiagents-peer"].args).toContain("mcp-server");
  });

  test("--mcp-config JSON points to correct agent type", () => {
    const args = buildCliArgs("claude", task);
    const mcpJson = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
    expect(mcpJson.mcpServers["multiagents-peer"].args).toContain("claude");
  });

  test("ends with -p and the task", () => {
    const args = buildCliArgs("claude", task);
    const pIdx = args.lastIndexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    expect(args[pIdx + 1]).toBe(task);
  });

  test("task with special characters is preserved", () => {
    const specialTask = 'You are "Agent-A". Use \'quotes\' and $variables & pipes | etc.';
    const args = buildCliArgs("claude", specialTask);
    expect(args[args.length - 1]).toBe(specialTask);
  });
});

// ---------------------------------------------------------------------------
// buildCliArgs — Codex
// ---------------------------------------------------------------------------
describe("buildCliArgs — codex", () => {
  const task = "Do something";

  test("starts with exec subcommand", () => {
    const args = buildCliArgs("codex", task);
    expect(args[0]).toBe("exec");
  });

  test("includes --sandbox workspace-write", () => {
    const args = buildCliArgs("codex", task);
    const idx = args.indexOf("--sandbox");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("workspace-write");
  });

  test("includes --full-auto", () => {
    const args = buildCliArgs("codex", task);
    expect(args).toContain("--full-auto");
  });

  test("includes --json for structured output", () => {
    const args = buildCliArgs("codex", task);
    expect(args).toContain("--json");
  });

  test("injects multiagents MCP via dotted-path -c overrides", () => {
    const args = buildCliArgs("codex", task);
    // Find the -c flags
    const cFlags: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-c") cFlags.push(args[i + 1]);
    }

    const commandFlag = cFlags.find((f) => f.startsWith('mcp_servers."multiagents-peer".command='));
    expect(commandFlag).toBeDefined();
    expect(commandFlag).toContain('"bun"');

    const argsFlag = cFlags.find((f) => f.startsWith('mcp_servers."multiagents-peer".args='));
    expect(argsFlag).toBeDefined();
    // Should be valid JSON array
    const argsValue = argsFlag!.split("=").slice(1).join("=");
    const parsed = JSON.parse(argsValue);
    expect(parsed).toBeArray();
    expect(parsed).toContain("mcp-server");
    expect(parsed).toContain("codex");
  });

  test("does NOT touch other user MCP servers", () => {
    const args = buildCliArgs("codex", task);
    const cFlags: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-c") cFlags.push(args[i + 1]);
    }

    // Should only have multiagents and model_reasoning_effort overrides
    const nonMultiagent = cFlags.filter(
      (f) => !f.startsWith('mcp_servers."multiagents-peer".') && !f.startsWith("model_reasoning_effort")
    );
    expect(nonMultiagent).toEqual([]);
  });

  test("overrides model_reasoning_effort to high", () => {
    const args = buildCliArgs("codex", task);
    const cFlags: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-c") cFlags.push(args[i + 1]);
    }

    expect(cFlags).toContain('model_reasoning_effort="high"');
  });

  test("task is the last argument", () => {
    const args = buildCliArgs("codex", task);
    expect(args[args.length - 1]).toBe(task);
  });

  test("does NOT include --quiet (deprecated flag)", () => {
    const args = buildCliArgs("codex", task);
    expect(args).not.toContain("--quiet");
  });
});

// ---------------------------------------------------------------------------
// buildCliArgs — Gemini
// ---------------------------------------------------------------------------
describe("buildCliArgs — gemini", () => {
  const task = "Do something";

  test("starts with -y @google/gemini-cli for npx invocation", () => {
    const args = buildCliArgs("gemini", task);
    expect(args[0]).toBe("-y");
    expect(args[1]).toBe("@google/gemini-cli");
  });

  test("includes --sandbox", () => {
    const args = buildCliArgs("gemini", task);
    expect(args).toContain("--sandbox");
  });

  test("includes --approval-mode yolo for autonomous operation", () => {
    const args = buildCliArgs("gemini", task);
    const idx = args.indexOf("--approval-mode");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("yolo");
  });

  test("includes --output-format stream-json", () => {
    const args = buildCliArgs("gemini", task);
    const idx = args.indexOf("--output-format");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("stream-json");
  });

  test("restricts MCP to multiagents only via --allowed-mcp-server-names", () => {
    const args = buildCliArgs("gemini", task);
    const idx = args.indexOf("--allowed-mcp-server-names");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("multiagents-peer");
  });

  test("ends with -p and the task", () => {
    const args = buildCliArgs("gemini", task);
    const pIdx = args.lastIndexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    expect(args[pIdx + 1]).toBe(task);
  });
});

// ---------------------------------------------------------------------------
// buildCliArgs — custom
// ---------------------------------------------------------------------------
describe("buildCliArgs — custom", () => {
  test("returns only the task as single argument", () => {
    const args = buildCliArgs("custom", "my task");
    expect(args).toEqual(["my task"]);
  });
});

// ---------------------------------------------------------------------------
// ensureMcpConfigs — .mcp.json (Claude)
// ---------------------------------------------------------------------------
describe("ensureMcpConfigs — Claude .mcp.json", () => {
  test("creates .mcp.json with multiagents entry in empty directory", async () => {
    await ensureMcpConfigs(tmpDir, "test-session");

    const mcpPath = path.join(tmpDir, ".mcp.json");
    expect(fs.existsSync(mcpPath)).toBe(true);

    const config = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers["multiagents-peer"]).toBeDefined();
    expect(config.mcpServers["multiagents-peer"].command).toBe("bun");
    expect(config.mcpServers["multiagents-peer"].args).toContain("mcp-server");
  });

  test("preserves existing mcpServers entries", async () => {
    // Write pre-existing config
    const mcpPath = path.join(tmpDir, ".mcp.json");
    const existing = {
      mcpServers: {
        "my-custom-server": { command: "node", args: ["server.js"] },
      },
    };
    fs.writeFileSync(mcpPath, JSON.stringify(existing));

    await ensureMcpConfigs(tmpDir, "test-session");

    const config = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
    expect(config.mcpServers["my-custom-server"]).toBeDefined();
    expect(config.mcpServers["my-custom-server"].command).toBe("node");
    expect(config.mcpServers["multiagents-peer"]).toBeDefined();
  });

  test("overwrites stale multiagents entry with fresh config", async () => {
    const mcpPath = path.join(tmpDir, ".mcp.json");
    const stale = {
      mcpServers: {
        "multiagents": { command: "old", args: ["stale"] },
      },
    };
    fs.writeFileSync(mcpPath, JSON.stringify(stale));

    await ensureMcpConfigs(tmpDir, "test-session");

    const config = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
    // Old "multiagents" entry should be removed, replaced by "multiagents-peer"
    expect(config.mcpServers["multiagents"]).toBeUndefined();
    expect(config.mcpServers["multiagents-peer"].command).toBe("bun");
    expect(config.mcpServers["multiagents-peer"].args).not.toContain("stale");
  });
});

// ---------------------------------------------------------------------------
// ensureMcpConfigs — .codex/config.toml (Codex)
// ---------------------------------------------------------------------------
describe("ensureMcpConfigs — Codex .codex/config.toml", () => {
  test("creates .codex/config.toml with multiagents section", async () => {
    await ensureMcpConfigs(tmpDir, "test-session");

    const tomlPath = path.join(tmpDir, ".codex", "config.toml");
    expect(fs.existsSync(tomlPath)).toBe(true);

    const content = fs.readFileSync(tomlPath, "utf-8");
    expect(content).toContain('[mcp_servers."multiagents-peer"]');
    expect(content).toContain('command = "bun"');
    expect(content).toContain("mcp-server");
    expect(content).toContain("codex");
  });

  test("does not duplicate multiagents-peer if already present", async () => {
    // Run twice
    await ensureMcpConfigs(tmpDir, "test-session");
    await ensureMcpConfigs(tmpDir, "test-session");

    const content = fs.readFileSync(path.join(tmpDir, ".codex", "config.toml"), "utf-8");
    const matches = content.match(/multiagents-peer/g);
    expect(matches!.length).toBeGreaterThanOrEqual(1);
    // Should only have ONE section header
    const sections = content.match(/\[mcp_servers\."multiagents-peer"\]/g);
    expect(sections).toHaveLength(1);
  });

  test("preserves existing codex config content", async () => {
    const codexDir = path.join(tmpDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, "config.toml"),
      'model = "gpt-5.4"\nmodel_reasoning_effort = "high"\n',
    );

    await ensureMcpConfigs(tmpDir, "test-session");

    const content = fs.readFileSync(path.join(codexDir, "config.toml"), "utf-8");
    expect(content).toContain('model = "gpt-5.4"');
    expect(content).toContain('[mcp_servers."multiagents-peer"]');
  });
});

// ---------------------------------------------------------------------------
// ensureMcpConfigs — .multiagents/session.json
// ---------------------------------------------------------------------------
describe("ensureMcpConfigs — session file", () => {
  test("creates .multiagents/session.json with correct session ID", async () => {
    await ensureMcpConfigs(tmpDir, "my-session-42");

    const sessionPath = path.join(tmpDir, ".multiagents", "session.json");
    expect(fs.existsSync(sessionPath)).toBe(true);

    const session = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    expect(session.session_id).toBe("my-session-42");
  });

  test("session file contains correct broker port from constants", async () => {
    await ensureMcpConfigs(tmpDir, "test-session");

    const session = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".multiagents", "session.json"), "utf-8"),
    );
    expect(session.broker_port).toBe(DEFAULT_BROKER_PORT);
  });

  test("session file contains created_at ISO timestamp", async () => {
    await ensureMcpConfigs(tmpDir, "test-session");

    const session = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".multiagents", "session.json"), "utf-8"),
    );
    expect(session.created_at).toBeDefined();
    // Should be a valid ISO date
    expect(new Date(session.created_at).toISOString()).toBe(session.created_at);
  });

  test("updates session ID when called with different session", async () => {
    await ensureMcpConfigs(tmpDir, "session-1");
    await ensureMcpConfigs(tmpDir, "session-2");

    const session = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".multiagents", "session.json"), "utf-8"),
    );
    expect(session.session_id).toBe("session-2");
  });
});

// ---------------------------------------------------------------------------
// ensureMcpConfigs — idempotency & all files together
// ---------------------------------------------------------------------------
describe("ensureMcpConfigs — full run", () => {
  test("creates all expected files in one call", async () => {
    await ensureMcpConfigs(tmpDir, "full-test");

    expect(fs.existsSync(path.join(tmpDir, ".mcp.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".codex", "config.toml"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".multiagents", "session.json"))).toBe(true);
  });

  test("is idempotent — running twice produces same result", async () => {
    await ensureMcpConfigs(tmpDir, "idem-test");

    const mcpBefore = fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8");
    const codexBefore = fs.readFileSync(path.join(tmpDir, ".codex", "config.toml"), "utf-8");

    await ensureMcpConfigs(tmpDir, "idem-test");

    const mcpAfter = fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8");
    const codexAfter = fs.readFileSync(path.join(tmpDir, ".codex", "config.toml"), "utf-8");

    expect(mcpAfter).toBe(mcpBefore);
    expect(codexAfter).toBe(codexBefore);
  });
});

// ---------------------------------------------------------------------------
// detectAgent
// ---------------------------------------------------------------------------
describe("detectAgent", () => {
  test("detects claude if installed", async () => {
    const result = await detectAgent("claude");
    // Skip assertion if CLI not in PATH (CI environments)
    if (result.available) {
      expect(result.path).toBeDefined();
    }
  });

  test("detects codex if installed", async () => {
    const result = await detectAgent("codex");
    if (result.available) {
      expect(result.path).toBeDefined();
    }
  });

  test("returns available: false for custom type", async () => {
    const result = await detectAgent("custom");
    expect(result.available).toBe(false);
  });

  test("returns version string when available", async () => {
    const result = await detectAgent("claude");
    if (result.available) {
      expect(typeof result.version).toBe("string");
      expect(result.version!.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-agent MCP config consistency
// ---------------------------------------------------------------------------
describe("MCP config consistency across agent types", () => {
  test("all agent types reference the same cli.ts path", () => {
    const claudeMcp = mcpServerCommand("claude");
    const codexMcp = mcpServerCommand("codex");
    const geminiMcp = mcpServerCommand("gemini");

    expect(claudeMcp.args[0]).toBe(codexMcp.args[0]);
    expect(codexMcp.args[0]).toBe(geminiMcp.args[0]);
  });

  test("all agent types use bun as the MCP server command", () => {
    expect(mcpServerCommand("claude").command).toBe("bun");
    expect(mcpServerCommand("codex").command).toBe("bun");
    expect(mcpServerCommand("gemini").command).toBe("bun");
  });

  test("each agent type gets its own --agent-type flag value", () => {
    const claudeArgs = mcpServerCommand("claude").args;
    const codexArgs = mcpServerCommand("codex").args;
    const geminiArgs = mcpServerCommand("gemini").args;

    const getAgentType = (args: string[]) => args[args.indexOf("--agent-type") + 1];

    expect(getAgentType(claudeArgs)).toBe("claude");
    expect(getAgentType(codexArgs)).toBe("codex");
    expect(getAgentType(geminiArgs)).toBe("gemini");
  });

  test("claude --mcp-config JSON and codex -c args reference same MCP server binary", () => {
    const claudeCliArgs = buildCliArgs("claude", "test");
    const codexCliArgs = buildCliArgs("codex", "test");

    // Extract Claude's MCP config
    const claudeMcpJson = JSON.parse(
      claudeCliArgs[claudeCliArgs.indexOf("--mcp-config") + 1],
    );
    const claudeMcpArgs = claudeMcpJson.mcpServers["multiagents-peer"].args;

    // Extract Codex's MCP args from -c flag
    const cFlags: string[] = [];
    for (let i = 0; i < codexCliArgs.length; i++) {
      if (codexCliArgs[i] === "-c") cFlags.push(codexCliArgs[i + 1]);
    }
    const codexArgsFlag = cFlags.find((f) => f.startsWith('mcp_servers."multiagents-peer".args='))!;
    const codexMcpArgs = JSON.parse(codexArgsFlag.split("=").slice(1).join("="));

    // Both should reference the same cli.ts path
    expect(claudeMcpArgs[0]).toBe(codexMcpArgs[0]);
  });
});

// ---------------------------------------------------------------------------
// buildTeamContext
// ---------------------------------------------------------------------------
describe("buildTeamContext", () => {
  test("returns first-agent message when no teammates", async () => {
    const mockClient = {
      listSlots: async () => [],
    } as any;

    const result = await buildTeamContext("session-1", 1, mockClient);
    expect(result).toContain("first agent");
    expect(result).toContain("No other agents");
  });

  test("lists connected teammates excluding self", async () => {
    const mockClient = {
      listSlots: async () => [
        { id: 1, display_name: "Self", agent_type: "claude", role: "engineer", status: "connected", paused: false },
        { id: 2, display_name: "Peer-A", agent_type: "codex", role: "reviewer", status: "connected", paused: false },
        { id: 3, display_name: "Peer-B", agent_type: "gemini", role: "tester", status: "disconnected", paused: false },
      ],
    } as any;

    const result = await buildTeamContext("session-1", 1, mockClient);
    expect(result).toContain("Peer-A");
    expect(result).toContain("codex");
    expect(result).toContain("reviewer");
    expect(result).not.toContain("Self");
    // Disconnected peers should not appear
    expect(result).not.toContain("Peer-B");
  });

  test("shows paused status for paused teammates", async () => {
    const mockClient = {
      listSlots: async () => [
        { id: 1, display_name: "Self", status: "connected" },
        { id: 2, display_name: "Paused-Agent", agent_type: "claude", role: "dev", status: "connected", paused: true },
      ],
    } as any;

    const result = await buildTeamContext("session-1", 1, mockClient);
    expect(result).toContain("paused");
  });
});
