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
const CLAUDE_PERMISSION_ENTRIES = [
  "mcp__multiagents",
  "mcp__multiagents-orch",
  "mcp__multiagents__*",
  "mcp__multiagents-orch__*",
] as const;

function findAgentCli(name: string): string | null {
  try {
    const which = Bun.spawnSync(["which", name]);
    if (which.exitCode === 0) return new TextDecoder().decode(which.stdout).trim();
  } catch { /* ok */ }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// --- Claude Code ---
function removeClaude(): void {
  const claudePath = findAgentCli("claude");
  if (claudePath) {
    Bun.spawnSync([claudePath, "mcp", "remove", "multiagents", "-s", "user"], { stderr: "ignore", stdout: "ignore" });
    Bun.spawnSync([claudePath, "mcp", "remove", "multiagents-orch", "-s", "user"], { stderr: "ignore", stdout: "ignore" });
    console.log("[multiagents] Removed MCP servers from Claude Code (via claude mcp remove)");
  }

  // Always also clean the persisted user config file.
  const configPath = path.join(HOME, ".claude.json");
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const mcpServers = asRecord(config.mcpServers);
      const hadEntry = Boolean(mcpServers?.["multiagents"] || mcpServers?.["multiagents-orch"]);
      if (mcpServers && hadEntry) {
        delete mcpServers["multiagents"];
        delete mcpServers["multiagents-orch"];
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
        console.log("[multiagents] Removed MCP servers from ~/.claude.json");
      }
    } catch { /* ok */ }
  }

  // Always remove tool-level permissions from ~/.claude/settings.json
  const settingsPath = path.join(HOME, ".claude", "settings.json");
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      const permissions = settings.permissions;
      if (permissions?.allow && Array.isArray(permissions.allow)) {
        const before = permissions.allow.length;
        permissions.allow = permissions.allow.filter(
          (e: string) => !CLAUDE_PERMISSION_ENTRIES.includes(e as typeof CLAUDE_PERMISSION_ENTRIES[number]),
        );
        if (permissions.allow.length !== before) {
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
          console.log("[multiagents] Removed MCP permissions from ~/.claude/settings.json");
        }
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
  }

  // Always also remove the persisted config block for idempotent cleanup.
  const configPath = path.join(HOME, ".codex", "config.toml");
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, "utf-8");
      // Remove only the multiagents section, not TOML arrays inside it.
      const updated = content.replace(/(^|\n)\[mcp_servers\.multiagents\]\n[\s\S]*?(?=\n\[|$)/, "$1");
      if (updated !== content) {
        fs.writeFileSync(configPath, updated.trim() + "\n");
        console.log("[multiagents] Removed MCP server from ~/.codex/config.toml");
      }
    } catch { /* ok */ }
  }
}

// --- Gemini CLI ---
function removeGemini(): void {
  const geminiPath = findAgentCli("gemini");
  if (geminiPath) {
    Bun.spawnSync([geminiPath, "mcp", "remove", "-s", "user", "multiagents"], { stderr: "ignore", stdout: "ignore" });
    console.log("[multiagents] Removed MCP server from Gemini CLI (via gemini mcp remove -s user)");
  }

  const configPath = path.join(HOME, ".gemini", "settings.json");
  if (fs.existsSync(configPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const mcpServers = asRecord(settings.mcpServers);
      if (mcpServers && mcpServers["multiagents"]) {
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
