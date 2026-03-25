#!/usr/bin/env bun
/**
 * multiagents install-mcp — Configure MCP servers for Claude Code.
 *
 * 1. Writes multiagents + multiagents-orch to ~/.claude/.mcp.json
 * 2. Adds them to enabledMcpjsonServers in ~/.claude/settings.json
 * 3. Prints instructions to restart Claude Code
 *
 * Uses the installed binary names (multiagents-server, multiagents-orch)
 * so it works regardless of where the package is installed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, ".claude");
const MCP_JSON = path.join(CLAUDE_DIR, ".mcp.json");
const SETTINGS_JSON = path.join(CLAUDE_DIR, "settings.json");

function findBinary(name: string): string {
  try {
    const which = Bun.spawnSync(["which", name]);
    const found = new TextDecoder().decode(which.stdout).trim();
    if (found) return found;
  } catch { /* ok */ }

  const candidates = [
    path.join(HOME, ".bun", "bin", name),
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return name;
}

/** Core logic — configures .mcp.json + settings.json. Returns log lines. */
function configureMcp(): string[] {
  const logs: string[] = [];
  const serverBin = findBinary("multiagents-server");
  const orchBin = findBinary("multiagents-orch");

  // Step 1: Write ~/.claude/.mcp.json
  if (!fs.existsSync(CLAUDE_DIR)) {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  }

  let mcpConfig: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
  if (fs.existsSync(MCP_JSON)) {
    try {
      mcpConfig = JSON.parse(fs.readFileSync(MCP_JSON, "utf-8"));
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    } catch {
      fs.copyFileSync(MCP_JSON, MCP_JSON + ".bak");
      mcpConfig = { mcpServers: {} };
      logs.push("  \x1b[33m!\x1b[0m Existing .mcp.json was corrupted — backed up and recreated");
    }
  }

  mcpConfig.mcpServers["multiagents"] = { command: serverBin, args: [] };
  mcpConfig.mcpServers["multiagents-orch"] = { command: orchBin, args: [] };
  fs.writeFileSync(MCP_JSON, JSON.stringify(mcpConfig, null, 2) + "\n");
  logs.push("  \x1b[32m✔\x1b[0m Global MCP configured (~/.claude/.mcp.json)");

  // Step 2: Enable in ~/.claude/settings.json
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(SETTINGS_JSON)) {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_JSON, "utf-8"));
    } catch {
      logs.push("  \x1b[33m!\x1b[0m Could not parse settings.json — skipping auto-enable");
      return logs;
    }
  }

  const enabled = (settings.enabledMcpjsonServers as string[]) ?? [];
  let changed = false;
  if (!enabled.includes("multiagents")) { enabled.push("multiagents"); changed = true; }
  if (!enabled.includes("multiagents-orch")) { enabled.push("multiagents-orch"); changed = true; }
  if (changed) {
    settings.enabledMcpjsonServers = enabled;
    fs.writeFileSync(SETTINGS_JSON, JSON.stringify(settings, null, 2) + "\n");
    logs.push("  \x1b[32m✔\x1b[0m Enabled in ~/.claude/settings.json");
  } else {
    logs.push("  \x1b[32m✔\x1b[0m Already enabled in settings.json");
  }

  return logs;
}

/** Verbose version — standalone `multiagents install-mcp` command. */
export async function installMcp(): Promise<void> {
  console.log("\n\x1b[1m\x1b[36m  multiagents install-mcp\x1b[0m");
  console.log("\x1b[90m  Configure MCP servers for Claude Code\x1b[0m\n");

  const logs = configureMcp();
  for (const line of logs) console.log(line);

  console.log(`
\x1b[1m\x1b[32mDone!\x1b[0m MCP servers configured.

\x1b[1mNext step:\x1b[0m Restart Claude Code to load the new tools.
  Exit Claude Code and run: \x1b[90mclaude\x1b[0m

\x1b[1mManual setup:\x1b[0m If auto-config doesn't work, add to ~/.claude/.mcp.json:
\x1b[90m  {
    "mcpServers": {
      "multiagents": { "command": "multiagents-server", "args": [] },
      "multiagents-orch": { "command": "multiagents-orch", "args": [] }
    }
  }\x1b[0m

And add to ~/.claude/settings.json:
\x1b[90m  "enabledMcpjsonServers": ["multiagents", "multiagents-orch"]\x1b[0m
`);
}

/** Quiet version — called from `setup` flow, prints compact output. */
export async function installMcpSilent(): Promise<void> {
  const logs = configureMcp();
  for (const line of logs) console.log(line);
}
