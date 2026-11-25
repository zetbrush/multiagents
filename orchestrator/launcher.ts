// ============================================================================
// multiagents — Agent Launcher
// ============================================================================
// Spawns agent processes and ensures each one has MCP access to the
// multiagents tools for inter-agent communication through the broker.
//
// Claude, Codex and Antigravity agents run under orchestrator drivers
// (long-lived headless sessions the orchestrator feeds messages into); Gemini
// runs as a one-shot `gemini -p` process that receives messages through tool
// results.
// ============================================================================

import type { Subprocess } from "bun";
import type { AgentType, AgentLaunchConfig, Slot } from "../shared/types.ts";
import type { BrokerClient } from "../shared/broker-client.ts";
import { log, processStartTime } from "../shared/utils.ts";
import { DEFAULT_BROKER_PORT } from "../shared/constants.ts";
import { resolveBrokerPort } from "../shared/broker-url.ts";
import { FULL_PROTOCOL, SHORT_PROTOCOL } from "../adapters/protocol-text.ts";
import { getStructuredRolePractices } from "../adapters/role-practices.ts";
import { ClaudeDriver } from "./claude-driver.ts";
import { CodexDriver } from "./codex-driver.ts";
import { AntigravityDriver, antigravityCommand } from "./antigravity-driver.ts";
import * as path from "node:path";
import * as fs from "node:fs";

const LOG_PREFIX = "launcher";

/** Resolved path to cli.ts — used to build MCP server commands. */
const CLI_PATH = path.resolve(import.meta.dir, "..", "cli.ts");

/** Max agentic turns Claude may take per prompt before it must stop and report. */
const CLAUDE_MAX_TURNS = 200;

/**
 * Build a PATH that includes common CLI installation directories.
 * GUI apps (like Claude Desktop) don't load shell profiles, so their PATH
 * is minimal (just /usr/bin:/bin:/usr/sbin:/sbin). This ensures `which`
 * and spawned child processes can find claude, codex, gemini, bun, etc.
 */
function enrichedPath(): string {
  const home = process.env.HOME ?? "";
  const extra = [
    path.join(home, ".bun", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".nvm", "versions", "node", "current", "bin"),   // nvm
    "/usr/local/bin",
    "/opt/homebrew/bin",                                              // Apple Silicon brew
    "/opt/homebrew/sbin",
    path.join(home, ".cargo", "bin"),                                 // rustup
    path.join(home, ".volta", "bin"),                                 // volta
    path.join(home, "bin"),
  ];
  const current = process.env.PATH ?? "";
  const dirs = new Set(current.split(":"));
  for (const d of extra) {
    if (!dirs.has(d)) dirs.add(d);
  }
  return [...dirs].join(":");
}

/** Cached enriched PATH — computed once per process. */
export const ENRICHED_PATH = enrichedPath();

/** Detection result for an agent CLI binary. */
interface AgentDetection {
  available: boolean;
  version?: string;
  path?: string;
}

/** Result of launching an agent process. */
export interface LaunchResult {
  slotId: number;
  pid: number;
  process: Subprocess;
  /** Present for Codex agents (driven over `codex app-server`). */
  codexDriver?: CodexDriver;
  /** Present for Claude agents (driven over stream-json stdin). */
  claudeDriver?: ClaudeDriver;
  /** Present for Antigravity agents (driven over stream-json stdin). */
  antigravityDriver?: AntigravityDriver;
}

/** CLI binary name for each agent type. */
const AGENT_COMMANDS: Record<AgentType, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "npx",
  antigravity: "agy",
  custom: "",
};

/**
 * Detect whether an agent CLI is installed and available on PATH.
 * Handles both direct binaries (claude, codex) and npx-based tools (gemini).
 */
export async function detectAgent(type: AgentType): Promise<AgentDetection> {
  const cmd = AGENT_COMMANDS[type];
  if (!cmd) {
    return { available: false };
  }

  const spawnEnv = { ...process.env, PATH: ENRICHED_PATH };

  // Gemini is invoked via npx — check if the package is available
  if (type === "gemini") {
    try {
      const proc = Bun.spawnSync(["npx", "-y", "@google/gemini-cli", "--version"], {
        timeout: 15_000,
        env: spawnEnv,
      });
      const out = new TextDecoder().decode(proc.stdout).trim();
      if (proc.exitCode === 0 && out) {
        return { available: true, version: out.split("\n")[0], path: "npx" };
      }
    } catch { /* ok */ }
    return { available: false };
  }

  // MULTIAGENTS_ANTIGRAVITY_COMMAND may name another binary plus leading arguments
  const command = type === "antigravity" ? antigravityCommand() : [cmd];
  const which = Bun.spawnSync(["which", command[0]!], { env: spawnEnv });
  const binPath = new TextDecoder().decode(which.stdout).trim();

  if (which.exitCode !== 0 || !binPath) {
    return { available: false };
  }

  // Try to get version
  let version: string | undefined;
  try {
    const proc = Bun.spawnSync([binPath, ...command.slice(1), "--version"], { env: spawnEnv, timeout: 15_000 });
    const out = new TextDecoder().decode(proc.stdout).trim();
    if (proc.exitCode === 0 && out) {
      version = out.split("\n")[0];
    }
  } catch {
    // Version detection is best-effort
  }

  return { available: true, version, path: binPath };
}

/**
 * Build the MCP server config for multiagents, specific to an agent type.
 * Returns the command + args needed to run the MCP server.
 */
export function mcpServerCommand(agentType: AgentType): { command: string; args: string[] } {
  return {
    command: "bun",
    args: [CLI_PATH, "mcp-server", "--agent-type", agentType],
  };
}

/** The MCP config the Antigravity CLI, app and IDE share (https://antigravity.google/docs/mcp). */
export function antigravityMcpConfigPath(): string {
  return path.join(process.env.HOME ?? "", ".gemini", "config", "mcp_config.json");
}

/**
 * The adapter this install runs for Antigravity. The runtime path is absolute
 * so the entry also works where the host's PATH lacks bun.
 */
export function antigravityMcpServer(): { command: string; args: string[] } {
  return {
    command: Bun.which("bun", { PATH: ENRICHED_PATH }) ?? process.execPath,
    args: [path.resolve(import.meta.dir, "..", "server.ts"), "--agent-type", "antigravity"],
  };
}

type McpConfigFile = { raw: string; config: Record<string, unknown>; servers: Record<string, unknown> };

/** Parses an Antigravity MCP config; a missing or empty file is an empty config, anything else unreadable is null. */
async function readAntigravityMcpConfig(configPath: string): Promise<McpConfigFile | null> {
  let raw = "";
  try { raw = await Bun.file(configPath).text(); } catch { /* not created yet */ }
  if (!raw.trim()) return { raw, config: {}, servers: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const config = parsed as Record<string, unknown>;
  return { raw, config, servers: { ...((config.mcpServers as Record<string, unknown> | undefined) ?? {}) } };
}

async function writeAntigravityMcpConfig(configPath: string, file: McpConfigFile): Promise<void> {
  const next = JSON.stringify({ ...file.config, mcpServers: file.servers }, null, 2);
  if (next === file.raw) return;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  await Bun.write(configPath, next);
}

/**
 * Register multiagents-peer for Antigravity agents working in `projectDir`.
 * agy has no per-launch MCP flag; it loads <workspace>/.agents/mcp_config.json
 * and the global file, where a same-named global entry wins (agy 1.5.13). The
 * project file gets the entry; the global one is only repaired when it already
 * holds an entry that would shadow it or load the tools a second time.
 */
async function ensureAntigravityMcpConfig(projectDir: string, portOverride: string | null): Promise<void> {
  const workspacePath = path.join(projectDir, ".agents", "mcp_config.json");
  const workspace = await readAntigravityMcpConfig(workspacePath);
  if (!workspace) {
    throw new Error(`${workspacePath} is not a valid JSON object — fix or remove it, then launch the Antigravity agent again`);
  }
  delete workspace.servers["multiagents"];
  workspace.servers["multiagents-peer"] = antigravityPeerEntry(workspace.servers["multiagents-peer"], portOverride);
  await writeAntigravityMcpConfig(workspacePath, workspace);

  const globalPath = antigravityMcpConfigPath();
  const global = await readAntigravityMcpConfig(globalPath);
  if (!global) {
    log(LOG_PREFIX, `${globalPath} is not valid JSON — left as it is`);
    return;
  }
  const shadowing = global.servers["multiagents-peer"];
  if (!shadowing && !("multiagents" in global.servers)) return;
  delete global.servers["multiagents"];
  if (shadowing) global.servers["multiagents-peer"] = antigravityPeerEntry(shadowing, portOverride);
  await writeAntigravityMcpConfig(globalPath, global);
}

/** An existing multiagents-peer entry pointed at this install and the launcher's broker port; its other settings stay. */
function antigravityPeerEntry(existing: unknown, portOverride: string | null): Record<string, unknown> {
  const entry: Record<string, unknown> = { ...(existing as Record<string, unknown> | undefined), ...antigravityMcpServer() };
  const env = { ...((entry.env as Record<string, string> | undefined) ?? {}) };
  if (portOverride) env.MULTIAGENTS_PORT = portOverride; else delete env.MULTIAGENTS_PORT;
  if (Object.keys(env).length > 0) entry.env = env; else delete entry.env;
  return entry;
}

type TomlTable = { head: string; lines: string[] };

/** Splits TOML into its tables, each running from its header line to the next line that starts with `[`. */
function tomlTables(toml: string): TomlTable[] {
  const tables: TomlTable[] = [{ head: "", lines: [] }];
  for (const line of toml.split("\n")) {
    if (line.startsWith("[")) tables.push({ head: line.trim(), lines: [line] });
    else tables.at(-1)!.lines.push(line);
  }
  return tables;
}

const isMcpServerTable = (head: string, name: string) => head === `[mcp_servers.${name}]` || head === `[mcp_servers."${name}"]`;
const isUnderMcpServer = (head: string, name: string) => head.startsWith(`[mcp_servers.${name}.`) || head.startsWith(`[mcp_servers."${name}".`);

/**
 * ~/.codex/config.toml with a fresh multiagents-peer entry. The standalone
 * `multiagents` server that `multiagents setup` installs is left alone;
 * orchestrated threads switch it off themselves (see codexThreadConfig).
 */
export function rewriteCodexMcpConfig(toml: string, peer: { args: string[]; port: string | null }): string {
  const tables = tomlTables(toml);
  const hasStandalone = tables.some((t) => isMcpServerTable(t.head, "multiagents"));
  // Tool tables whose server is gone make Codex fail with "invalid transport".
  const kept = tables.filter((t) => !isMcpServerTable(t.head, "multiagents-peer") && (hasStandalone || !isUnderMcpServer(t.head, "multiagents")));
  const envLine = peer.port ? `env = { MULTIAGENTS_PORT = ${JSON.stringify(peer.port)} }\n` : "";
  // Agents run with approval_policy "never", under which Codex denies MCP tool
  // calls that would need approval; the team tools must be pre-approved.
  const entry = `\n[mcp_servers."multiagents-peer"]\ncommand = "bun"\nargs = [${peer.args.map((a) => JSON.stringify(a)).join(", ")}]\ndefault_tools_approval_mode = "approve"\n${envLine}`;
  return kept.flatMap((t) => t.lines).join("\n").trimEnd() + "\n" + entry;
}

/** The thread override that keeps a configured standalone server from loading next to multiagents-peer. */
export function codexThreadConfigFor(toml: string): Record<string, unknown> | undefined {
  // Codex rejects the override for a server it does not know ("invalid transport"), so it is only sent when the table exists.
  return tomlTables(toml).some((t) => isMcpServerTable(t.head, "multiagents")) ? { "mcp_servers.multiagents.enabled": false } : undefined;
}

/** Config overrides for a Codex thread the orchestrator drives. */
export function codexThreadConfig(): Record<string, unknown> | undefined {
  try {
    return codexThreadConfigFor(fs.readFileSync(path.join(process.env.HOME ?? "", ".codex", "config.toml"), "utf-8"));
  } catch {
    return undefined;
  }
}

/**
 * Ensure the project directory has MCP configs and session file so spawned
 * agents auto-discover the multiagents MCP server and join the session.
 * Writes config files idempotently — preserves existing entries. The global
 * Codex/Gemini configs are only touched when launching that agent type (or
 * when no type is given), the Antigravity ones only for an Antigravity agent.
 */
export async function ensureMcpConfigs(projectDir: string, sessionId: string, agentType?: AgentType): Promise<void> {
  const writeCodex = agentType === undefined || agentType === "codex";
  const writeGemini = agentType === undefined || agentType === "gemini";
  const writeAntigravity = agentType === "antigravity";

  // --- Claude: .mcp.json ---
  const mcpJsonPath = path.join(projectDir, ".mcp.json");
  let mcpConfig: Record<string, unknown> = {};
  try {
    const existing = await Bun.file(mcpJsonPath).text();
    mcpConfig = JSON.parse(existing);
  } catch { /* file doesn't exist yet */ }

  const mcpServers = (mcpConfig.mcpServers as Record<string, unknown>) ?? {};
  const claudeMcp = mcpServerCommand("claude");
  // Use "multiagents-peer" to avoid collision with the globally-installed
  // "multiagents" server in ~/.claude.json. The global one is for standalone
  // use; this one is the per-agent server with slot/session env vars.
  delete mcpServers["multiagents"]; // Remove stale entries from older versions
  mcpServers["multiagents-peer"] = { command: claudeMcp.command, args: claudeMcp.args };
  mcpConfig.mcpServers = mcpServers;
  await Bun.write(mcpJsonPath, JSON.stringify(mcpConfig, null, 2));

  // --- Codex: ~/.codex/config.toml (GLOBAL, not project-level) ---
  // CRITICAL: Codex CLI only loads MCP servers from the GLOBAL config at
  // ~/.codex/config.toml. Project-level .codex/config.toml is ignored for
  // MCP server discovery, and `-c mcp_servers.*` overrides are silently
  // dropped. The ONLY way to inject MCP servers is the global config file.
  const portOverride = brokerPortOverride();
  if (writeCodex) {
    const codexGlobalDir = path.join(process.env.HOME ?? "", ".codex");
    if (!fs.existsSync(codexGlobalDir)) fs.mkdirSync(codexGlobalDir, { recursive: true });

    const codexTomlPath = path.join(codexGlobalDir, "config.toml");
    let codexToml = "";
    try { codexToml = await Bun.file(codexTomlPath).text(); } catch { /* ok */ }

    const codexMcp = mcpServerCommand("codex");
    await Bun.write(codexTomlPath, rewriteCodexMcpConfig(codexToml, { args: codexMcp.args, port: portOverride }));
  }

  // --- Gemini: ~/.gemini/settings.json ---
  const geminiSettingsPath = path.join(process.env.HOME ?? "", ".gemini", "settings.json");
  if (writeGemini) try {
    let geminiConfig: Record<string, unknown> = {};
    try {
      const existing = await Bun.file(geminiSettingsPath).text();
      geminiConfig = JSON.parse(existing);
    } catch { /* ok */ }

    const geminiMcpServers = (geminiConfig.mcpServers as Record<string, unknown>) ?? {};
    // Remove stale "multiagents" entries from older versions
    if (geminiMcpServers["multiagents"] && !geminiMcpServers["multiagents-peer"]) {
      delete geminiMcpServers["multiagents"];
    }
    if (!geminiMcpServers["multiagents-peer"]) {
      const geminiMcp = mcpServerCommand("gemini");
      geminiMcpServers["multiagents-peer"] = {
        command: geminiMcp.command,
        args: geminiMcp.args,
        ...(portOverride ? { env: { MULTIAGENTS_PORT: portOverride } } : {}),
      };
      geminiConfig.mcpServers = geminiMcpServers;
      await Bun.write(geminiSettingsPath, JSON.stringify(geminiConfig, null, 2));
    }
  } catch {
    // Gemini config is optional — skip if ~/.gemini doesn't exist
  }

  if (writeAntigravity) await ensureAntigravityMcpConfig(projectDir, portOverride);

  // --- Session file: .multiagents/session.json ---
  // The MCP adapter reads this to auto-join the correct session.
  const sessionDir = path.join(projectDir, ".multiagents");
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const sessionFilePath = path.join(sessionDir, "session.json");
  const sessionFile = {
    session_id: sessionId,
    created_at: new Date().toISOString(),
    broker_port: resolveBrokerPort(),
  };
  await Bun.write(sessionFilePath, JSON.stringify(sessionFile, null, 2));

  log(LOG_PREFIX, `MCP configs and session file ensured in ${projectDir}`);
}

/**
 * Auto-detect platform signals from task text, role description, and project dir.
 * Appends detected platform context to role_description so the adapter's
 * keyword matcher fires the correct role-specific practices.
 */
function enrichRoleDescription(config: AgentLaunchConfig, projectDir: string): string {
  const signal = `${config.initial_task} ${config.role_description} ${projectDir}`.toLowerCase();
  const platforms: string[] = [];

  if (/\b(react|next\.?js|vue|angular|svelte|web|frontend|html|css|tailwind|vite)\b/.test(signal))
    platforms.push("Web/Frontend");
  if (/\b(android|kotlin|gradle|jetpack|compose|apk)\b/.test(signal))
    platforms.push("Android");
  if (/\b(ios|swift|xcode|swiftui|uikit|xcodeproj|cocoapods)\b/.test(signal))
    platforms.push("iOS");
  if (/\b(api|backend|server|database|rest|graphql|microservice|express|fastapi|django|flask|hono)\b/.test(signal))
    platforms.push("Backend/API");
  if (/\b(cli|command.line|terminal|argv|yargs|commander)\b/.test(signal))
    platforms.push("CLI");

  let desc = config.role_description;
  const detected = platforms.filter(p => !desc.toLowerCase().includes(p.toLowerCase()));
  if (detected.length > 0) {
    desc += `\nPlatform context (auto-detected): ${detected.join(", ")}.`;
  }
  return desc;
}

/** Identity + instructions shared by every launch path. */
interface AgentIdentity {
  sessionId: string;
  projectDir: string;
  slotId: number;
  name: string;
  role: string;
  roleDescription: string;
}

/** Env for a spawned agent: enriched PATH, session/slot identity, no nested-Claude marker. */
function agentEnv(identity: AgentIdentity): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: ENRICHED_PATH,
    MULTIAGENTS_SESSION: identity.sessionId,
    MULTIAGENTS_ROLE: identity.role,
    MULTIAGENTS_NAME: identity.name,
    MULTIAGENTS_SLOT: String(identity.slotId),
  };
  // A Claude Code parent marks its environment; a child session must not look nested.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

/** Role-specific practices, tool hints and completion criteria for the system prompt. */
function rolePracticesText(role: string, roleDescription: string): string {
  const structured = getStructuredRolePractices(role, roleDescription);
  if (!structured) return "";
  return [
    "",
    "--- ROLE-SPECIFIC PRACTICES ---",
    structured.practices,
    "",
    "--- TOOL DISCOVERY ---",
    structured.toolHints,
    "",
    "--- YOUR COMPLETION CRITERIA ---",
    structured.completionCriteria,
    "You are NOT done until these criteria are met. Do NOT call signal_done prematurely.",
  ].join("\n");
}

/** How teammate messages reach the agent; `turn_driver` hosts only take a new prompt between turns. */
type DeliveryMode = "driver" | "turn_driver" | "inbox" | "channel";

const TURN_DRIVER_ARRIVAL = "While you work, teammate messages arrive inside multiagents-peer tool results under [PENDING MESSAGES], so call check_messages often; once your turn has ended they are delivered as user messages starting with [Teammate messages].";

/**
 * The task prompt every agent receives first. The startup instructions live
 * here (not only in MCP instructions) because agents start working before
 * they read tool descriptions.
 */
function buildTaskPrompt(identity: AgentIdentity, task: string, delivery: DeliveryMode): string {
  const arrival = {
    driver: "Teammate messages are delivered to you automatically as user messages starting with [Teammate messages]. Also call check_messages after any long operation.",
    turn_driver: TURN_DRIVER_ARRIVAL,
    inbox: `Teammate messages arrive inside tool results under [PENDING MESSAGES] and in .multiagents/inbox/${identity.name}.md.`,
    channel: "Teammate messages arrive as channel notifications and inside tool results under [PENDING MESSAGES].",
  }[delivery];

  return [
    `You are "${identity.name}", role: ${identity.role}.`,
    identity.roleDescription,
    "",
    `Your task: ${task}`,
    "",
    "╔══════════════════════════════════════════════════════════════╗",
    "║  MANDATORY: USE multiagents-peer MCP TOOLS — NOT OPTIONAL  ║",
    "╚══════════════════════════════════════════════════════════════╝",
    "",
    "You have an MCP server called 'multiagents-peer' with tools for team communication.",
    "These are NOT optional. You MUST call them. Your team is BLOCKED until you do.",
    arrival,
    "",
    "STEP 1 — DO THESE FIRST (before ANY other work, before reading files, before running commands):",
    "  → Call set_summary with a 1-line description of your task",
    "  → Call check_team_status to see your teammates",
    "  → Call get_plan to see the team plan",
    "  → Call query_knowledge to read decisions already made",
    "  → Call check_messages to read messages from teammates",
    "",
    "STEP 2 — WHILE WORKING (after EVERY file write, EVERY shell command, EVERY build):",
    "  → Call check_messages — teammates may have sent you critical info",
    "  → Call set_summary with what you're currently doing",
    "  → Call update_plan when you start or finish a plan item",
    "",
    "STEP 3 — WHEN DONE:",
    "  → Call signal_done with: what you built, what you tested, what the results were",
    "  → Stay active — call check_messages every 10 seconds waiting for review feedback",
    "  → If you get feedback: fix issues, then call signal_done again",
    "",
    "STEP 4 — WHEN TEAMMATES MESSAGE YOU:",
    "  → Reply IMMEDIATELY via send_message. They are waiting on you.",
    "  → If you need time, reply 'Working on it, will respond in ~N minutes'",
    "",
    "FAILURE MODES (your team will be stuck if you do these):",
    "  ✗ Working for 1+ minute without calling check_messages",
    "  ✗ Finishing work without calling signal_done",
    "  ✗ Receiving a message and not replying via send_message",
    "  ✗ Not calling set_summary — teammates can't see what you're doing",
    "  ✗ Using shell commands to read broker state instead of MCP tools",
    "",
    "The multiagents-peer MCP tools are: set_summary, check_messages, send_message,",
    "check_team_status, get_plan, update_plan, signal_done, submit_feedback, approve,",
    "list_peers, acquire_file, release_file, view_file_locks, get_history,",
    "store_knowledge, query_knowledge, remove_knowledge.",
    "Use THESE tools. Do NOT try to call the broker via CLI or HTTP — use the MCP tools.",
  ].join("\n");
}

/** Prompt for an agent restarted into an existing slot. */
function buildHandoffPrompt(identity: AgentIdentity, handoffTask: string, delivery: DeliveryMode): string {
  const arrival = delivery === "driver"
    ? "Teammate messages are delivered to you automatically as user messages starting with [Teammate messages]."
    : delivery === "turn_driver"
      ? TURN_DRIVER_ARRIVAL
      : `Teammate messages arrive inside tool results under [PENDING MESSAGES]${delivery === "inbox" ? ` and in .multiagents/inbox/${identity.name}.md` : ""}.`;
  return [
    `You are "${identity.name}", role: ${identity.role}.`,
    identity.roleDescription,
    "",
    handoffTask,
    "",
    "═══ MANDATORY: USE multiagents-peer MCP TOOLS ═══",
    arrival,
    "BEFORE any work: call set_summary, check_team_status, get_plan, query_knowledge, check_messages (in that order).",
    "AFTER every file write/shell command: call check_messages + set_summary.",
    "WHEN done: call signal_done with proof of what you did and tested.",
    "WHEN messaged: reply via send_message IMMEDIATELY — teammates are blocked on you.",
    "NEVER work 1+ minute without calling check_messages. NEVER finish without signal_done.",
    "Your team CANNOT see your work unless you use these MCP tools.",
  ].join("\n");
}

/**
 * Inline MCP config for a Claude agent. Slot/session identity goes in the
 * server args (Claude Code does not forward env to MCP servers reliably),
 * `alwaysLoad` keeps the team tools out of tool-search deferral, and
 * `--driver-mode` tells the adapter the orchestrator delivers messages.
 */
export function claudeMcpConfig(identity: AgentIdentity, opts: { driverMode: boolean }): Record<string, unknown> {
  const claudeMcp = mcpServerCommand("claude");
  const args = [
    ...claudeMcp.args,
    "--session", identity.sessionId,
    "--slot", String(identity.slotId),
    "--role", identity.role,
    "--name", identity.name,
  ];
  if (opts.driverMode) args.push("--driver-mode");
  const server: Record<string, unknown> = { command: claudeMcp.command, args, alwaysLoad: true };
  const port = brokerPortOverride();
  if (port) {
    args.push("--port", port);
    server.env = { MULTIAGENTS_PORT: port };
  }
  return { mcpServers: { "multiagents-peer": server } };
}

/** The broker port agents must use when it is not the default one. */
function brokerPortOverride(): string | null {
  const port = resolveBrokerPort();
  return port === DEFAULT_BROKER_PORT ? null : String(port);
}

/** System prompt appended to Claude's defaults: the full team protocol and role practices. */
export function claudeSystemPromptAppend(role: string, roleDescription: string): string {
  return `${FULL_PROTOCOL}\n${rolePracticesText(role, roleDescription)}`;
}

/** Developer instructions for a Codex thread: kept short, Codex slows down with large instructions. */
export function codexDeveloperInstructions(identity: AgentIdentity): string {
  return [
    `You are "${identity.name}", role: ${identity.role}.`,
    identity.roleDescription,
    "",
    "You have 'multiagents-peer' MCP tools: check_messages, send_message, set_summary, signal_done, check_team_status, get_plan, update_plan, submit_feedback, approve, query_knowledge, store_knowledge.",
    "Teammate messages are delivered to you automatically as user messages starting with [Teammate messages].",
    "When done: call signal_done with proof. Use set_summary to show progress.",
    SHORT_PROTOCOL,
  ].join("\n");
}

/** Spawn a Claude agent driver and hand it its first prompt (the turn runs in the background). */
async function spawnClaudeAgent(
  identity: AgentIdentity,
  firstPrompt: string,
  brokerClient: BrokerClient,
  resumeSessionId?: string,
): Promise<LaunchResult> {
  const spawnOpts = {
    cwd: identity.projectDir,
    env: agentEnv(identity),
    mcpConfig: claudeMcpConfig(identity, { driverMode: true }),
    appendSystemPrompt: claudeSystemPromptAppend(identity.role, identity.roleDescription),
    maxTurns: CLAUDE_MAX_TURNS,
    model: process.env.MULTIAGENTS_CLAUDE_MODEL || undefined,
  };

  // The session reports init only after its first message, so the prompt goes
  // in at spawn time and spawn resolves once the session is confirmed up.
  let driver: ClaudeDriver;
  if (resumeSessionId) {
    try {
      driver = await ClaudeDriver.spawn({ ...spawnOpts, resumeSessionId, firstPrompt });
    } catch (err) {
      log(LOG_PREFIX, `Resuming Claude session ${resumeSessionId} failed (${err instanceof Error ? err.message : err}) — starting fresh`);
      driver = await ClaudeDriver.spawn({ ...spawnOpts, firstPrompt });
    }
  } else {
    driver = await ClaudeDriver.spawn({ ...spawnOpts, firstPrompt });
  }

  await brokerClient.updateSlot({
    id: identity.slotId,
    context_patch: {
      claude_session_id: driver.sessionId,
      last_summary: `Starting: ${firstPrompt.slice(0, 100)}`,
      last_status: "working",
      updated_at: Date.now(),
    },
  });

  log(LOG_PREFIX, `Claude ${identity.name} (pid ${driver.pid}, session ${driver.sessionId}) started`);

  return { slotId: identity.slotId, pid: driver.pid, process: driver.process, claudeDriver: driver };
}

/**
 * Spawn a Codex agent driver. Two-phase startup: a short bootstrap turn gets
 * the thread id quickly (so messages can be forwarded), then the real task
 * runs as a second turn in the background.
 */
async function spawnCodexAgent(
  identity: AgentIdentity,
  taskPrompt: string,
  brokerClient: BrokerClient,
): Promise<LaunchResult> {
  // Codex strips custom env vars inside its sandbox, so the adapter discovers
  // its slot through this file (see BaseAdapter.registerDriverModePeer).
  const driverModeFile = path.join(identity.projectDir, ".multiagents", ".driver-mode");
  try {
    fs.writeFileSync(driverModeFile, JSON.stringify({
      slot_id: identity.slotId,
      session_id: identity.sessionId,
      role: identity.role,
      name: identity.name,
    }));
  } catch { /* best effort */ }

  const env = agentEnv(identity);
  env.MULTIAGENTS_DRIVER_MODE = "1";

  const driver = await CodexDriver.spawn(identity.projectDir, env);
  log(LOG_PREFIX, `CodexDriver spawned for ${identity.name} in slot ${identity.slotId}`);

  await brokerClient.updateSlot({ id: identity.slotId, status: "connected" });

  const bootstrapPrompt = `You are "${identity.name}" (${identity.role}). Acknowledge by replying: "Ready."`;

  void (async () => {
    try {
      const bootstrap = await driver.startSession({
        prompt: bootstrapPrompt,
        cwd: identity.projectDir,
        sandbox: "workspace-write",
        developerInstructions: codexDeveloperInstructions(identity),
        config: codexThreadConfig(),
      });
      log(LOG_PREFIX, `${identity.name} bootstrap complete: thread=${bootstrap.threadId} (${bootstrap.content.slice(0, 50)})`);

      await brokerClient.updateSlot({
        id: identity.slotId,
        context_patch: {
          codex_thread_id: bootstrap.threadId,
          last_summary: `Starting: ${taskPrompt.slice(0, 100)}`,
          last_status: "working",
          updated_at: Date.now(),
        },
      });

      const taskResult = await driver.reply(bootstrap.threadId, taskPrompt);
      log(LOG_PREFIX, `${identity.name} task turn complete: ${taskResult.content.slice(0, 100)}`);

      await brokerClient.updateSlot({
        id: identity.slotId,
        context_patch: {
          codex_thread_id: taskResult.threadId,
          last_summary: taskResult.content.slice(0, 200),
          last_status: "working",
          updated_at: Date.now(),
        },
      });
    } catch (err) {
      log(LOG_PREFIX, `${identity.name} startup failed: ${err}`);
    }
  })();

  return { slotId: identity.slotId, pid: driver.pid, process: driver.process, codexDriver: driver };
}

/**
 * Per-PID slot assignment file: the MCP server subprocess finds its slot through
 * its parent CLI's pid even when that CLI strips the MULTIAGENTS_* env vars.
 */
function writeSlotFile(identity: AgentIdentity, pid: number, opts: { driverMode?: boolean } = {}): string | null {
  try {
    const slotsDir = path.join(identity.projectDir, ".multiagents", "slots");
    if (!fs.existsSync(slotsDir)) fs.mkdirSync(slotsDir, { recursive: true });
    const file = path.join(slotsDir, `${pid}.json`);
    fs.writeFileSync(file, JSON.stringify({
      slot_id: identity.slotId,
      role: identity.role,
      name: identity.name,
      session_id: identity.sessionId,
      ...(opts.driverMode ? { driver_mode: true, host_started: processStartTime(pid) ?? undefined } : {}),
    }));
    return file;
  } catch {
    return null;
  }
}

/** Antigravity has no system-prompt flag, so the protocol and role practices ride on the first prompt. */
export function antigravityFirstPrompt(identity: AgentIdentity, prompt: string): string {
  return `${prompt}\n${FULL_PROTOCOL}\n${rolePracticesText(identity.role, identity.roleDescription)}`;
}

/** Spawn an Antigravity agent driver and hand it its first prompt (the turn runs in the background). */
async function spawnAntigravityAgent(
  identity: AgentIdentity,
  firstPrompt: string,
  brokerClient: BrokerClient,
  resumeConversationId?: string,
): Promise<LaunchResult> {
  const env = agentEnv(identity);
  env.MULTIAGENTS_DRIVER_MODE = "1";

  const start = (resume?: string) => AntigravityDriver.spawn({
    cwd: identity.projectDir,
    env,
    model: process.env.MULTIAGENTS_ANTIGRAVITY_MODEL || undefined,
    resumeConversationId: resume,
    firstPrompt: antigravityFirstPrompt(identity, firstPrompt),
    onSpawn: (pid) => {
      const slotFile = writeSlotFile(identity, pid, { driverMode: true });
      return slotFile ? () => fs.rmSync(slotFile, { force: true }) : undefined;
    },
  });

  let driver: AntigravityDriver;
  if (resumeConversationId) {
    try {
      driver = await start(resumeConversationId);
    } catch (err) {
      log(LOG_PREFIX, `Resuming Antigravity conversation ${resumeConversationId} failed (${err instanceof Error ? err.message : err}) — starting fresh`);
      driver = await start();
    }
  } else {
    driver = await start();
  }

  if (resumeConversationId && driver.conversationId !== resumeConversationId) {
    log(LOG_PREFIX, `Antigravity conversation ${resumeConversationId} is gone — ${identity.name} continues in a new one`);
  }

  try {
    await brokerClient.updateSlot({
      id: identity.slotId,
      context_patch: {
        antigravity_conversation_id: driver.conversationId,
        last_summary: `Starting: ${firstPrompt.slice(0, 100)}`,
        last_status: "working",
        updated_at: Date.now(),
      },
    });
  } catch (err) {
    // Nothing tracks the session yet, so it would run on unsupervised.
    await driver.kill();
    throw err;
  }

  log(LOG_PREFIX, `Antigravity ${identity.name} (pid ${driver.pid}, conversation ${driver.conversationId}) started`);

  return { slotId: identity.slotId, pid: driver.pid, process: driver.process, antigravityDriver: driver };
}

/** Spawn a one-shot Gemini (or custom) process; messages reach it through tool results. */
function spawnProcessAgent(agentType: AgentType, identity: AgentIdentity, taskPrompt: string): LaunchResult {
  const cmd = AGENT_COMMANDS[agentType];
  if (!cmd) {
    throw new Error(`No CLI command configured for agent type: ${agentType}`);
  }
  const proc = Bun.spawn([cmd, ...buildCliArgs(agentType, taskPrompt)], {
    cwd: identity.projectDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: agentEnv(identity),
  });

  writeSlotFile(identity, proc.pid);

  return { slotId: identity.slotId, pid: proc.pid, process: proc };
}

/**
 * Spawn an agent with the appropriate driver or process.
 *
 * Creates a slot in the broker, then launches the agent so its MCP adapter
 * joins that slot. Ensures MCP configs are present so agents can communicate
 * via the broker.
 */
export async function launchAgent(
  sessionId: string,
  projectDir: string,
  config: AgentLaunchConfig,
  brokerClient: BrokerClient,
): Promise<LaunchResult> {
  await ensureMcpConfigs(projectDir, sessionId, config.agent_type);

  const enrichedDescription = enrichRoleDescription(config, projectDir);

  const slot = await brokerClient.createSlot({
    session_id: sessionId,
    agent_type: config.agent_type,
    display_name: config.name,
    role: config.role,
    role_description: enrichedDescription,
  });

  log(LOG_PREFIX, `Created slot ${slot.id} for ${config.name} (${config.agent_type})`);

  if (config.file_ownership && config.file_ownership.length > 0) {
    await brokerClient.assignOwnership({
      session_id: sessionId,
      slot_id: slot.id,
      path_patterns: config.file_ownership,
      assigned_by: "orchestrator",
    });
  }

  // Record the slot in session.json so sandboxed agents can recover it even
  // if MULTIAGENTS_* env vars are stripped.
  const sessionFilePath = path.join(projectDir, ".multiagents", "session.json");
  try {
    let sessionFile: Record<string, unknown> = {};
    try { sessionFile = JSON.parse(fs.readFileSync(sessionFilePath, "utf-8")); } catch { /* ok */ }
    sessionFile.last_slot_id = slot.id;
    sessionFile.last_slot_name = config.name;
    fs.writeFileSync(sessionFilePath, JSON.stringify(sessionFile, null, 2));
  } catch { /* best effort — env vars are the primary mechanism */ }

  const identity: AgentIdentity = {
    sessionId,
    projectDir,
    slotId: slot.id,
    name: config.name,
    role: config.role,
    roleDescription: enrichedDescription,
  };

  switch (config.agent_type) {
    case "claude": {
      const result = await spawnClaudeAgent(identity, buildTaskPrompt(identity, config.initial_task, "driver"), brokerClient);
      log(LOG_PREFIX, `Launched ${config.name} (PID ${result.pid}) in slot ${slot.id}`);
      return result;
    }
    case "codex":
      return spawnCodexAgent(identity, [
        `You are "${config.name}", role: ${config.role}.`,
        enrichedDescription,
        "",
        config.initial_task,
        "",
        "After completing your task:",
        "  → Call signal_done (multiagents-peer MCP tool) with proof of what you did",
        "  → Call set_summary with a 1-line status update",
        "",
        "Focus on completing the task first. Use multiagents-peer MCP tools for team communication only when needed.",
      ].join("\n"), brokerClient);
    case "antigravity": {
      const result = await spawnAntigravityAgent(identity, buildTaskPrompt(identity, config.initial_task, "turn_driver"), brokerClient);
      log(LOG_PREFIX, `Launched ${config.name} (PID ${result.pid}) in slot ${slot.id}`);
      return result;
    }
    default: {
      const result = spawnProcessAgent(config.agent_type, identity, buildTaskPrompt(identity, config.initial_task, "inbox"));
      log(LOG_PREFIX, `Launched ${config.name} (PID ${result.pid}) in slot ${slot.id}`);
      return result;
    }
  }
}

/**
 * Relaunch an agent into an EXISTING disconnected slot (resume/respawn).
 * No new slot is created: the identity points at the existing slot and the
 * broker's registration logic reconnects the adapter to it. Claude sessions
 * and Antigravity conversations are resumed by id when the slot's snapshot
 * remembers one.
 */
export async function relaunchIntoSlot(
  sessionId: string,
  projectDir: string,
  slot: Slot,
  handoffTask: string,
  brokerClient: BrokerClient,
): Promise<LaunchResult> {
  await ensureMcpConfigs(projectDir, sessionId, slot.agent_type);

  const identity: AgentIdentity = {
    sessionId,
    projectDir,
    slotId: slot.id,
    name: slot.display_name ?? `Agent #${slot.id}`,
    role: slot.role ?? "general",
    roleDescription: enrichRoleDescription({
      agent_type: slot.agent_type,
      name: slot.display_name ?? `Agent #${slot.id}`,
      role: slot.role ?? "general",
      role_description: slot.role_description ?? "",
      initial_task: handoffTask,
    }, projectDir),
  };

  switch (slot.agent_type) {
    case "claude": {
      let resumeSessionId: string | undefined;
      try {
        resumeSessionId = JSON.parse(slot.context_snapshot ?? "{}").claude_session_id ?? undefined;
      } catch { /* no snapshot */ }
      const result = await spawnClaudeAgent(identity, buildHandoffPrompt(identity, handoffTask, "driver"), brokerClient, resumeSessionId);
      log(LOG_PREFIX, `Relaunched ${identity.name} (PID ${result.pid}) into existing slot ${slot.id}`);
      return result;
    }
    case "codex":
      return spawnCodexAgent(identity, buildHandoffPrompt(identity, handoffTask, "driver"), brokerClient);
    case "antigravity": {
      let resumeConversationId: string | undefined;
      try {
        resumeConversationId = JSON.parse(slot.context_snapshot ?? "{}").antigravity_conversation_id ?? undefined;
      } catch { /* no snapshot */ }
      const result = await spawnAntigravityAgent(identity, buildHandoffPrompt(identity, handoffTask, "turn_driver"), brokerClient, resumeConversationId);
      log(LOG_PREFIX, `Relaunched ${identity.name} (PID ${result.pid}) into existing slot ${slot.id}`);
      return result;
    }
    default: {
      const result = spawnProcessAgent(slot.agent_type, identity, buildHandoffPrompt(identity, handoffTask, "inbox"));
      log(LOG_PREFIX, `Relaunched ${identity.name} (PID ${result.pid}) into existing slot ${slot.id}`);
      return result;
    }
  }
}

/**
 * Build CLI arguments for the process-based agent types. Claude, Codex and
 * Antigravity are driven over their session protocols instead (see the drivers).
 */
export function buildCliArgs(agentType: AgentType, task: string): string[] {
  switch (agentType) {
    case "gemini": {
      // Gemini CLI is invoked via npx. MCP is configured at user level
      // (~/.gemini/settings.json) by ensureMcpConfigs. Use --approval-mode
      // yolo for fully autonomous operation, --sandbox for safety, and
      // --output-format stream-json for structured output parsing.
      return [
        "-y", "@google/gemini-cli",
        "--sandbox",
        "--approval-mode", "yolo",
        "--output-format", "stream-json",
        "--allowed-mcp-server-names", "multiagents-peer",
        "-p", task,
      ];
    }
    case "custom":
      return [task];
    default:
      throw new Error(`${agentType} agents are driven over their session protocol, not CLI args`);
  }
}

/**
 * Build a team context string listing all active slots in the session,
 * excluding the given slot. Used to orient a new or restarted agent.
 */
export async function buildTeamContext(
  sessionId: string,
  excludeSlotId: number,
  brokerClient: BrokerClient,
): Promise<string> {
  const slots = await brokerClient.listSlots(sessionId);
  const teammates = slots.filter((s) => s.id !== excludeSlotId && s.status === "connected");

  if (teammates.length === 0) {
    return "You are the first agent on this team. No other agents are active yet.";
  }

  const lines = ["Current team members:"];
  for (const s of teammates) {
    const name = s.display_name ?? `Agent #${s.id}`;
    const role = s.role ?? "unassigned";
    const status = s.paused ? "paused" : "active";
    lines.push(`  - ${name} (${s.agent_type}, slot ${s.id}): role="${role}", status=${status}`);
  }
  return lines.join("\n");
}

/**
 * Announce a new team member to all existing connected slots.
 * Sends a team_change message so agents can update their mental model.
 */
export async function announceNewMember(
  sessionId: string,
  newSlot: Slot,
  config: AgentLaunchConfig,
  brokerClient: BrokerClient,
): Promise<void> {
  const slots = await brokerClient.listSlots(sessionId);
  const peers = slots.filter((s) => s.id !== newSlot.id && s.status === "connected" && s.peer_id);

  const announcement = [
    `[Team Update] New member joined: "${config.name}"`,
    `  Role: ${config.role}`,
    `  Type: ${config.agent_type}`,
    `  Slot: ${newSlot.id}`,
    config.file_ownership?.length
      ? `  File ownership: ${config.file_ownership.join(", ")}`
      : "",
    `  Task: ${config.initial_task}`,
  ]
    .filter(Boolean)
    .join("\n");

  for (const peer of peers) {
    if (!peer.peer_id) continue;
    await brokerClient.sendMessage({
      from_id: "orchestrator",
      to_id: peer.peer_id,
      text: announcement,
      msg_type: "team_change",
      session_id: sessionId,
    });
  }

  log(LOG_PREFIX, `Announced ${config.name} to ${peers.length} existing agents`);
}
