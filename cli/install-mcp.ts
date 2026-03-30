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
 * Gemini CLI: `gemini mcp add -s user --trust` → writes to ~/.gemini/settings.json
 *   Docs: https://geminicli.com/docs/tools/mcp-server/
 *
 * Each agent has its own config format and location. This script handles all three.
 *
 * Error-isolation guarantee: every configure* function catches its own errors and
 * returns them as warning log lines. A failure in one agent never stops others.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const HOME = os.homedir();
const CLAUDE_PERMISSION_ENTRIES = ["mcp__multiagents", "mcp__multiagents-orch"] as const;
const CLAUDE_STALE_PERMISSION_ENTRIES = ["mcp__multiagents__*", "mcp__multiagents-orch__*"] as const;
const CODEX_ARGS_TOML = '["--agent-type", "codex"]';
const GEMINI_ARGS = ["--agent-type", "gemini"] as const;

interface AgentConfigResult {
  logs: string[];
  ok: boolean;
}

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

  if (lines[index].trim() === target) {
    return false;
  }

  lines[index] = target;
  return true;
}

function upsertCodexMultiagentsSection(content: string, serverBin: string): { content: string; changed: boolean } {
  const sectionRegex = /(^|\n)\[mcp_servers\.multiagents\]\n([\s\S]*?)(?=\n\[|$)/;
  const match = content.match(sectionRegex);
  const desiredSection = [
    "[mcp_servers.multiagents]",
    `command = ${JSON.stringify(serverBin)}`,
    `args = ${CODEX_ARGS_TOML}`,
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

  const bodyLines = match[2].split("\n");
  if (bodyLines.at(-1) === "") bodyLines.pop();

  let changed = false;
  changed = upsertTomlLine(bodyLines, "command", JSON.stringify(serverBin)) || changed;
  changed = upsertTomlLine(bodyLines, "args", CODEX_ARGS_TOML) || changed;
  changed = upsertTomlLine(bodyLines, "default_approval_mode", '"approve"') || changed;

  const replacement = `${match[1]}[mcp_servers.multiagents]\n${bodyLines.join("\n")}\n`;
  return {
    content: content.replace(sectionRegex, replacement),
    changed,
  };
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
function addClaudePermissions(): AgentConfigResult {
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

  const missing = CLAUDE_PERMISSION_ENTRIES.filter((entry) => !allow.includes(entry));

  if (missing.length === 0 && !hadStale) {
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

function writeClaudeConfig(serverBin: string, orchBin: string): AgentConfigResult {
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
  const existingOrch = asRecord(mcpServers["multiagents-orch"]) ?? {};

  mcpServers["multiagents"] = {
    ...existingServer,
    type: "stdio",
    command: serverBin,
    args: [],
    env: asRecord(existingServer.env) ?? {},
  };
  mcpServers["multiagents-orch"] = {
    ...existingOrch,
    type: "stdio",
    command: orchBin,
    args: [],
    env: asRecord(existingOrch.env) ?? {},
  };
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

function configureClaude(serverBin: string, orchBin: string): AgentConfigResult {
  const logs: string[] = [];
  const claudePath = findAgentCli("claude");
  let serverOk = false;

  if (claudePath) {
    // Use the official CLI (preferred) — remove first to avoid duplicates
    Bun.spawnSync([claudePath, "mcp", "remove", "multiagents", "-s", "user"], { stderr: "ignore", stdout: "ignore" });
    Bun.spawnSync([claudePath, "mcp", "remove", "multiagents-orch", "-s", "user"], { stderr: "ignore", stdout: "ignore" });

    const r1 = Bun.spawnSync([claudePath, "mcp", "add", "multiagents", "-s", "user", "--", serverBin]);
    const r2 = Bun.spawnSync([claudePath, "mcp", "add", "multiagents-orch", "-s", "user", "--", orchBin]);

    if (r1.exitCode === 0 && r2.exitCode === 0) {
      logs.push("  \x1b[32m✔\x1b[0m Claude Code: MCP servers added (via claude mcp add -s user)");
      serverOk = true;
    } else {
      logs.push("  \x1b[33m!\x1b[0m Claude Code: CLI method failed, falling back to file config");
      const fileResult = writeClaudeConfig(serverBin, orchBin);
      logs.push(...fileResult.logs);
      serverOk = fileResult.ok;
    }
  } else {
    // No claude CLI — write directly to ~/.claude.json
    const fileResult = writeClaudeConfig(serverBin, orchBin);
    logs.push(...fileResult.logs);
    serverOk = fileResult.ok;
  }

  // Always add tool-level permissions to ~/.claude/settings.json (never throws)
  const permissionsResult = addClaudePermissions();
  logs.push(...permissionsResult.logs);
  return { logs, ok: serverOk && permissionsResult.ok };
}

// --- Codex CLI ---
// Uses: `codex mcp add <name> -- <command> <args...>`
// Writes to: ~/.codex/config.toml → [mcp_servers.<name>]
// Docs: https://developers.openai.com/codex/mcp

function configureCodex(serverBin: string): AgentConfigResult {
  const logs: string[] = [];
  let ok = false;

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
      const r1 = Bun.spawnSync([codexPath, "mcp", "add", "multiagents", "--", serverBin, "--agent-type", "codex"]);
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
    const updated = upsertCodexMultiagentsSection(existing, serverBin);

    if (updated.changed) {
      fs.writeFileSync(configPath, updated.content);
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

// --- Gemini CLI ---
// Prefer: `gemini mcp add -s user --trust`
// Fallback: direct write to ~/.gemini/settings.json → mcpServers
// Docs: https://geminicli.com/docs/tools/mcp-server/

function writeGeminiConfig(serverBin: string): AgentConfigResult {
  const geminiDir = path.join(HOME, ".gemini");
  const configPath = path.join(geminiDir, "settings.json");
  const readResult = readJsonObject(configPath);

  if (!readResult.value) {
    return {
      logs: [`  \x1b[33m!\x1b[0m Gemini CLI: ${readResult.error}, skipping ~/.gemini/settings.json update`],
      ok: false,
    };
  }

  const settings = readResult.value;
  const mcpServers = asRecord(settings.mcpServers) ?? {};
  const existingEntry = asRecord(mcpServers["multiagents"]) ?? {};
  const existingArgs = Array.isArray(existingEntry.args) ? existingEntry.args : [];
  const isAlreadyConfigured = existingEntry.command === serverBin
    && JSON.stringify(existingArgs) === JSON.stringify(GEMINI_ARGS)
    && existingEntry.timeout === 30000
    && existingEntry.trust === true;

  if (isAlreadyConfigured) {
    return {
      logs: ["  \x1b[90m✔\x1b[0m Gemini CLI: MCP server already configured"],
      ok: true,
    };
  }

  mcpServers["multiagents"] = {
    ...existingEntry,
    command: serverBin,
    args: [...GEMINI_ARGS],
    timeout: 30000,
    trust: true,
  };
  settings.mcpServers = mcpServers;

  try {
    if (!fs.existsSync(geminiDir)) {
      fs.mkdirSync(geminiDir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(settings, null, 2) + "\n");
    return {
      logs: ["  \x1b[32m✔\x1b[0m Gemini CLI: MCP server written to ~/.gemini/settings.json (trust: true)"],
      ok: true,
    };
  } catch (e) {
    return {
      logs: [`  \x1b[33m!\x1b[0m Gemini CLI: could not write ~/.gemini/settings.json — ${errMsg(e)}`],
      ok: false,
    };
  }
}

function configureGemini(serverBin: string): AgentConfigResult {
  const logs: string[] = [];
  let ok = false;

  try {
    const geminiDir = path.join(HOME, ".gemini");
    if (!fs.existsSync(geminiDir)) {
      fs.mkdirSync(geminiDir, { recursive: true });
    }

    const geminiPath = findAgentCli("gemini");
    if (geminiPath) {
      Bun.spawnSync([geminiPath, "mcp", "remove", "-s", "user", "multiagents"], { stderr: "ignore", stdout: "ignore" });
      const addResult = Bun.spawnSync([
        geminiPath,
        "mcp",
        "add",
        "-s",
        "user",
        "--trust",
        "--timeout",
        "30000",
        "multiagents",
        serverBin,
        ...GEMINI_ARGS,
      ]);
      if (addResult.exitCode === 0) {
        logs.push("  \x1b[32m✔\x1b[0m Gemini CLI: MCP server added (via gemini mcp add -s user --trust)");
        ok = true;
      } else {
        logs.push("  \x1b[33m!\x1b[0m Gemini CLI: CLI method failed, falling back to file config");
      }
    }
  } catch (e) {
    logs.push(`  \x1b[33m!\x1b[0m Gemini CLI: configuration failed — ${errMsg(e)}`);
  }

  const fileResult = writeGeminiConfig(serverBin);
  logs.push(...fileResult.logs);
  ok = ok || fileResult.ok;

  return { logs, ok };
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
  try {
    const result = configureClaude(serverBin, orchBin);
    logs.push(...result.logs);
    if (result.ok) configured.push("claude");
  } catch (e) {
    logs.push(`  \x1b[33m!\x1b[0m Claude Code: unexpected error — ${errMsg(e)}`);
  }

  // Codex CLI (if CLI binary exists OR ~/.codex/ config dir exists)
  const codexDetected = findAgentCli("codex") || fs.existsSync(path.join(HOME, ".codex"));
  if (codexDetected) {
    try {
      const result = configureCodex(serverBin);
      logs.push(...result.logs);
      if (result.ok) configured.push("codex");
    } catch (e) {
      logs.push(`  \x1b[33m!\x1b[0m Codex CLI: unexpected error — ${errMsg(e)}`);
    }
  } else {
    logs.push("  \x1b[90m-\x1b[0m Codex CLI: not detected, skipping");
  }

  // Gemini CLI (if CLI binary exists OR ~/.gemini/ config dir exists)
  const geminiDetected = findAgentCli("gemini") || fs.existsSync(path.join(HOME, ".gemini"));
  if (geminiDetected) {
    try {
      const result = configureGemini(serverBin);
      logs.push(...result.logs);
      if (result.ok) configured.push("gemini");
    } catch (e) {
      logs.push(`  \x1b[33m!\x1b[0m Gemini CLI: unexpected error — ${errMsg(e)}`);
    }
  } else {
    logs.push("  \x1b[90m-\x1b[0m Gemini CLI: not detected, skipping");
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
${configured.includes("claude") ? "  Claude:  \x1b[90mclaude mcp list | grep multiagents\x1b[0m\n" : ""}${configured.includes("codex") ? "  Codex:   \x1b[90mcodex mcp list\x1b[0m\n" : ""}${configured.includes("gemini") ? "  Gemini:  \x1b[90mgemini mcp list\x1b[0m\n" : ""}
\x1b[1mManual setup:\x1b[0m
  Claude:  \x1b[90mclaude mcp add multiagents -s user -- multiagents-server\x1b[0m
  Codex:   \x1b[90mcodex mcp add multiagents -- multiagents-server --agent-type codex\x1b[0m
  Gemini:  \x1b[90mgemini mcp add -s user --trust multiagents multiagents-server --agent-type gemini\x1b[0m
           \x1b[90m(or add trust:true under ~/.gemini/settings.json if the CLI is unavailable)\x1b[0m
`);
}

/** Quiet version — called from postinstall / setup flow. */
export async function installMcpSilent(): Promise<void> {
  const { logs } = configureMcp();
  for (const line of logs) console.log(line);
}
