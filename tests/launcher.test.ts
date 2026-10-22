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
  claudeMcpConfig,
  claudeSystemPromptAppend,
  codexDeveloperInstructions,
} from "../orchestrator/launcher.ts";
import { DEFAULT_BROKER_PORT } from "../shared/constants.ts";
import { FULL_PROTOCOL, SHORT_PROTOCOL } from "../adapters/protocol-text.ts";

// Temp directory for file-system tests
let tmpDir: string;

function expectDefined<T>(value: T | undefined, message: string): T {
  expect(value).toBeDefined();
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function getFlagValue(args: string[], flag: string): string {
  const idx = args.indexOf(flag);
  expect(idx).toBeGreaterThan(-1);
  return expectDefined(args[idx + 1], `Missing value for ${flag}`);
}

function collectFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) continue;
    const value = args[i + 1];
    if (value !== undefined) {
      values.push(value);
    }
  }
  return values;
}

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
    expect(path.isAbsolute(expectDefined(result.args[0], "Missing cli.ts path"))).toBe(true);
  });

  test("cli.ts path points to a real file", () => {
    const result = mcpServerCommand("claude");
    expect(fs.existsSync(expectDefined(result.args[0], "Missing cli.ts path"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Claude — driver launch contract
// ---------------------------------------------------------------------------
describe("claudeMcpConfig", () => {
  const identity = { sessionId: "sess-1", projectDir: "/tmp/p", slotId: 7, name: "Alice", role: "Software Engineer", roleDescription: "builds things" };

  test("points at the per-agent MCP server with slot identity baked into the args", () => {
    const cfg = claudeMcpConfig(identity, { driverMode: true }) as any;
    const server = cfg.mcpServers["multiagents-peer"];
    expect(server.command).toBe("bun");
    expect(server.args).toContain("mcp-server");
    expect(getFlagValue(server.args, "--agent-type")).toBe("claude");
    expect(getFlagValue(server.args, "--session")).toBe("sess-1");
    expect(getFlagValue(server.args, "--slot")).toBe("7");
    expect(getFlagValue(server.args, "--role")).toBe("Software Engineer");
    expect(getFlagValue(server.args, "--name")).toBe("Alice");
  });

  test("keeps the team tools out of tool-search deferral", () => {
    const cfg = claudeMcpConfig(identity, { driverMode: true }) as any;
    expect(cfg.mcpServers["multiagents-peer"].alwaysLoad).toBe(true);
  });

  test("forwards a non-default broker port to the adapter through args and env", () => {
    const previous = process.env.MULTIAGENTS_PORT;
    process.env.MULTIAGENTS_PORT = "17999";
    try {
      const server = (claudeMcpConfig(identity, { driverMode: true }) as any).mcpServers["multiagents-peer"];
      expect(getFlagValue(server.args, "--port")).toBe("17999");
      expect(server.env).toEqual({ MULTIAGENTS_PORT: "17999" });
    } finally {
      if (previous === undefined) delete process.env.MULTIAGENTS_PORT; else process.env.MULTIAGENTS_PORT = previous;
    }
  });

  test("omits the port when the broker runs on the default port", () => {
    const previous = process.env.MULTIAGENTS_PORT;
    delete process.env.MULTIAGENTS_PORT;
    try {
      const server = (claudeMcpConfig(identity, { driverMode: true }) as any).mcpServers["multiagents-peer"];
      expect(server.args).not.toContain("--port");
      expect(server.env).toBeUndefined();
    } finally {
      if (previous !== undefined) process.env.MULTIAGENTS_PORT = previous;
    }
  });

  test("marks the adapter as driver-managed only when a driver owns delivery", () => {
    const driven = claudeMcpConfig(identity, { driverMode: true }) as any;
    expect(driven.mcpServers["multiagents-peer"].args).toContain("--driver-mode");
    const standalone = claudeMcpConfig(identity, { driverMode: false }) as any;
    expect(standalone.mcpServers["multiagents-peer"].args).not.toContain("--driver-mode");
  });
});

describe("claudeSystemPromptAppend", () => {
  test("carries the full protocol and the role practices (which MCP instructions cannot fit)", () => {
    const text = claudeSystemPromptAppend("QA Engineer", "tests web apps");
    expect(text).toContain(FULL_PROTOCOL.trim().slice(0, 40));
    expect(text).toContain("ROLE-SPECIFIC PRACTICES");
    expect(text).toContain("COMPLETION CRITERIA");
  });
});

describe("codexDeveloperInstructions", () => {
  test("names the agent, its tools and the short protocol", () => {
    const text = codexDeveloperInstructions({ sessionId: "s", projectDir: "/tmp/p", slotId: 1, name: "Bob", role: "Code Reviewer", roleDescription: "reviews" });
    expect(text).toContain('You are "Bob", role: Code Reviewer.');
    expect(text).toContain("signal_done");
    expect(text).toContain(SHORT_PROTOCOL.trim().slice(0, 30));
    expect(text).not.toContain(FULL_PROTOCOL.trim().slice(0, 40));
  });
});

// ---------------------------------------------------------------------------
// buildCliArgs — driver-managed types are rejected
// ---------------------------------------------------------------------------
describe("buildCliArgs — claude and codex", () => {
  test("claude is driven over stream-json, not launched with CLI args", () => {
    expect(() => buildCliArgs("claude", "task")).toThrow(/session protocol/);
  });

  test("codex is driven over app-server, not `codex exec` (whose --full-auto flag no longer exists)", () => {
    expect(() => buildCliArgs("codex", "task")).toThrow(/session protocol/);
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
    expect(getFlagValue(args, "--approval-mode")).toBe("yolo");
  });

  test("includes --output-format stream-json", () => {
    const args = buildCliArgs("gemini", task);
    expect(getFlagValue(args, "--output-format")).toBe("stream-json");
  });

  test("restricts MCP to multiagents only via --allowed-mcp-server-names", () => {
    const args = buildCliArgs("gemini", task);
    expect(getFlagValue(args, "--allowed-mcp-server-names")).toBe("multiagents-peer");
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
// ensureMcpConfigs — ~/.codex/config.toml (GLOBAL Codex config)
// ---------------------------------------------------------------------------
describe("ensureMcpConfigs — Codex ~/.codex/config.toml (global)", () => {
  // These tests read the GLOBAL ~/.codex/config.toml because Codex CLI
  // only loads MCP servers from the global config. Project-level is ignored.
  const globalCodexPath = path.join(process.env.HOME ?? "", ".codex", "config.toml");
  let originalContent: string | null = null;

  // Save and restore global config around each test
  beforeEach(() => {
    try { originalContent = fs.readFileSync(globalCodexPath, "utf-8"); } catch { originalContent = null; }
  });
  afterEach(() => {
    if (originalContent !== null) {
      fs.writeFileSync(globalCodexPath, originalContent);
    }
  });

  test("writes multiagents-peer to global ~/.codex/config.toml", async () => {
    await ensureMcpConfigs(tmpDir, "test-session");

    expect(fs.existsSync(globalCodexPath)).toBe(true);
    const content = fs.readFileSync(globalCodexPath, "utf-8");
    expect(content).toContain('[mcp_servers."multiagents-peer"]');
    expect(content).toContain('command = "bun"');
    expect(content).toContain("mcp-server");
    expect(content).toContain("codex");
  });

  test("auto-approves every team tool for the Codex agent (approval_policy=never would deny them otherwise)", async () => {
    await ensureMcpConfigs(tmpDir, "test-session", "codex");

    const content = fs.readFileSync(globalCodexPath, "utf-8");
    const section = content.slice(content.indexOf('[mcp_servers."multiagents-peer"]'));
    const body = section.split("\n[")[0];
    expect(body).toContain('default_tools_approval_mode = "approve"');
  });

  test("does not duplicate multiagents-peer if already present", async () => {
    await ensureMcpConfigs(tmpDir, "test-session");
    await ensureMcpConfigs(tmpDir, "test-session");

    const content = fs.readFileSync(globalCodexPath, "utf-8");
    const sections = content.match(/\[mcp_servers\."multiagents-peer"\]/g);
    expect(sections).toHaveLength(1);
  });

  test("preserves existing codex config content", async () => {
    // The global config already has content — verify it's preserved
    await ensureMcpConfigs(tmpDir, "test-session");

    const content = fs.readFileSync(globalCodexPath, "utf-8");
    expect(content).toContain('[mcp_servers."multiagents-peer"]');
    // Should still have other existing sections (figma, features, etc.)
    if (originalContent?.includes("[mcp_servers.figma]")) {
      expect(content).toContain("[mcp_servers.figma]");
    }
  });
});

// ---------------------------------------------------------------------------
// ensureMcpConfigs — scoped by agent type
// ---------------------------------------------------------------------------
describe("ensureMcpConfigs — scoped to the launched agent type", () => {
  const globalCodexPath = path.join(process.env.HOME ?? "", ".codex", "config.toml");
  const globalGeminiPath = path.join(process.env.HOME ?? "", ".gemini", "settings.json");
  let origCodex: string | null = null;
  let origGemini: string | null = null;
  beforeEach(() => {
    try { origCodex = fs.readFileSync(globalCodexPath, "utf-8"); } catch { origCodex = null; }
    try { origGemini = fs.readFileSync(globalGeminiPath, "utf-8"); } catch { origGemini = null; }
  });
  afterEach(() => {
    if (origCodex !== null) fs.writeFileSync(globalCodexPath, origCodex);
    if (origGemini !== null) fs.writeFileSync(globalGeminiPath, origGemini);
  });

  test("launching a Claude agent writes the project .mcp.json but leaves the global Codex and Gemini configs alone", async () => {
    // beforeEach saved the originals and afterEach restores them.
    fs.rmSync(globalCodexPath, { force: true });
    fs.rmSync(globalGeminiPath, { force: true });

    await ensureMcpConfigs(tmpDir, "claude-only", "claude");

    expect(fs.existsSync(path.join(tmpDir, ".mcp.json"))).toBe(true);
    expect(fs.existsSync(globalCodexPath)).toBe(false);
    expect(fs.existsSync(globalGeminiPath)).toBe(false);
  });

  test("launching a Codex agent writes the global Codex config", async () => {
    await ensureMcpConfigs(tmpDir, "codex-only", "codex");
    expect(fs.readFileSync(globalCodexPath, "utf-8")).toContain('[mcp_servers."multiagents-peer"]');
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

  test("session file records the broker port in effect", async () => {
    const previous = process.env.MULTIAGENTS_PORT;
    process.env.MULTIAGENTS_PORT = "17999";
    try {
      await ensureMcpConfigs(tmpDir, "test-session");
    } finally {
      if (previous === undefined) delete process.env.MULTIAGENTS_PORT; else process.env.MULTIAGENTS_PORT = previous;
    }
    const session = JSON.parse(fs.readFileSync(path.join(tmpDir, ".multiagents", "session.json"), "utf-8"));
    expect(session.broker_port).toBe(17999);
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
  // Save/restore global codex config
  const globalCodexPath = path.join(process.env.HOME ?? "", ".codex", "config.toml");
  let origCodex: string | null = null;
  beforeEach(() => { try { origCodex = fs.readFileSync(globalCodexPath, "utf-8"); } catch { origCodex = null; } });
  afterEach(() => { if (origCodex !== null) fs.writeFileSync(globalCodexPath, origCodex); });

  test("creates all expected files in one call", async () => {
    await ensureMcpConfigs(tmpDir, "full-test");

    expect(fs.existsSync(path.join(tmpDir, ".mcp.json"))).toBe(true);
    // Codex config is written to GLOBAL ~/.codex/config.toml, not project-level
    expect(fs.existsSync(globalCodexPath)).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".multiagents", "session.json"))).toBe(true);
  });

  test("is idempotent — running twice produces same result", async () => {
    await ensureMcpConfigs(tmpDir, "idem-test");

    const mcpBefore = fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8");
    const codexBefore = fs.readFileSync(globalCodexPath, "utf-8");

    await ensureMcpConfigs(tmpDir, "idem-test");

    const mcpAfter = fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8");
    const codexAfter = fs.readFileSync(globalCodexPath, "utf-8");

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

  test("a command override is what has to exist, not the real CLI", async () => {
    const saved = process.env.MULTIAGENTS_CLAUDE_COMMAND;
    try {
      process.env.MULTIAGENTS_CLAUDE_COMMAND = "bun tests/fakes/fake-claude.ts";
      const found = await detectAgent("claude");
      expect(found.available).toBe(true);
      expect(found.path).toMatch(/bun$/);
      process.env.MULTIAGENTS_CLAUDE_COMMAND = "definitely-not-a-binary --flag";
      expect((await detectAgent("claude")).available).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.MULTIAGENTS_CLAUDE_COMMAND;
      else process.env.MULTIAGENTS_CLAUDE_COMMAND = saved;
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

    const getAgentType = (args: string[]) => getFlagValue(args, "--agent-type");

    expect(getAgentType(claudeArgs)).toBe("claude");
    expect(getAgentType(codexArgs)).toBe("codex");
    expect(getAgentType(geminiArgs)).toBe("gemini");
  });

  test("claude inline MCP config and codex mcpServerCommand reference the same binary", () => {
    const cfg = claudeMcpConfig({ sessionId: "s", projectDir: "/tmp/p", slotId: 1, name: "A", role: "r", roleDescription: "" }, { driverMode: true }) as any;
    const claudeMcpArgs = cfg.mcpServers["multiagents-peer"].args;

    // Codex no longer injects MCP via -c flags (Codex CLI ignores them).
    // Instead, mcpServerCommand("codex") returns the same binary path that
    // ensureMcpConfigs writes to ~/.codex/config.toml. Verify consistency.
    const codexMcp = mcpServerCommand("codex");

    // Both should reference the same cli.ts path
    expect(claudeMcpArgs[0]).toBe(codexMcp.args[0]);
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
