#!/usr/bin/env bun
/**
 * Post-install script: auto-configures MCP servers for Claude Code.
 *
 * Adds multiagents and multiagents-orch to ~/.claude/.mcp.json
 * so Claude Code can discover the tools without manual configuration.
 *
 * Safe: only adds entries if they don't already exist. Never overwrites.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, ".claude");
const MCP_JSON = path.join(CLAUDE_DIR, ".mcp.json");

// Resolve the installed package's bin paths
const PKG_ROOT = path.resolve(import.meta.dir, "..");
const SERVER_PATH = path.join(PKG_ROOT, "server.ts");
const ORCH_PATH = path.join(PKG_ROOT, "orchestrator", "orchestrator-server.ts");

// Find bun binary
function findBun(): string {
  const bunInPath = Bun.spawnSync(["which", "bun"]).stdout.toString().trim();
  if (bunInPath) return bunInPath;
  const defaultBun = path.join(HOME, ".bun", "bin", "bun");
  if (fs.existsSync(defaultBun)) return defaultBun;
  return "bun"; // fallback — hope it's in PATH at runtime
}

const BUN = findBun();

try {
  // Ensure ~/.claude/ exists
  if (!fs.existsSync(CLAUDE_DIR)) {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  }

  // Read or create .mcp.json
  let config: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
  if (fs.existsSync(MCP_JSON)) {
    try {
      config = JSON.parse(fs.readFileSync(MCP_JSON, "utf-8"));
      if (!config.mcpServers) config.mcpServers = {};
    } catch {
      // Corrupted file — back up and recreate
      fs.copyFileSync(MCP_JSON, MCP_JSON + ".bak");
      config = { mcpServers: {} };
    }
  }

  let changed = false;

  // Add multiagents MCP server
  if (!config.mcpServers["multiagents"]) {
    config.mcpServers["multiagents"] = {
      command: BUN,
      args: [SERVER_PATH],
    };
    changed = true;
  }

  // Add orchestrator MCP server
  if (!config.mcpServers["multiagents-orch"]) {
    config.mcpServers["multiagents-orch"] = {
      command: BUN,
      args: [ORCH_PATH],
    };
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(MCP_JSON, JSON.stringify(config, null, 2) + "\n");
    console.log("[multiagents] MCP servers configured in ~/.claude/.mcp.json");
    console.log("  Restart Claude Code to pick up the new tools.");
  } else {
    console.log("[multiagents] MCP servers already configured.");
  }
} catch (e) {
  // Postinstall should never fail the install
  console.error(`[multiagents] postinstall warning: ${e instanceof Error ? e.message : String(e)}`);
}
