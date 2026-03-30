#!/usr/bin/env bun
/**
 * Pre-uninstall script: removes MCP server configs that were added by postinstall.
 * Cleans up Claude Code, Codex CLI, and Gemini CLI configurations.
 * If it fails, prints a message — never breaks the uninstall.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const HOME = os.homedir();

function findAgentCli(name: string): string | null {
  try {
    const which = Bun.spawnSync(["which", name]);
    if (which.exitCode === 0) return new TextDecoder().decode(which.stdout).trim();
  } catch { /* ok */ }
  return null;
}

// --- Claude Code ---
function removeClaude(): void {
  const claudePath = findAgentCli("claude");
  if (claudePath) {
    Bun.spawnSync([claudePath, "mcp", "remove", "multiagents", "-s", "user"], { stderr: "ignore", stdout: "ignore" });
    Bun.spawnSync([claudePath, "mcp", "remove", "multiagents-orch", "-s", "user"], { stderr: "ignore", stdout: "ignore" });
    console.log("[multiagents] Removed MCP servers from Claude Code (via claude mcp remove)");
    return;
  }

  // Fallback: edit ~/.claude.json directly
  const configPath = path.join(HOME, ".claude.json");
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const mcpServers = config.mcpServers;
      if (mcpServers) {
        delete mcpServers["multiagents"];
        delete mcpServers["multiagents-orch"];
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
        console.log("[multiagents] Removed MCP servers from ~/.claude.json");
      }
    } catch { /* ok */ }
  }
}

// --- Codex CLI ---
function removeCodex(): void {
  const codexPath = findAgentCli("codex");
  if (codexPath) {
    Bun.spawnSync([codexPath, "mcp", "remove", "multiagents"], { stderr: "ignore", stdout: "ignore" });
    console.log("[multiagents] Removed MCP server from Codex CLI (via codex mcp remove)");
    return;
  }

  // Fallback: edit ~/.codex/config.toml directly
  const configPath = path.join(HOME, ".codex", "config.toml");
  if (fs.existsSync(configPath)) {
    try {
      let content = fs.readFileSync(configPath, "utf-8");
      // Remove [mcp_servers.multiagents] block
      content = content.replace(/\[mcp_servers\.multiagents\][^\[]*/s, "");
      fs.writeFileSync(configPath, content.trim() + "\n");
      console.log("[multiagents] Removed MCP server from ~/.codex/config.toml");
    } catch { /* ok */ }
  }
}

// --- Gemini CLI ---
function removeGemini(): void {
  const configPath = path.join(HOME, ".gemini", "settings.json");
  if (fs.existsSync(configPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const mcpServers = settings.mcpServers;
      if (mcpServers) {
        delete mcpServers["multiagents"];
        fs.writeFileSync(configPath, JSON.stringify(settings, null, 2) + "\n");
        console.log("[multiagents] Removed MCP server from ~/.gemini/settings.json");
      }
    } catch { /* ok */ }
  }
}

// --- Main ---
try {
  removeClaude();
  removeCodex();
  removeGemini();
  console.log("[multiagents] MCP cleanup complete. Restart your agent CLIs to apply.");
} catch (e) {
  console.error(`[multiagents] preuninstall warning: ${e instanceof Error ? e.message : String(e)}`);
}
