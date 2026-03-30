// ============================================================================
// multiagents — Agent Launcher
// ============================================================================
// Spawns headless agent processes with appropriate CLI flags and env vars.
// Ensures each agent has MCP access to the multiagents tools for inter-agent
// communication through the broker.
// ============================================================================

import type { Subprocess } from "bun";
import type { AgentType, AgentLaunchConfig, Slot } from "../shared/types.ts";
import type { BrokerClient } from "../shared/broker-client.ts";
import { log } from "../shared/utils.ts";
import { DEFAULT_BROKER_PORT } from "../shared/constants.ts";
import * as path from "node:path";
import * as fs from "node:fs";

const LOG_PREFIX = "launcher";

/** Resolved path to cli.ts — used to build MCP server commands. */
const CLI_PATH = path.resolve(import.meta.dir, "..", "cli.ts");

/** Detection result for an agent CLI binary. */
interface AgentDetection {
  available: boolean;
  version?: string;
  path?: string;
}

/** Result of launching an agent process. */
interface LaunchResult {
  slotId: number;
  pid: number;
  process: Subprocess;
}

/** CLI binary name for each agent type. */
const AGENT_COMMANDS: Record<AgentType, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "npx",
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

  // Gemini is invoked via npx — check if the package is available
  if (type === "gemini") {
    try {
      const proc = Bun.spawnSync(["npx", "-y", "@google/gemini-cli", "--version"], {
        timeout: 15_000,
      });
      const out = new TextDecoder().decode(proc.stdout).trim();
      if (proc.exitCode === 0 && out) {
        return { available: true, version: out.split("\n")[0], path: "npx" };
      }
    } catch { /* ok */ }
    return { available: false };
  }

  const which = Bun.spawnSync(["which", cmd]);
  const binPath = new TextDecoder().decode(which.stdout).trim();

  if (which.exitCode !== 0 || !binPath) {
    return { available: false };
  }

  // Try to get version
  let version: string | undefined;
  try {
    const proc = Bun.spawnSync([cmd, "--version"]);
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
 * Writes config files idempotently — preserves existing entries.
 */
export async function ensureMcpConfigs(projectDir: string, sessionId: string): Promise<void> {
  // --- Claude: .mcp.json ---
  const mcpJsonPath = path.join(projectDir, ".mcp.json");
  let mcpConfig: Record<string, unknown> = {};
  try {
    const existing = await Bun.file(mcpJsonPath).text();
    mcpConfig = JSON.parse(existing);
  } catch { /* file doesn't exist yet */ }

  const mcpServers = (mcpConfig.mcpServers as Record<string, unknown>) ?? {};
  const claudeMcp = mcpServerCommand("claude");
  mcpServers["multiagents"] = { command: claudeMcp.command, args: claudeMcp.args };
  mcpConfig.mcpServers = mcpServers;
  await Bun.write(mcpJsonPath, JSON.stringify(mcpConfig, null, 2));

  // --- Codex: .codex/config.toml ---
  const codexDir = path.join(projectDir, ".codex");
  if (!fs.existsSync(codexDir)) fs.mkdirSync(codexDir, { recursive: true });

  const codexTomlPath = path.join(codexDir, "config.toml");
  let codexToml = "";
  try { codexToml = await Bun.file(codexTomlPath).text(); } catch { /* ok */ }

  // Add multiagents section if not present
  if (!codexToml.includes("[mcp_servers.multiagents]")) {
    const codexMcp = mcpServerCommand("codex");
    const entry = `\n[mcp_servers.multiagents]\ncommand = "bun"\nargs = [${codexMcp.args.map(a => JSON.stringify(a)).join(", ")}]\n`;
    await Bun.write(codexTomlPath, codexToml.trimEnd() + "\n" + entry);
  }

  // --- Gemini: ~/.gemini/settings.json ---
  const geminiSettingsPath = path.join(process.env.HOME ?? "", ".gemini", "settings.json");
  try {
    let geminiConfig: Record<string, unknown> = {};
    try {
      const existing = await Bun.file(geminiSettingsPath).text();
      geminiConfig = JSON.parse(existing);
    } catch { /* ok */ }

    const geminiMcpServers = (geminiConfig.mcpServers as Record<string, unknown>) ?? {};
    if (!geminiMcpServers["multiagents"]) {
      const geminiMcp = mcpServerCommand("gemini");
      geminiMcpServers["multiagents"] = {
        command: geminiMcp.command,
        args: geminiMcp.args,
      };
      geminiConfig.mcpServers = geminiMcpServers;
      await Bun.write(geminiSettingsPath, JSON.stringify(geminiConfig, null, 2));
    }
  } catch {
    // Gemini config is optional — skip if ~/.gemini doesn't exist
  }

  // --- Session file: .multiagents/session.json ---
  // The MCP adapter reads this to auto-join the correct session.
  const sessionDir = path.join(projectDir, ".multiagents");
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const sessionFilePath = path.join(sessionDir, "session.json");
  const sessionFile = {
    session_id: sessionId,
    created_at: new Date().toISOString(),
    broker_port: DEFAULT_BROKER_PORT,
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

/**
 * Spawn an agent as a background process with the appropriate CLI flags.
 *
 * Creates a slot in the broker, then spawns the agent process with env vars
 * so the agent's MCP adapter knows which session/slot to join.
 * Ensures MCP configs are present so agents can communicate via the broker.
 */
export async function launchAgent(
  sessionId: string,
  projectDir: string,
  config: AgentLaunchConfig,
  brokerClient: BrokerClient,
): Promise<LaunchResult> {
  // Ensure MCP configs and session file exist before spawning any agent
  await ensureMcpConfigs(projectDir, sessionId);

  // Enrich role_description with auto-detected platform context
  const enrichedDescription = enrichRoleDescription(config, projectDir);

  // Create a slot in the broker for this agent
  const slot = await brokerClient.createSlot({
    session_id: sessionId,
    agent_type: config.agent_type,
    display_name: config.name,
    role: config.role,
    role_description: enrichedDescription,
  });

  log(LOG_PREFIX, `Created slot ${slot.id} for ${config.name} (${config.agent_type})`);

  // Assign file ownership if specified
  if (config.file_ownership && config.file_ownership.length > 0) {
    await brokerClient.assignOwnership({
      session_id: sessionId,
      slot_id: slot.id,
      path_patterns: config.file_ownership,
      assigned_by: "orchestrator",
    });
  }

  // Build the task prompt with role context (using enriched description)
  // CRITICAL: The startup instructions MUST be in the task prompt (not just MCP instructions)
  // because agents read the -p flag first and may start working before MCP tools load.
  // Without explicit enforcement here, agents execute their task using native tools only
  // and never call check_messages, set_summary, or signal_done.
  const taskPrompt = [
    `You are "${config.name}", role: ${config.role}.`,
    enrichedDescription,
    "",
    `Your task: ${config.initial_task}`,
    "",
    "MANDATORY STARTUP SEQUENCE (do these FIRST, before any other work):",
    "1. Call the multiagents MCP tool set_summary with a brief description of your task",
    "2. Call check_team_status to see your teammates and their roles",
    "3. Call get_plan to see the team plan and your assigned items",
    "4. Call check_messages to read any messages from teammates",
    "5. ONLY THEN begin your work",
    "",
    "MANDATORY ONGOING: Call check_messages after every major action (file write, build, test run).",
    "When your work is complete: call signal_done with a summary of what you did and test results.",
    "NEVER work silently — your teammates depend on your status updates via set_summary and messages.",
  ].join("\n");

  // Build CLI args based on agent type
  const args = buildCliArgs(config.agent_type, taskPrompt);
  const cmd = AGENT_COMMANDS[config.agent_type];

  if (!cmd) {
    throw new Error(`No CLI command configured for agent type: ${config.agent_type}`);
  }

  // Build env — unset CLAUDECODE to allow nested Claude sessions
  const spawnEnv: Record<string, string | undefined> = {
    ...process.env,
    MULTIAGENTS_SESSION: sessionId,
    MULTIAGENTS_ROLE: config.role,
    MULTIAGENTS_NAME: config.name,
    MULTIAGENTS_SLOT: String(slot.id),
  };
  delete spawnEnv.CLAUDECODE;

  // Spawn the agent process
  // stdin MUST be "pipe" for MCP stdio transport (bidirectional JSON-RPC)
  const proc = Bun.spawn([cmd, ...args], {
    cwd: projectDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: spawnEnv,
  });

  log(LOG_PREFIX, `Launched ${config.name} (PID ${proc.pid}) in slot ${slot.id}`);

  return {
    slotId: slot.id,
    pid: proc.pid,
    process: proc,
  };
}

/**
 * Relaunch an agent into an EXISTING disconnected slot.
 * Used by resume_session to restore agents without creating new slots.
 * The key difference from launchAgent(): no new slot is created — the
 * MULTIAGENTS_SLOT env var points to the existing slot.id, and the broker's
 * registration logic handles reconnection when slot_id is provided.
 */
export async function relaunchIntoSlot(
  sessionId: string,
  projectDir: string,
  slot: Slot,
  handoffTask: string,
  brokerClient: BrokerClient,
): Promise<LaunchResult> {
  await ensureMcpConfigs(projectDir, sessionId);

  // Enrich role_description with platform detection
  const enrichedDescription = enrichRoleDescription({
    agent_type: slot.agent_type,
    name: slot.display_name ?? `Agent #${slot.id}`,
    role: slot.role ?? "general",
    role_description: slot.role_description ?? "",
    initial_task: handoffTask,
  }, projectDir);

  // Build the task prompt with mandatory MCP enforcement
  const taskPrompt = [
    `You are "${slot.display_name ?? `Agent #${slot.id}`}", role: ${slot.role ?? "general"}.`,
    enrichedDescription,
    "",
    handoffTask,
    "",
    "MANDATORY: Call check_messages after every major action. Call signal_done when your work is complete. NEVER work silently.",
  ].join("\n");

  const args = buildCliArgs(slot.agent_type, taskPrompt);
  const cmd = AGENT_COMMANDS[slot.agent_type];

  if (!cmd) {
    throw new Error(`No CLI command configured for agent type: ${slot.agent_type}`);
  }

  const spawnEnv: Record<string, string | undefined> = {
    ...process.env,
    MULTIAGENTS_SESSION: sessionId,
    MULTIAGENTS_ROLE: slot.role ?? undefined,
    MULTIAGENTS_NAME: slot.display_name ?? undefined,
    MULTIAGENTS_SLOT: String(slot.id),
  };
  delete spawnEnv.CLAUDECODE;

  const proc = Bun.spawn([cmd, ...args], {
    cwd: projectDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: spawnEnv,
  });

  log(LOG_PREFIX, `Relaunched ${slot.display_name ?? `slot ${slot.id}`} (PID ${proc.pid}) into existing slot ${slot.id}`);

  return {
    slotId: slot.id,
    pid: proc.pid,
    process: proc,
  };
}

/**
 * Build CLI arguments for a specific agent type.
 *
 * Key design: each agent gets the multiagents MCP server injected so it can
 * communicate with teammates through the broker. For Claude this uses
 * --mcp-config (inline JSON); for Codex this uses -c to override the
 * mcp_servers config key (replacing any broken global entries).
 */
export function buildCliArgs(agentType: AgentType, task: string): string[] {
  switch (agentType) {
    case "claude": {
      // Build inline MCP config JSON for --mcp-config
      const claudeMcp = mcpServerCommand("claude");
      const mcpConfigJson = JSON.stringify({
        mcpServers: {
          "multiagents": {
            command: claudeMcp.command,
            args: claudeMcp.args,
          },
        },
      });
      return [
        "--print",
        "--verbose",
        "--output-format", "stream-json",
        "--max-turns", "200",
        "--dangerously-skip-permissions",
        "--mcp-config", mcpConfigJson,
        "-p", task,
      ];
    }
    case "codex": {
      // Inject multiagents MCP via dotted-path config overrides.
      // We ONLY add our own MCP server — never touch other user-configured servers.
      // The multiagents entry is already in ~/.codex/config.toml (written by install-mcp),
      // but we override here to ensure the spawned agent uses the correct binary path.
      const codexMcp = mcpServerCommand("codex");
      const argsJson = JSON.stringify(codexMcp.args);
      const overrides: string[] = [
        `mcp_servers.multiagents.command="${codexMcp.command}"`,
        `mcp_servers.multiagents.args=${argsJson}`,
        'model_reasoning_effort="high"',
      ];

      const args: string[] = [
        "exec",
        "--sandbox", "workspace-write",
        "--full-auto",
        "--json",
      ];
      for (const override of overrides) {
        args.push("-c", override);
      }
      args.push(task);
      return args;
    }
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
        "--allowed-mcp-server-names", "multiagents",
        "-p", task,
      ];
    }
    case "custom":
      return [task];
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
