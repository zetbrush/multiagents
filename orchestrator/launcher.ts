// ============================================================================
// multiagents — Agent Launcher
// ============================================================================
// Spawns agent processes and ensures each one has MCP access to the
// multiagents tools for inter-agent communication through the broker.
//
// Claude and Codex agents run under orchestrator drivers (long-lived headless
// sessions the orchestrator feeds messages into); Gemini runs as a one-shot
// `gemini -p` process that receives messages through tool results.
// ============================================================================

import type { Subprocess } from "bun";
import type { AgentType, AgentLaunchConfig, ApprovalMode, Slot } from "../shared/types.ts";
import type { BrokerClient } from "../shared/broker-client.ts";
import { log } from "../shared/utils.ts";
import { DEFAULT_BROKER_PORT } from "../shared/constants.ts";
import { resolveBrokerPort } from "../shared/broker-url.ts";
import { FULL_PROTOCOL, SHORT_PROTOCOL } from "../adapters/protocol-text.ts";
import { getStructuredRolePractices } from "../adapters/role-practices.ts";
import { ClaudeDriver, type ClaudeSession } from "./claude-driver.ts";
import { ApiDriver } from "./api-driver.ts";
import { getProvider, loadProviders } from "../shared/providers.ts";
import { CodexDriver } from "./codex-driver.ts";
import { CODEX_APPROVAL_POLICY, CLAUDE_PERMISSION_MODE, parseApprovalMode } from "./activity.ts";
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
  /** Present for Claude agents (driven over stream-json stdin) and API agents (same events). */
  claudeDriver?: ClaudeSession;
  /** Model, effort and approval mode the agent was launched with */
  settings?: { model?: string; effort?: string; approvalMode?: ApprovalMode };
}

/** CLI binary name for each agent type. */
const AGENT_COMMANDS: Record<AgentType, string> = {
  claude: "claude",
  codex: "codex",
  gemini: process.env.MULTIAGENTS_ANTIGRAVITY_PATH || process.env.MULTIAGENTS_GEMINI_PATH || "agy",
  api: "",
  custom: "",
};

/** Env vars that replace an agent's CLI binary (the drivers launch these instead). */
const COMMAND_OVERRIDES: Partial<Record<AgentType, string>> = {
  claude: "MULTIAGENTS_CLAUDE_COMMAND",
  codex: "MULTIAGENTS_CODEX_COMMAND",
  gemini: "MULTIAGENTS_ANTIGRAVITY_PATH",
};

/**
 * Detect whether an agent CLI is installed and available on PATH.
 * Handles both direct binaries (claude, codex) and npx-based tools (gemini).
 */
export async function detectAgent(type: AgentType): Promise<AgentDetection> {
  // API agents run in-process: available once a provider is configured
  if (type === "api") {
    const providers = loadProviders();
    return providers.length ? { available: true, version: providers.map((p) => p.name).join(", "), path: "api" } : { available: false };
  }
  const cmd = AGENT_COMMANDS[type];
  if (!cmd) {
    return { available: false };
  }

  const spawnEnv = { ...process.env, PATH: ENRICHED_PATH };

  // Gemini worker is upgraded to Antigravity CLI (agy)
  if (type === "gemini") {
    const agyCmd = (process.env.MULTIAGENTS_ANTIGRAVITY_PATH || AGENT_COMMANDS.gemini || "agy").trim();
    const which = Bun.spawnSync(["which", agyCmd.split(/\s+/)[0]!], { env: spawnEnv });
    const binPath = new TextDecoder().decode(which.stdout).trim();
    if (which.exitCode === 0 && binPath) {
      let version: string | undefined;
      try {
        const proc = Bun.spawnSync([binPath, "--version"], { env: spawnEnv });
        const out = new TextDecoder().decode(proc.stdout).trim();
        if (proc.exitCode === 0 && out) version = out.split("\n")[0];
      } catch { /* ok */ }
      return { available: true, version: version || "antigravity", path: binPath };
    }
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

  // An override is what gets launched, so it is what has to exist
  const overrideVar = COMMAND_OVERRIDES[type];
  const override = overrideVar ? process.env[overrideVar]?.trim() : undefined;
  const which = Bun.spawnSync(["which", override ? override.split(/\s+/)[0]! : cmd], { env: spawnEnv });
  const binPath = new TextDecoder().decode(which.stdout).trim();

  if (which.exitCode !== 0 || !binPath) {
    return { available: false };
  }
  if (override) return { available: true, version: `${overrideVar}=${override}`, path: binPath };

  // Try to get version
  let version: string | undefined;
  try {
    const proc = Bun.spawnSync([binPath, "--version"], { env: spawnEnv });
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

/**
 * Ensure the project directory has MCP configs and session file so spawned
 * agents auto-discover the multiagents MCP server and join the session.
 * Writes config files idempotently — preserves existing entries. The global
 * Codex/Gemini configs are only touched when launching that agent type
 * (or when no type is given).
 */
export async function ensureMcpConfigs(projectDir: string, sessionId: string, agentType?: AgentType): Promise<void> {
  const writeCodex = agentType === undefined || agentType === "codex";
  const writeGemini = agentType === undefined || agentType === "gemini";

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

    // Helper: remove a TOML section by header. Matches from the header line
    // up to (but not including) the next section header or end of file.
    // Uses `^[` anchor to detect next section — handles values containing `[`.
    const removeTomlSection = (toml: string, header: RegExp): string =>
      toml.replace(new RegExp(header.source + "\\n(?:(?!^\\[).)*", "ms"), "");

    // Remove stale "multiagents" entries AND their nested subsections (e.g.
    // [mcp_servers.multiagents.tools.check_messages] with approval_mode).
    // Without removing subsections, Codex sees tool configs for a server
    // with no command/url and fails with "invalid transport".
    while (codexToml.match(/^\[mcp_servers\.multiagents[.\]]/m)) {
      codexToml = removeTomlSection(codexToml, /^\[mcp_servers\.multiagents[^\-][^\]]*\]\s*$/m);
    }

    // Remove existing multiagents-peer section (will be re-added below with fresh path)
    if (codexToml.includes("multiagents-peer")) {
      codexToml = removeTomlSection(codexToml, /^\[mcp_servers[.]"?multiagents-peer"?\]\s*$/m);
    }
    const codexMcp = mcpServerCommand("codex");
    const codexEnvLine = portOverride ? `env = { MULTIAGENTS_PORT = ${JSON.stringify(portOverride)} }\n` : "";
    // Agents run with approval_policy "never", under which Codex denies MCP tool
    // calls that would need approval; the team tools must be pre-approved.
    const codexEntry = `\n[mcp_servers."multiagents-peer"]\ncommand = "bun"\nargs = [${codexMcp.args.map(a => JSON.stringify(a)).join(", ")}]\ndefault_tools_approval_mode = "approve"\n${codexEnvLine}`;
    await Bun.write(codexTomlPath, codexToml.trimEnd() + "\n" + codexEntry);
  }

  // --- Antigravity & Gemini MCP configs ---
  if (writeGemini) {
    const geminiMcp = mcpServerCommand("gemini");
    const mcpEntry = {
      command: geminiMcp.command,
      args: geminiMcp.args,
      ...(portOverride ? { env: { MULTIAGENTS_PORT: portOverride } } : {}),
    };

    // 1. Global Antigravity config: ~/.gemini/config/mcp_config.json
    try {
      const homeDir = process.env.HOME ?? "";
      const mcpConfigDir = path.join(homeDir, ".gemini", "config");
      if (!fs.existsSync(mcpConfigDir)) fs.mkdirSync(mcpConfigDir, { recursive: true });
      const mcpConfigPath = path.join(mcpConfigDir, "mcp_config.json");
      let mcpConfig: Record<string, unknown> = {};
      try {
        const existing = await Bun.file(mcpConfigPath).text();
        mcpConfig = JSON.parse(existing);
      } catch { /* ok */ }

      const mcpServers = (mcpConfig.mcpServers as Record<string, unknown>) ?? {};
      delete mcpServers["multiagents"];
      mcpServers["multiagents-peer"] = mcpEntry;
      mcpConfig.mcpServers = mcpServers;
      await Bun.write(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
    } catch { /* ok */ }

    // 2. Project-level Antigravity config: <projectDir>/.agents/mcp_config.json
    try {
      const agentsDir = path.join(projectDir, ".agents");
      if (!fs.existsSync(agentsDir)) fs.mkdirSync(agentsDir, { recursive: true });
      const projMcpConfigPath = path.join(agentsDir, "mcp_config.json");
      let projMcpConfig: Record<string, unknown> = {};
      try {
        const existing = await Bun.file(projMcpConfigPath).text();
        projMcpConfig = JSON.parse(existing);
      } catch { /* ok */ }

      const projMcpServers = (projMcpConfig.mcpServers as Record<string, unknown>) ?? {};
      projMcpServers["multiagents-peer"] = mcpEntry;
      projMcpConfig.mcpServers = projMcpServers;
      await Bun.write(projMcpConfigPath, JSON.stringify(projMcpConfig, null, 2));
    } catch { /* ok */ }

    // 3. Backward-compatible ~/.gemini/settings.json
    try {
      const geminiSettingsPath = path.join(process.env.HOME ?? "", ".gemini", "settings.json");
      let geminiConfig: Record<string, unknown> = {};
      try {
        const existing = await Bun.file(geminiSettingsPath).text();
        geminiConfig = JSON.parse(existing);
      } catch { /* ok */ }

      const geminiMcpServers = (geminiConfig.mcpServers as Record<string, unknown>) ?? {};
      if (geminiMcpServers["multiagents"] && !geminiMcpServers["multiagents-peer"]) {
        delete geminiMcpServers["multiagents"];
      }
      if (!geminiMcpServers["multiagents-peer"]) {
        geminiMcpServers["multiagents-peer"] = mcpEntry;
        geminiConfig.mcpServers = geminiMcpServers;
        await Bun.write(geminiSettingsPath, JSON.stringify(geminiConfig, null, 2));
      }
    } catch { /* ok */ }
  }

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
  /** Per-agent settings, kept in the slot snapshot so respawns reuse them */
  model?: string;
  effort?: string;
  approvalMode?: ApprovalMode;
  /** API agents: the provider to call */
  providerId?: string;
}

/** Model, effort and approval mode stored in a slot's snapshot. */
export function slotSettings(slot: Pick<Slot, "context_snapshot">): { model?: string; effort?: string; approvalMode: ApprovalMode; tokenLimit?: number; providerId?: string } {
  let snap: Record<string, unknown> = {};
  try { snap = JSON.parse(slot.context_snapshot ?? "{}") ?? {}; } catch { /* no snapshot */ }
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const limit = Number(snap.token_limit);
  return {
    model: text(snap.model),
    effort: text(snap.effort),
    approvalMode: parseApprovalMode(snap.approval_mode),
    tokenLimit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    providerId: text(snap.provider_id),
  };
}

function launchSettings(identity: AgentIdentity): NonNullable<LaunchResult["settings"]> {
  return { model: identity.model, effort: identity.effort, approvalMode: identity.approvalMode ?? "bypass" };
}

/** The mode a Claude session is launched in; "auto" is switched to once it runs. */
function claudeLaunchMode(mode: ApprovalMode): "bypassPermissions" | "acceptEdits" | "default" {
  return mode === "bypass" ? "bypassPermissions" : mode === "accept_edits" ? "acceptEdits" : "default";
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
  // In non-CI environments, inject proxy if needed and preserve localhost loopback
  if (!process.env.CI && !env.http_proxy && !env.HTTP_PROXY) {
    const proxyUrl = process.env.MULTIAGENTS_PROXY || "http://127.0.0.1:3067";
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.all_proxy = "socks5://127.0.0.1:3067";
    env.ALL_PROXY = "socks5://127.0.0.1:3067";
    env.no_proxy = "localhost,127.0.0.1,::1";
    env.NO_PROXY = "localhost,127.0.0.1,::1";
  }
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

/**
 * The task prompt every agent receives first. The startup instructions live
 * here (not only in MCP instructions) because agents start working before
 * they read tool descriptions.
 */
function buildTaskPrompt(identity: AgentIdentity, task: string, delivery: "driver" | "inbox" | "channel"): string {
  const arrival = {
    driver: "Teammate messages are delivered to you automatically as user messages starting with [Teammate messages]. Also call check_messages after any long operation.",
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
function buildHandoffPrompt(identity: AgentIdentity, handoffTask: string, delivery: "driver" | "inbox" | "channel"): string {
  const arrival = delivery === "driver"
    ? "Teammate messages are delivered to you automatically as user messages starting with [Teammate messages]."
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
export function claudeMcpConfig(identity: AgentIdentity, opts: { driverMode: boolean; agentType?: AgentType }): Record<string, unknown> {
  const claudeMcp = mcpServerCommand(opts.agentType ?? "claude");
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
    model: identity.model || process.env.MULTIAGENTS_CLAUDE_MODEL || undefined,
    effort: identity.effort,
    permissionMode: claudeLaunchMode(identity.approvalMode ?? "bypass"),
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

  return { slotId: identity.slotId, pid: driver.pid, process: driver.process, claudeDriver: driver, settings: launchSettings(identity) };
}

/** System prompt of an API agent: who it is, how its tools work, the team protocol. */
export function apiSystemPrompt(identity: AgentIdentity, providerName: string): string {
  return [
    `You are "${identity.name}", role: ${identity.role}, a member of a multi-agent team. You run on ${providerName}.`,
    identity.roleDescription,
    "",
    `Your working directory is ${identity.projectDir}; file tools (Read, Write, Edit, LS, Glob, Grep) and Bash work inside it. WebFetch reads web pages.`,
    "Team tools (send_message, check_messages, set_summary, signal_done, check_team_status, get_plan, update_plan, submit_feedback, approve, store_knowledge, query_knowledge…) are how you talk to teammates and the person — they only see what you send with them.",
    "Teammate messages arrive as user messages starting with [Teammate messages]. To answer the person, use send_message with to_id \"human\".",
    "Work in small steps: call a tool, read its result, decide the next step. Keep replies short; put details in files or messages.",
    "",
    claudeSystemPromptAppend(identity.role, identity.roleDescription),
  ].join("\n");
}

/** Start an API agent (OpenAI-compatible provider) in-process; its first turn runs in the background. */
async function spawnApiAgent(identity: AgentIdentity, firstPrompt: string, brokerClient: BrokerClient): Promise<LaunchResult> {
  const provider = getProvider(identity.providerId);
  if (!provider) throw new Error(`API provider "${identity.providerId ?? ""}" is not configured — add it under API providers first`);
  const model = identity.model || provider.default_model;
  if (!model) throw new Error(`Pick a model for ${provider.name} (no default model is set)`);
  const server = claudeMcpConfig(identity, { driverMode: true, agentType: "api" }).mcpServers as Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  const driver = await ApiDriver.spawn({
    cwd: identity.projectDir,
    env: agentEnv(identity),
    provider,
    model,
    effort: identity.effort,
    mcpServer: server["multiagents-peer"]!,
    systemPrompt: apiSystemPrompt(identity, provider.name),
    firstPrompt,
    permissionMode: CLAUDE_PERMISSION_MODE[identity.approvalMode ?? "bypass"],
  });
  await brokerClient.updateSlot({
    id: identity.slotId,
    context_patch: { provider_name: provider.name, last_summary: `Starting: ${firstPrompt.slice(0, 100)}`, last_status: "working", updated_at: Date.now() },
  });
  log(LOG_PREFIX, `API agent ${identity.name} on ${provider.name} (${model}) started`);
  return { slotId: identity.slotId, pid: driver.pid, process: driver.process, claudeDriver: driver, settings: launchSettings(identity) };
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
  driver.settings = { approvalPolicy: CODEX_APPROVAL_POLICY[identity.approvalMode ?? "bypass"], model: identity.model, effort: identity.effort };
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
        model: identity.model,
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

  return { slotId: identity.slotId, pid: driver.pid, process: driver.process, codexDriver: driver, settings: launchSettings(identity) };
}

/** Spawn a one-shot Gemini (or custom) process; messages reach it through tool results. */
function spawnProcessAgent(agentType: AgentType, identity: AgentIdentity, taskPrompt: string): LaunchResult {
  const cmd = AGENT_COMMANDS[agentType];
  if (!cmd) {
    throw new Error(`No CLI command configured for agent type: ${agentType}`);
  }
  const proc = Bun.spawn([cmd, ...buildCliArgs(agentType, taskPrompt, { model: identity.model })], {
    cwd: identity.projectDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: agentEnv(identity),
  });

  // Per-PID slot assignment file so the MCP server subprocess can discover its
  // slot even if env vars are stripped by the parent CLI (read via process.ppid).
  try {
    const slotsDir = path.join(identity.projectDir, ".multiagents", "slots");
    if (!fs.existsSync(slotsDir)) fs.mkdirSync(slotsDir, { recursive: true });
    fs.writeFileSync(
      path.join(slotsDir, `${proc.pid}.json`),
      JSON.stringify({ slot_id: identity.slotId, role: identity.role, name: identity.name, session_id: identity.sessionId }),
    );
  } catch { /* best effort */ }

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

  const approvalMode = parseApprovalMode(config.approval_mode);
  await brokerClient.updateSlot({
    id: slot.id,
    context_patch: {
      model: config.model ?? null, effort: config.effort ?? null, approval_mode: approvalMode,
      ...(config.agent_type === "api" ? { provider_id: config.provider ?? null, provider_name: getProvider(config.provider)?.name ?? null } : {}),
    },
  });

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
    model: config.model || undefined,
    effort: config.effort || undefined,
    approvalMode,
    providerId: config.provider || undefined,
  };

  switch (config.agent_type) {
    case "api":
      return spawnApiAgent(identity, buildTaskPrompt(identity, config.initial_task, "driver"), brokerClient);
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
 * are resumed by id when the slot's snapshot remembers one.
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
    ...slotSettings(slot),
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
    case "api":
      return spawnApiAgent(identity, buildHandoffPrompt(identity, handoffTask, "driver"), brokerClient);
    default: {
      const result = spawnProcessAgent(slot.agent_type, identity, buildHandoffPrompt(identity, handoffTask, "inbox"));
      log(LOG_PREFIX, `Relaunched ${identity.name} (PID ${result.pid}) into existing slot ${slot.id}`);
      return result;
    }
  }
}

/**
 * Build CLI arguments for the process-based agent types. Claude and Codex are
 * driven over their session protocols instead (see ClaudeDriver/CodexDriver).
 */
export function buildCliArgs(agentType: AgentType, task: string, opts: { model?: string } = {}): string[] {
  switch (agentType) {
    case "gemini": {
      // Upgraded to Antigravity CLI (`agy`).
      // Uses --dangerously-skip-permissions for fully autonomous operation
      // and --output-format stream-json for structured output parsing.
      const args = [
        "--dangerously-skip-permissions",
        "--output-format", "stream-json",
      ];
      const model = opts.model ?? process.env.MULTIAGENTS_ANTIGRAVITY_MODEL ?? process.env.MULTIAGENTS_GEMINI_MODEL;
      if (model) {
        args.push("--model", model);
      }
      args.push("-p", task);
      return args;
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
