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
 * Antigravity CLI: writes to ~/.gemini/config/mcp_config.json
 *   Docs: https://antigravity.google/docs/mcp
 *
 * Each agent has its own config format and location. This script handles all three.
 *
 * Error-isolation guarantee: every configure* function catches its own errors and
 * returns them as warning log lines. A failure in one agent never stops others.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readOrchestratorHost, writeOrchestratorHost, type OrchestratorHost } from "../shared/orchestrator-host.ts";

const HOME = os.homedir();
const CLAUDE_PERMISSION_ENTRIES = ["mcp__multiagents", "mcp__multiagents-orch"] as const;
const CLAUDE_STALE_PERMISSION_ENTRIES = ["mcp__multiagents__*", "mcp__multiagents-orch__*"] as const;
const CODEX_ARGS_TOML = '["--agent-type", "codex"]';
const AGY_ARGS = ["--agent-type", "agy"] as const;

// --- Self-resolving paths ---
// Compute script paths relative to THIS file's location in the installed package.
// This is the ONLY reliable method — it works regardless of whether symlinks are
// on PATH, which install method was used (bun/npm), or whether a previous install
// left stale binaries behind. `which` and PATH scanning are intentionally avoided.
const PACKAGE_ROOT = path.resolve(import.meta.dir, "..");
const SERVER_SCRIPT = path.join(PACKAGE_ROOT, "server.ts");
const ORCH_SCRIPT = path.join(PACKAGE_ROOT, "orchestrator", "orchestrator-server.ts");

// Resolve the bun binary (needed as the command since scripts use bun shebangs)
function findBun(): string {
  try {
    const which = Bun.spawnSync(["which", "bun"]);
    const found = new TextDecoder().decode(which.stdout).trim();
    if (found) return found;
  } catch { /* ok */ }
  // Fallback candidates
  for (const p of [
    path.join(HOME, ".bun", "bin", "bun"),
    "/usr/local/bin/bun",
    "/opt/homebrew/bin/bun",
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return "bun"; // assume on PATH
}

const BUN_BIN = findBun();

interface AgentConfigResult {
  logs: string[];
  ok: boolean;
}

function findAgentCli(name: string): string | null {
  try {
    const which = Bun.spawnSync(["which", name]);
    if (which.exitCode === 0) return new TextDecoder().decode(which.stdout).trim();
  } catch { /* ok */ }

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
    agy: [
      path.join(HOME, ".local", "bin", "agy"),
      "/usr/local/bin/agy",
      "/opt/homebrew/bin/agy",
    ],
  };

  for (const p of (knownPaths[name] ?? [])) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readJsonObject(filePath: string): { value: Record<string, unknown> | null; error?: string } {
  if (!fs.existsSync(filePath)) {
    return { value: {} };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const record = asRecord(parsed);
    if (!record) {
      return { value: null, error: `${filePath} is not a JSON object` };
    }
    return { value: record };
  } catch {
    return { value: null, error: `${filePath} is malformed JSON` };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function upsertTomlLine(lines: string[], key: string, value: string): boolean {
  const target = `${key} = ${value}`;
  const matcher = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const index = lines.findIndex((line) => matcher.test(line));

  if (index === -1) {
    lines.push(target);
    return true;
  }

  const currentLine = lines[index];
  if (currentLine !== undefined && currentLine.trim() === target) {
    return false;
  }

  lines[index] = target;
  return true;
}

function upsertCodexMcpSection(content: string, serverName: string, serverCmd: string, serverArgs: string[]): { content: string; changed: boolean } {
  const argsToml = `[${serverArgs.map(a => JSON.stringify(a)).join(", ")}]`;
  const escapedName = escapeRegExp(serverName);
  const sectionRegex = new RegExp(`(^|\\n)\\[mcp_servers\\.${escapedName}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`);
  const match = content.match(sectionRegex);
  const desiredSection = [
    `[mcp_servers.${serverName}]`,
    `command = ${JSON.stringify(serverCmd)}`,
    `args = ${argsToml}`,
    'default_approval_mode = "approve"',
    "",
  ].join("\n");

  if (!match) {
    const prefix = content.trimEnd();
    return {
      content: prefix ? `${prefix}\n\n${desiredSection}` : desiredSection,
      changed: true,
    };
  }

  const bodyLines = (match[2] ?? "").split("\n");
  if (bodyLines.at(-1) === "") bodyLines.pop();

  let changed = false;
  changed = upsertTomlLine(bodyLines, "command", JSON.stringify(serverCmd)) || changed;
  changed = upsertTomlLine(bodyLines, "args", argsToml) || changed;
  changed = upsertTomlLine(bodyLines, "default_approval_mode", '"approve"') || changed;

  const replacement = `${match[1]}[mcp_servers.${serverName}]\n${bodyLines.join("\n")}\n`;
  return {
    content: content.replace(sectionRegex, replacement),
    changed,
  };
}

function removeCodexMcpSection(content: string, serverName: string): { content: string; changed: boolean } {
  const escapedName = escapeRegExp(serverName);
  const sectionRegex = new RegExp(`(^|\\n)\\[mcp_servers\\.${escapedName}\\]\\n[\\s\\S]*?(?=\\n\\[|$)`);
  const updated = content.replace(sectionRegex, "$1");
  return { content: updated, changed: updated !== content };
}

// --- Claude Code ---
// Uses: `claude mcp add <name> -s user -- <command>`
// Writes to: ~/.claude.json → mcpServers
// Docs: https://docs.anthropic.com/en/docs/claude-code

/**
 * Add MCP tool permissions to ~/.claude/settings.json so Claude Code never
 * prompts when calling multiagents tools.
 *
 * Claude Code stores MCP allow-rules by server name, e.g. "mcp__multiagents".
 * Also cleans up stale wildcard entries written by earlier installer builds.
 *
 * Never throws — returns a warning line on any I/O error.
 */
function addClaudePermissions(includeOrchestrator: boolean): AgentConfigResult {
  const settingsDir = path.join(HOME, ".claude");
  const settingsPath = path.join(settingsDir, "settings.json");
  const readResult = readJsonObject(settingsPath);

  if (!readResult.value) {
    return {
      logs: [`  \x1b[33m!\x1b[0m Claude Code: ${readResult.error}, skipping permissions`],
      ok: false,
    };
  }

  const settings = readResult.value;
  const permissions = asRecord(settings.permissions) ?? {};
  let allow = Array.isArray(permissions.allow) ? [...(permissions.allow as string[])] : [];
  const hadStale = allow.some((entry) => CLAUDE_STALE_PERMISSION_ENTRIES.includes(entry as typeof CLAUDE_STALE_PERMISSION_ENTRIES[number]));
  if (hadStale) {
    allow = allow.filter((entry) => !CLAUDE_STALE_PERMISSION_ENTRIES.includes(entry as typeof CLAUDE_STALE_PERMISSION_ENTRIES[number]));
  }

  const desired = includeOrchestrator
    ? [...CLAUDE_PERMISSION_ENTRIES]
    : [CLAUDE_PERMISSION_ENTRIES[0]];
  const hadUnwantedOrchestrator = !includeOrchestrator && allow.includes(CLAUDE_PERMISSION_ENTRIES[1]);
  if (hadUnwantedOrchestrator) {
    allow = allow.filter((entry) => entry !== CLAUDE_PERMISSION_ENTRIES[1]);
  }
  const missing = desired.filter((entry) => !allow.includes(entry));

  if (missing.length === 0 && !hadStale && !hadUnwantedOrchestrator) {
    return {
      logs: ["  \x1b[90m✔\x1b[0m Claude Code: MCP permissions already configured"],
      ok: true,
    };
  }

  permissions.allow = [...allow, ...missing];
  settings.permissions = permissions;

  try {
    if (!fs.existsSync(settingsDir)) fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch (e) {
    return {
      logs: [`  \x1b[33m!\x1b[0m Claude Code: could not write permissions to settings.json — ${errMsg(e)}`],
      ok: false,
    };
  }

  const lines: string[] = [];
  if (missing.length > 0) {
    lines.push(`  \x1b[32m✔\x1b[0m Claude Code: permissions added to ~/.claude/settings.json (${missing.join(", ")})`);
  }
  if (hadStale) {
    lines.push("  \x1b[90m✔\x1b[0m Claude Code: cleaned up stale wildcard permission entries");
  }
  return { logs: lines, ok: true };
}

function writeClaudeConfig(serverCmd: string, serverArgs: string[], orchCmd: string, orchArgs: string[], includeOrchestrator: boolean): AgentConfigResult {
  const configPath = path.join(HOME, ".claude.json");
  const readResult = readJsonObject(configPath);

  if (!readResult.value) {
    return {
      logs: [`  \x1b[33m!\x1b[0m Claude Code: ${readResult.error}, skipping ~/.claude.json update`],
      ok: false,
    };
  }

  const config = readResult.value;
  const mcpServers = asRecord(config.mcpServers) ?? {};
  const existingServer = asRecord(mcpServers["multiagents"]) ?? {};

  mcpServers["multiagents"] = {
    ...existingServer,
    type: "stdio",
    command: serverCmd,
    args: [...serverArgs],
    env: asRecord(existingServer.env) ?? {},
  };
  if (includeOrchestrator) {
    const existingOrch = asRecord(mcpServers["multiagents-orch"]) ?? {};
    mcpServers["multiagents-orch"] = {
      ...existingOrch,
      type: "stdio",
      command: orchCmd,
      args: [...orchArgs],
      env: asRecord(existingOrch.env) ?? {},
    };
  } else {
    delete mcpServers["multiagents-orch"];
  }
  config.mcpServers = mcpServers;

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    return {
      logs: ["  \x1b[32m✔\x1b[0m Claude Code: MCP servers written to ~/.claude.json"],
      ok: true,
    };
  } catch (e) {
    return {
      logs: [`  \x1b[33m!\x1b[0m Claude Code: could not write to ~/.claude.json — ${errMsg(e)}`],
      ok: false,
    };
  }
}

function configureClaude(serverCmd: string, serverArgs: string[], orchCmd: string, orchArgs: string[], includeOrchestrator: boolean): AgentConfigResult {
  const logs: string[] = [];
  const claudePath = findAgentCli("claude");
  let serverOk = false;

  if (claudePath) {
    // Use the official CLI (preferred) — remove first to avoid duplicates
    Bun.spawnSync([claudePath, "mcp", "remove", "multiagents", "-s", "user"], { stderr: "ignore", stdout: "ignore" });
    Bun.spawnSync([claudePath, "mcp", "remove", "multiagents-orch", "-s", "user"], { stderr: "ignore", stdout: "ignore" });

    // `claude mcp add <name> -s user -- <command> [args...]`
    const r1 = Bun.spawnSync([claudePath, "mcp", "add", "multiagents", "-s", "user", "--", serverCmd, ...serverArgs]);
    const r2 = includeOrchestrator
      ? Bun.spawnSync([claudePath, "mcp", "add", "multiagents-orch", "-s", "user", "--", orchCmd, ...orchArgs])
      : null;

    if (r1.exitCode === 0 && (!r2 || r2.exitCode === 0)) {
      logs.push("  \x1b[32m✔\x1b[0m Claude Code: MCP servers added (via claude mcp add -s user)");
      serverOk = true;
    } else {
      logs.push("  \x1b[33m!\x1b[0m Claude Code: CLI method failed, falling back to file config");
      const fileResult = writeClaudeConfig(serverCmd, serverArgs, orchCmd, orchArgs, includeOrchestrator);
      logs.push(...fileResult.logs);
      serverOk = fileResult.ok;
    }
  } else {
    // No claude CLI — write directly to ~/.claude.json
    const fileResult = writeClaudeConfig(serverCmd, serverArgs, orchCmd, orchArgs, includeOrchestrator);
    logs.push(...fileResult.logs);
    serverOk = fileResult.ok;
  }

  // Always add tool-level permissions to ~/.claude/settings.json (never throws)
  const permissionsResult = addClaudePermissions(includeOrchestrator);
  logs.push(...permissionsResult.logs);
  return { logs, ok: serverOk && permissionsResult.ok };
}

// --- Codex CLI ---
// Uses: `codex mcp add <name> -- <command> <args...>`
// Writes to: ~/.codex/config.toml → [mcp_servers.<name>]
// Docs: https://developers.openai.com/codex/mcp

function configureCodex(serverCmd: string, serverArgs: string[], orchCmd: string, orchArgs: string[], includeOrchestrator: boolean): AgentConfigResult {
  const logs: string[] = [];
  let ok = false;
  // For Codex TOML: command is "bun", args include the script + "--agent-type codex"
  const codexFullArgs = [...serverArgs, "--agent-type", "codex"];

  try {
    const codexDir = path.join(HOME, ".codex");
    const configPath = path.join(codexDir, "config.toml");

    if (!fs.existsSync(codexDir)) {
      fs.mkdirSync(codexDir, { recursive: true });
    }

    // Try CLI first — but always patch TOML afterward to ensure default_approval_mode,
    // because `codex mcp add` does NOT write approval mode settings.
    const codexPath = findAgentCli("codex");
    if (codexPath) {
      Bun.spawnSync([codexPath, "mcp", "remove", "multiagents"], { stderr: "ignore", stdout: "ignore" });
      Bun.spawnSync([codexPath, "mcp", "remove", "multiagents-orch"], { stderr: "ignore", stdout: "ignore" });
      const r1 = Bun.spawnSync([codexPath, "mcp", "add", "multiagents", "--", serverCmd, ...codexFullArgs]);
      if (includeOrchestrator) {
        Bun.spawnSync([codexPath, "mcp", "add", "multiagents-orch", "--", orchCmd, ...orchArgs]);
      }
      if (r1.exitCode === 0) {
        logs.push("  \x1b[32m✔\x1b[0m Codex CLI: MCP server added (via codex mcp add)");
      } else {
        logs.push("  \x1b[33m!\x1b[0m Codex CLI: CLI method failed, falling back to file config");
      }
    }

    // Always write/patch the TOML to ensure the server command and approval mode are current.
    let existing = "";
    try {
      if (fs.existsSync(configPath)) existing = fs.readFileSync(configPath, "utf-8");
    } catch (e) {
      logs.push(`  \x1b[33m!\x1b[0m Codex CLI: could not read config.toml — ${errMsg(e)}`);
      return { logs, ok: false };
    }

    const hadSection = existing.includes("[mcp_servers.multiagents]");
    const peerUpdated = upsertCodexMcpSection(existing, "multiagents", serverCmd, codexFullArgs);
    const orchUpdated = includeOrchestrator
      ? upsertCodexMcpSection(peerUpdated.content, "multiagents-orch", orchCmd, orchArgs)
      : removeCodexMcpSection(peerUpdated.content, "multiagents-orch");
    const changed = peerUpdated.changed || orchUpdated.changed;

    if (changed) {
      fs.writeFileSync(configPath, orchUpdated.content);
      logs.push(
        hadSection
          ? "  \x1b[32m✔\x1b[0m Codex CLI: updated ~/.codex/config.toml for multiagents approval + command"
          : "  \x1b[32m✔\x1b[0m Codex CLI: MCP server written to ~/.codex/config.toml",
      );
    } else {
      logs.push("  \x1b[90m✔\x1b[0m Codex CLI: MCP server already configured");
    }
    ok = true;
  } catch (e) {
    logs.push(`  \x1b[33m!\x1b[0m Codex CLI: configuration failed — ${errMsg(e)}`);
  }

  return { logs, ok };
}

// --- Antigravity CLI ---
// AGY stores MCP servers separately from preferences in
// ~/.gemini/config/mcp_config.json.
// Docs: https://antigravity.google/docs/cli/gcli-migration/

function configureAgy(serverCmd: string, serverArgs: string[], orchCmd: string, orchArgs: string[], includeOrchestrator: boolean): AgentConfigResult {
  const agyConfigDir = path.join(HOME, ".gemini", "config");
  const configPath = path.join(agyConfigDir, "mcp_config.json");
  const agyFullArgs = [...serverArgs, ...AGY_ARGS];
  const readResult = readJsonObject(configPath);

  if (!readResult.value) {
    return {
      logs: [`  \x1b[33m!\x1b[0m Antigravity CLI: ${readResult.error}, skipping ~/.gemini/config/mcp_config.json update`],
      ok: false,
    };
  }

  const settings = readResult.value;
  const mcpServers = asRecord(settings.mcpServers) ?? {};
  const existingEntry = asRecord(mcpServers["multiagents"]) ?? {};
  const existingArgs = Array.isArray(existingEntry.args) ? existingEntry.args : [];
  const existingOrch = asRecord(mcpServers["multiagents-orch"]);
  const orchArgsMatch = Array.isArray(existingOrch?.args)
    && JSON.stringify(existingOrch.args) === JSON.stringify(orchArgs);
  const isAlreadyConfigured = existingEntry.command === serverCmd
    && JSON.stringify(existingArgs) === JSON.stringify(agyFullArgs)
    && (includeOrchestrator
      ? existingOrch?.command === orchCmd && orchArgsMatch
      : !existingOrch);

  if (isAlreadyConfigured) {
    return {
      logs: ["  \x1b[90m✔\x1b[0m Antigravity CLI: MCP server already configured"],
      ok: true,
    };
  }

  mcpServers["multiagents"] = {
    command: serverCmd,
    args: agyFullArgs,
  };
  if (includeOrchestrator) {
    mcpServers["multiagents-orch"] = { command: orchCmd, args: [...orchArgs] };
  } else {
    delete mcpServers["multiagents-orch"];
  }
  settings.mcpServers = mcpServers;

  try {
    if (!fs.existsSync(agyConfigDir)) {
      fs.mkdirSync(agyConfigDir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(settings, null, 2) + "\n");
    return {
      logs: ["  \x1b[32m✔\x1b[0m Antigravity CLI: MCP server written to ~/.gemini/config/mcp_config.json"],
      ok: true,
    };
  } catch (e) {
    return {
      logs: [`  \x1b[33m!\x1b[0m Antigravity CLI: could not write ~/.gemini/config/mcp_config.json — ${errMsg(e)}`],
      ok: false,
    };
  }
}

// --- Public API ---

interface ConfigResult {
  logs: string[];
  configured: string[];
}

function configureMcp(): ConfigResult {
  // Use self-resolved absolute paths — never depend on PATH or symlinks.
  // For Claude CLI (`claude mcp add -- <cmd> <args...>`), we pass bun + script path.
  // For file-based configs, we write { command: "bun", args: [scriptPath] }.
  const serverBin = BUN_BIN;
  const serverArgs = [SERVER_SCRIPT];
  const orchBin = BUN_BIN;
  const orchArgs = [ORCH_SCRIPT];
  const logs: string[] = [];
  const configured: string[] = [];

  const claudeDetected = Boolean(findAgentCli("claude"));
  const codexDetected = Boolean(findAgentCli("codex") || fs.existsSync(path.join(HOME, ".codex")));
  const agyDetected = Boolean(
    findAgentCli("agy")
      || fs.existsSync(path.join(HOME, ".gemini", "antigravity-cli"))
      || fs.existsSync(path.join(HOME, ".gemini", "config", "mcp_config.json")),
  );
  const savedHost = readOrchestratorHost();
  const hostIsAvailable = (host: OrchestratorHost): boolean =>
    host === "claude" ? claudeDetected : host === "codex" ? codexDetected : agyDetected;
  const orchestratorHost: OrchestratorHost = savedHost && hostIsAvailable(savedHost)
    ? savedHost
    : claudeDetected ? "claude" : codexDetected ? "codex" : agyDetected ? "agy" : "claude";
  if (savedHost && savedHost !== orchestratorHost) {
    logs.push(`  \x1b[33m!\x1b[0m Saved orchestrator ${savedHost} is unavailable; switching to ${orchestratorHost}`);
  }
  try {
    writeOrchestratorHost(orchestratorHost);
  } catch (e) {
    logs.push(`  \x1b[33m!\x1b[0m Could not persist orchestrator host — ${errMsg(e)}`);
  }
  logs.push(`  \x1b[36m◆\x1b[0m Orchestrator host: ${orchestratorHost}`);

  // Claude Code (if CLI binary or configuration exists)
  const claudeConfigured = claudeDetected
    || fs.existsSync(path.join(HOME, ".claude"))
    || fs.existsSync(path.join(HOME, ".claude.json"));
  if (claudeConfigured) {
    try {
      const result = configureClaude(serverBin, serverArgs, orchBin, orchArgs, orchestratorHost === "claude");
      logs.push(...result.logs);
      if (result.ok) configured.push("claude");
    } catch (e) {
      logs.push(`  \x1b[33m!\x1b[0m Claude Code: unexpected error — ${errMsg(e)}`);
    }
  } else {
    logs.push("  \x1b[90m-\x1b[0m Claude Code: not detected, skipping");
  }

  // Codex CLI (if CLI binary exists OR ~/.codex/ config dir exists)
  if (codexDetected) {
    try {
      const result = configureCodex(serverBin, serverArgs, orchBin, orchArgs, orchestratorHost === "codex");
      logs.push(...result.logs);
      if (result.ok) configured.push("codex");
    } catch (e) {
      logs.push(`  \x1b[33m!\x1b[0m Codex CLI: unexpected error — ${errMsg(e)}`);
    }
  } else {
    logs.push("  \x1b[90m-\x1b[0m Codex CLI: not detected, skipping");
  }

  // Antigravity CLI (if CLI binary exists OR its config dir exists)
  if (agyDetected) {
    try {
      const result = configureAgy(serverBin, serverArgs, orchBin, orchArgs, orchestratorHost === "agy");
      logs.push(...result.logs);
      if (result.ok) configured.push("agy");
    } catch (e) {
      logs.push(`  \x1b[33m!\x1b[0m Antigravity CLI: unexpected error — ${errMsg(e)}`);
    }
  } else {
    logs.push("  \x1b[90m-\x1b[0m Antigravity CLI: not detected, skipping");
  }

  return { logs, configured };
}

/** Verbose version — standalone `multiagents install-mcp` command. */
export async function installMcp(): Promise<void> {
  console.log("\n\x1b[1m\x1b[36m  multiagents install-mcp\x1b[0m");
  console.log("\x1b[90m  Configure MCP servers for all detected agent CLIs\x1b[0m\n");

  const { logs, configured } = configureMcp();
  const configuredSummary = configured.length > 0 ? configured.join(", ") : "none";
  for (const line of logs) console.log(line);

  console.log(`
\x1b[1m\x1b[32mDone!\x1b[0m MCP configured for: ${configuredSummary}

\x1b[1mNext step:\x1b[0m Restart your agent CLIs to load the new tools.

\x1b[1mVerify:\x1b[0m
${configured.includes("claude") ? "  Claude:  \x1b[90mclaude mcp list | grep multiagents\x1b[0m\n" : ""}${configured.includes("codex") ? "  Codex:   \x1b[90mcodex mcp list\x1b[0m\n" : ""}${configured.includes("agy") ? "  AGY:     \x1b[90mOpen /mcp and check multiagents\x1b[0m\n" : ""}
\x1b[1mManual setup:\x1b[0m
  Claude:  \x1b[90mclaude mcp add multiagents -s user -- multiagents-server\x1b[0m
  Codex:   \x1b[90mcodex mcp add multiagents -- multiagents-server --agent-type codex\x1b[0m
  AGY:     \x1b[90mAdd multiagents under ~/.gemini/config/mcp_config.json\x1b[0m
`);
}

/** Quiet version — called from postinstall / setup flow. */
export async function installMcpSilent(): Promise<void> {
  const { logs } = configureMcp();
  for (const line of logs) console.log(line);
}
