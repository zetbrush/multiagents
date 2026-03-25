#!/usr/bin/env bun
/**
 * multiagents install-mcp — Configure MCP servers globally for all detected agent CLIs.
 *
 * Claude Code: `claude mcp add -s user` → writes to ~/.claude.json
 *   Docs: https://docs.anthropic.com/en/docs/claude-code
 *
 * Codex CLI: `codex mcp add` → writes to ~/.codex/config.toml
 *   Docs: https://developers.openai.com/codex/mcp
 *
 * Gemini CLI: Direct write to ~/.gemini/settings.json (no CLI command for mcp add)
 *   Docs: https://geminicli.com/docs/tools/mcp-server/
 *
 * Each agent has its own config format and location. This script handles all three.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const HOME = os.homedir();

// --- Binary resolution ---

function findBinary(name: string): string {
  try {
    const which = Bun.spawnSync(["which", name]);
    const found = new TextDecoder().decode(which.stdout).trim();
    if (found) return found;
  } catch { /* ok */ }

  const candidates = [
    path.join(HOME, ".bun", "bin", name),
    path.join(HOME, ".local", "bin", name),
    path.join(HOME, ".npm-global", "bin", name),
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return name;
}

function findAgentCli(name: string): string | null {
  // Check `which` first
  try {
    const which = Bun.spawnSync(["which", name]);
    if (which.exitCode === 0) return new TextDecoder().decode(which.stdout).trim();
  } catch { /* ok */ }

  // Known install locations
  const knownPaths: Record<string, string[]> = {
    claude: [
      path.join(HOME, ".local", "bin", "claude"),
      path.join(HOME, ".claude", "bin", "claude"),
      "/usr/local/bin/claude",
      "/opt/homebrew/bin/claude",
    ],
    codex: [
      path.join(HOME, ".local", "bin", "codex"),
      path.join(HOME, ".npm-global", "bin", "codex"),
      "/usr/local/bin/codex",
      "/opt/homebrew/bin/codex",
    ],
    gemini: [
      path.join(HOME, ".local", "bin", "gemini"),
      path.join(HOME, ".npm-global", "bin", "gemini"),
      "/usr/local/bin/gemini",
      "/opt/homebrew/bin/gemini",
    ],
  };

  for (const p of (knownPaths[name] ?? [])) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// --- Claude Code ---
// Uses: `claude mcp add <name> -s user -- <command>`
// Writes to: ~/.claude.json → mcpServers
// Docs: https://docs.anthropic.com/en/docs/claude-code

function configureClaude(serverBin: string, orchBin: string): string[] {
  const logs: string[] = [];
  const claudePath = findAgentCli("claude");

  if (claudePath) {
    // Use the official CLI (preferred)
    // Remove first to avoid duplicates
    Bun.spawnSync([claudePath, "mcp", "remove", "multiagents", "-s", "user"], { stderr: "ignore", stdout: "ignore" });
    Bun.spawnSync([claudePath, "mcp", "remove", "multiagents-orch", "-s", "user"], { stderr: "ignore", stdout: "ignore" });

    const r1 = Bun.spawnSync([claudePath, "mcp", "add", "multiagents", "-s", "user", "--", serverBin]);
    const r2 = Bun.spawnSync([claudePath, "mcp", "add", "multiagents-orch", "-s", "user", "--", orchBin]);

    if (r1.exitCode === 0 && r2.exitCode === 0) {
      logs.push("  \x1b[32m✔\x1b[0m Claude Code: MCP servers added (via claude mcp add -s user)");
      return logs;
    }
    logs.push("  \x1b[33m!\x1b[0m Claude Code: CLI method failed, falling back to file config");
  }

  // Fallback: write directly to ~/.claude.json
  const configPath = path.join(HOME, ".claude.json");
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try { config = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch { config = {}; }
  }

  const mcpServers = (config.mcpServers as Record<string, unknown>) ?? {};
  mcpServers["multiagents"] = { type: "stdio", command: serverBin, args: [], env: {} };
  mcpServers["multiagents-orch"] = { type: "stdio", command: orchBin, args: [], env: {} };
  config.mcpServers = mcpServers;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  logs.push("  \x1b[32m✔\x1b[0m Claude Code: MCP servers written to ~/.claude.json");
  return logs;
}

// --- Codex CLI ---
// Uses: `codex mcp add <name> -- <command> <args...>`
// Writes to: ~/.codex/config.toml → [mcp_servers.<name>]
// Docs: https://developers.openai.com/codex/mcp

function configureCodex(serverBin: string): string[] {
  const logs: string[] = [];
  const codexPath = findAgentCli("codex");

  if (codexPath) {
    // Use the official CLI (preferred)
    // Remove first to avoid duplicates
    Bun.spawnSync([codexPath, "mcp", "remove", "multiagents"], { stderr: "ignore", stdout: "ignore" });

    const r1 = Bun.spawnSync([codexPath, "mcp", "add", "multiagents", "--", serverBin, "--agent-type", "codex"]);
    if (r1.exitCode === 0) {
      logs.push("  \x1b[32m✔\x1b[0m Codex CLI: MCP server added (via codex mcp add)");
      return logs;
    }
    logs.push("  \x1b[33m!\x1b[0m Codex CLI: CLI method failed, falling back to file config");
  }

  // Fallback: write directly to ~/.codex/config.toml
  const codexDir = path.join(HOME, ".codex");
  const configPath = path.join(codexDir, "config.toml");

  if (!fs.existsSync(codexDir)) {
    fs.mkdirSync(codexDir, { recursive: true });
  }

  let existing = "";
  if (fs.existsSync(configPath)) {
    existing = fs.readFileSync(configPath, "utf-8");
  }

  // Check if [mcp_servers.multiagents] already exists
  if (existing.includes("[mcp_servers.multiagents]")) {
    // Replace existing block
    existing = existing.replace(
      /\[mcp_servers\.multiagents\][^\[]*/s,
      `[mcp_servers.multiagents]\ncommand = "${serverBin}"\nargs = ["--agent-type", "codex"]\n\n`
    );
  } else {
    // Append new block
    existing += `\n[mcp_servers.multiagents]\ncommand = "${serverBin}"\nargs = ["--agent-type", "codex"]\n`;
  }

  fs.writeFileSync(configPath, existing);
  logs.push("  \x1b[32m✔\x1b[0m Codex CLI: MCP server written to ~/.codex/config.toml");
  return logs;
}

// --- Gemini CLI ---
// No CLI command for adding MCP servers (as of March 2026).
// Direct write to: ~/.gemini/settings.json → mcpServers
// Docs: https://geminicli.com/docs/tools/mcp-server/

function configureGemini(serverBin: string): string[] {
  const logs: string[] = [];
  const geminiDir = path.join(HOME, ".gemini");
  const configPath = path.join(geminiDir, "settings.json");

  if (!fs.existsSync(geminiDir)) {
    fs.mkdirSync(geminiDir, { recursive: true });
  }

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try { settings = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch { settings = {}; }
  }

  const mcpServers = (settings.mcpServers as Record<string, unknown>) ?? {};
  mcpServers["multiagents"] = {
    command: serverBin,
    args: ["--agent-type", "gemini"],
    timeout: 30000,
  };
  settings.mcpServers = mcpServers;

  fs.writeFileSync(configPath, JSON.stringify(settings, null, 2) + "\n");
  logs.push("  \x1b[32m✔\x1b[0m Gemini CLI: MCP server written to ~/.gemini/settings.json");
  return logs;
}

// --- Public API ---

interface ConfigResult {
  logs: string[];
  configured: string[];
}

function configureMcp(): ConfigResult {
  const serverBin = findBinary("multiagents-server");
  const orchBin = findBinary("multiagents-orch");
  const logs: string[] = [];
  const configured: string[] = [];

  // Claude Code (always — it's the primary orchestrator)
  const claudeLogs = configureClaude(serverBin, orchBin);
  logs.push(...claudeLogs);
  configured.push("claude");

  // Codex CLI (if installed)
  if (findAgentCli("codex")) {
    const codexLogs = configureCodex(serverBin);
    logs.push(...codexLogs);
    configured.push("codex");
  } else {
    logs.push("  \x1b[90m-\x1b[0m Codex CLI: not installed, skipping");
  }

  // Gemini CLI (if installed)
  if (findAgentCli("gemini")) {
    const geminiLogs = configureGemini(serverBin);
    logs.push(...geminiLogs);
    configured.push("gemini");
  } else {
    logs.push("  \x1b[90m-\x1b[0m Gemini CLI: not installed, skipping");
  }

  return { logs, configured };
}

/** Verbose version — standalone `multiagents install-mcp` command. */
export async function installMcp(): Promise<void> {
  console.log("\n\x1b[1m\x1b[36m  multiagents install-mcp\x1b[0m");
  console.log("\x1b[90m  Configure MCP servers for all detected agent CLIs\x1b[0m\n");

  const { logs, configured } = configureMcp();
  for (const line of logs) console.log(line);

  console.log(`
\x1b[1m\x1b[32mDone!\x1b[0m MCP configured for: ${configured.join(", ")}

\x1b[1mNext step:\x1b[0m Restart your agent CLIs to load the new tools.

\x1b[1mVerify:\x1b[0m
${configured.includes("claude") ? "  Claude:  \x1b[90mclaude mcp list | grep multiagent\x1b[0m\n" : ""}${configured.includes("codex") ? "  Codex:   \x1b[90mcodex mcp list\x1b[0m\n" : ""}${configured.includes("gemini") ? "  Gemini:  \x1b[90mCheck ~/.gemini/settings.json\x1b[0m\n" : ""}
\x1b[1mManual setup:\x1b[0m
  Claude:  \x1b[90mclaude mcp add multiagents -s user -- multiagents-server\x1b[0m
  Codex:   \x1b[90mcodex mcp add multiagents -- multiagents-server --agent-type codex\x1b[0m
  Gemini:  Add to ~/.gemini/settings.json:
           \x1b[90m{"mcpServers":{"multiagents":{"command":"multiagents-server","args":["--agent-type","gemini"]}}}\x1b[0m
`);
}

/** Quiet version — called from `setup` flow. */
export async function installMcpSilent(): Promise<void> {
  const { logs } = configureMcp();
  for (const line of logs) console.log(line);
}
