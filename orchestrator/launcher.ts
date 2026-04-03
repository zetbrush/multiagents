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
interface LaunchResult {
  slotId: number;
  pid: number;
  process: Subprocess;
  /** Present only for Codex agents launched via `codex mcp-server` driver. */
  codexDriver?: import("./codex-driver.ts").CodexDriver;
  /** Codex thread ID for multi-turn continuation. */
  codexThreadId?: string;
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

  const which = Bun.spawnSync(["which", cmd], { env: spawnEnv });
  const binPath = new TextDecoder().decode(which.stdout).trim();

  if (which.exitCode !== 0 || !binPath) {
    return { available: false };
  }

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
  const codexEntry = `\n[mcp_servers."multiagents-peer"]\ncommand = "bun"\nargs = [${codexMcp.args.map(a => JSON.stringify(a)).join(", ")}]\n`;
  await Bun.write(codexTomlPath, codexToml.trimEnd() + "\n" + codexEntry);

  // --- Gemini: ~/.gemini/settings.json ---
  const geminiSettingsPath = path.join(process.env.HOME ?? "", ".gemini", "settings.json");
  try {
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
  // Codex/Gemini agents get file-based inbox instructions since they lack push notifications
  const isNonPushAgent = config.agent_type === "codex" || config.agent_type === "gemini";

  const taskPrompt = [
    `You are "${config.name}", role: ${config.role}.`,
    enrichedDescription,
    "",
    `Your task: ${config.initial_task}`,
    "",
    "╔══════════════════════════════════════════════════════════════╗",
    "║  MANDATORY: USE multiagents-peer MCP TOOLS — NOT OPTIONAL  ║",
    "╚══════════════════════════════════════════════════════════════╝",
    "",
    "You have an MCP server called 'multiagents-peer' with tools for team communication.",
    "These are NOT optional. You MUST call them. Your team is BLOCKED until you do.",
    "",
    "STEP 1 — DO THESE FIRST (before ANY other work, before reading files, before running commands):",
    "  → Call set_summary with a 1-line description of your task",
    "  → Call check_team_status to see your teammates",
    "  → Call get_plan to see the team plan",
    "  → Call check_messages to read messages from teammates",
    "",
    "STEP 2 — WHILE WORKING (after EVERY file write, EVERY shell command, EVERY build):",
    "  → Call check_messages — teammates may have sent you critical info",
    "  → Call set_summary with what you're currently doing",
    "  → Call update_plan when you start or finish a plan item",
    ...(isNonPushAgent ? [
      `  → Read .multiagents/inbox/${config.name}.md — messages arrive here in real-time`,
    ] : []),
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
    "list_peers, acquire_file, release_file, view_file_locks, get_history.",
    "Use THESE tools. Do NOT try to call the broker via CLI or HTTP — use the MCP tools.",
  ].join("\n");

  // Build env — enrich PATH for GUI-spawned contexts, unset CLAUDECODE for nesting
  const spawnEnv: Record<string, string | undefined> = {
    ...process.env,
    PATH: ENRICHED_PATH,
    MULTIAGENTS_SESSION: sessionId,
    MULTIAGENTS_ROLE: config.role,
    MULTIAGENTS_NAME: config.name,
    MULTIAGENTS_SLOT: String(slot.id),
  };
  delete spawnEnv.CLAUDECODE;

  // Update session file with slot info so sandboxed agents (Codex, Gemini)
  // can recover slot_id even if MULTIAGENTS_* env vars are stripped.
  // The adapter reads this as a fallback when env vars are absent.
  const sessionDir = path.join(projectDir, ".multiagents");
  const sessionFilePath = path.join(sessionDir, "session.json");
  try {
    let sessionFile: Record<string, unknown> = {};
    try { sessionFile = JSON.parse(fs.readFileSync(sessionFilePath, "utf-8")); } catch { /* ok */ }
    sessionFile.last_slot_id = slot.id;
    sessionFile.last_slot_name = config.name;
    fs.writeFileSync(sessionFilePath, JSON.stringify(sessionFile, null, 2));
  } catch { /* best effort — env vars are the primary mechanism */ }

  // --- Codex: use long-running `codex mcp-server` driver ---
  // Instead of single-shot `codex exec`, the driver keeps a persistent process
  // alive and uses `codex` / `codex-reply` MCP tools for multi-turn conversations.
  // The orchestrator pushes teammate messages via driver.reply().
  if (config.agent_type === "codex") {
    const { CodexDriver } = await import("./codex-driver.ts");

    // Write sentinel file for driver mode detection AND slot info.
    // Codex sandbox strips custom env vars, so file-based communication
    // is the only reliable mechanism for the MCP adapter to discover
    // its slot/session assignment.
    const driverModeFile = path.join(projectDir, ".multiagents", ".driver-mode");
    try {
      fs.writeFileSync(driverModeFile, JSON.stringify({
        slot_id: slot.id,
        session_id: sessionId,
        role: config.role,
        name: config.name,
      }));
    } catch { /* best effort */ }
    spawnEnv.MULTIAGENTS_DRIVER_MODE = "1"; // Also set env var as secondary signal

    const driver = await CodexDriver.spawn(projectDir, spawnEnv);
    log(LOG_PREFIX, `CodexDriver spawned for ${config.name} in slot ${slot.id}`);

    // Mark slot as connected immediately (the driver is alive)
    await brokerClient.updateSlot({
      id: slot.id,
      status: "connected",
    });

    // Build developer instructions — keep brief to minimize Codex context size.
    // Large developer instructions slow down Codex LLM generation significantly.
    const developerInstructions = [
      `You are "${config.name}", role: ${config.role}.`,
      enrichedDescription,
      "",
      "You have 'multiagents-peer' MCP tools: signal_done, set_summary, send_message, check_messages.",
      "When done: call signal_done with proof. Use set_summary to show progress.",
    ].join("\n");

    // --- Two-phase startup for fast threadId acquisition ---
    // Phase 1: Fast bootstrap turn (~5-9s) to get a threadId.
    //   Codex creates the thread and returns immediately.
    // Phase 2: Push the real task as a reply turn.
    //   This runs in the background. The orchestrator can forward
    //   teammate messages between turns because we have the threadId.
    //
    // Without this split, the entire task runs as turn 1 (can take
    // minutes for complex tasks), blocking message forwarding.
    const bootstrapPrompt = `You are "${config.name}" (${config.role}). Acknowledge by replying: "Ready."`;

    // Codex-specific task prompt: lightweight, action-focused.
    // Codex is slow per tool call (~10-30s each), so the heavy "MANDATORY MCP"
    // block causes it to burn minutes on MCP overhead before doing real work.
    // The developerInstructions already cover MCP tools — keep the task prompt
    // focused on the actual task with minimal MCP instructions.
    const codexTaskPrompt = [
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
    ].join("\n");

    const startPromise = (async () => {
      try {
        // Phase 1: fast bootstrap (~5-9s)
        const bootstrap = await driver.startSession({
          prompt: bootstrapPrompt,
          cwd: projectDir,
          sandbox: "workspace-write",
          developerInstructions,
        });
        log(LOG_PREFIX, `${config.name} bootstrap complete: thread=${bootstrap.threadId} (${bootstrap.content.slice(0, 50)})`);

        // Store threadId immediately — enables message forwarding
        await brokerClient.updateSlot({
          id: slot.id,
          context_snapshot: JSON.stringify({
            codex_thread_id: bootstrap.threadId,
            last_summary: `Starting: ${config.initial_task.slice(0, 100)}`,
            last_status: "working",
            updated_at: Date.now(),
          }),
        });

        // Phase 2: push real task as a reply turn (runs in background)
        const taskResult = await driver.reply(bootstrap.threadId, codexTaskPrompt);
        log(LOG_PREFIX, `${config.name} task turn complete: ${taskResult.content.slice(0, 100)}`);

        await brokerClient.updateSlot({
          id: slot.id,
          context_snapshot: JSON.stringify({
            codex_thread_id: taskResult.threadId,
            last_summary: taskResult.content.slice(0, 200),
            last_status: "working",
            updated_at: Date.now(),
          }),
        });
      } catch (err) {
        log(LOG_PREFIX, `${config.name} startup failed: ${err}`);
      }
    })();

    // Don't await — let both phases run in background
    return {
      slotId: slot.id,
      pid: driver.pid,
      process: driver.process,
      codexDriver: driver,
    };
  }

  // --- Claude / Gemini / Custom: traditional process spawn ---
  const args = buildCliArgs(config.agent_type, taskPrompt, spawnEnv);
  const cmd = AGENT_COMMANDS[config.agent_type];

  if (!cmd) {
    throw new Error(`No CLI command configured for agent type: ${config.agent_type}`);
  }

  const proc = Bun.spawn([cmd, ...args], {
    cwd: projectDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: spawnEnv,
  });

  // Write per-PID slot assignment file so the MCP server subprocess can
  // discover its slot even if env vars are stripped by the parent CLI.
  // The MCP adapter reads .multiagents/slots/<ppid>.json using process.ppid.
  try {
    const slotsDir = path.join(projectDir, ".multiagents", "slots");
    if (!fs.existsSync(slotsDir)) fs.mkdirSync(slotsDir, { recursive: true });
    fs.writeFileSync(
      path.join(slotsDir, `${proc.pid}.json`),
      JSON.stringify({ slot_id: slot.id, role: config.role, name: config.name, session_id: sessionId }),
    );
  } catch { /* best effort */ }

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
  const agentName = slot.display_name ?? `Agent #${slot.id}`;
  const isNonPush = slot.agent_type === "codex" || slot.agent_type === "gemini";
  const taskPrompt = [
    `You are "${agentName}", role: ${slot.role ?? "general"}.`,
    enrichedDescription,
    "",
    handoffTask,
    "",
    "═══ MANDATORY: USE multiagents-peer MCP TOOLS ═══",
    "BEFORE any work: call set_summary, check_team_status, get_plan, check_messages (in that order).",
    "AFTER every file write/shell command: call check_messages + set_summary.",
    "WHEN done: call signal_done with proof of what you did and tested.",
    "WHEN messaged: reply via send_message IMMEDIATELY — teammates are blocked on you.",
    ...(isNonPush ? [`Also read .multiagents/inbox/${agentName}.md for real-time messages.`] : []),
    "NEVER work 1+ minute without calling check_messages. NEVER finish without signal_done.",
    "Your team CANNOT see your work unless you use these MCP tools.",
  ].join("\n");

  const spawnEnv: Record<string, string | undefined> = {
    ...process.env,
    PATH: ENRICHED_PATH,
    MULTIAGENTS_SESSION: sessionId,
    MULTIAGENTS_ROLE: slot.role ?? undefined,
    MULTIAGENTS_NAME: slot.display_name ?? undefined,
    MULTIAGENTS_SLOT: String(slot.id),
  };
  delete spawnEnv.CLAUDECODE;

  const args = buildCliArgs(slot.agent_type, taskPrompt, spawnEnv);
  const cmd = AGENT_COMMANDS[slot.agent_type];

  if (!cmd) {
    throw new Error(`No CLI command configured for agent type: ${slot.agent_type}`);
  }

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
export function buildCliArgs(agentType: AgentType, task: string, env?: Record<string, string | undefined>): string[] {
  switch (agentType) {
    case "claude": {
      // Build inline MCP config JSON for --mcp-config.
      // CRITICAL: Use "multiagents-peer" — NOT "multiagents" — to avoid
      // collision with the globally-installed "multiagents" server in
      // ~/.claude.json (registered by install-mcp for standalone use).
      // If both use the same name, Claude Code's global config overrides
      // the inline one, and agents get the wrong MCP server.
      // Build MCP server command with slot/session info baked into args.
      // Claude Code spawns MCP servers as child processes — env vars from
      // the parent are NOT reliably forwarded. Pass them as CLI args instead.
      const claudeMcp = mcpServerCommand("claude");
      const mcpArgs = [...claudeMcp.args];
      if (env?.MULTIAGENTS_SESSION) mcpArgs.push("--session", env.MULTIAGENTS_SESSION);
      if (env?.MULTIAGENTS_SLOT) mcpArgs.push("--slot", env.MULTIAGENTS_SLOT);
      if (env?.MULTIAGENTS_ROLE) mcpArgs.push("--role", env.MULTIAGENTS_ROLE);
      if (env?.MULTIAGENTS_NAME) mcpArgs.push("--name", env.MULTIAGENTS_NAME);

      const mcpConfigJson = JSON.stringify({
        mcpServers: {
          "multiagents-peer": {
            command: claudeMcp.command,
            args: mcpArgs,
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
      // IMPORTANT: Codex CLI's `-c` flag does NOT support injecting MCP servers.
      // MCP servers are loaded exclusively from ~/.codex/config.toml (global).
      // The `-c mcp_servers.*` overrides are silently ignored.
      // MCP injection is handled by ensureMcpConfigs() writing to the global config.
      return [
        "exec",
        "--sandbox", "workspace-write",
        "--full-auto",
        "--json",
        "-c", 'model_reasoning_effort="high"',
        task,
      ];
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
        "--allowed-mcp-server-names", "multiagents-peer",
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
