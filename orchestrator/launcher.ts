// ============================================================================
// multiagents — Agent Launcher
// ============================================================================
// Spawns headless agent processes with appropriate CLI flags and env vars.
// Ensures each agent has MCP access to the multiagents tools for inter-agent
// communication through the broker.
// ============================================================================

import type { Subprocess } from "bun";
import type { AgentType, AgentLaunchConfig, ResolvedModelPolicy, Slot, TokenOptimizationConfig } from "../shared/types.ts";
import type { BrokerClient } from "../shared/broker-client.ts";
import { resolveModelPolicy } from "../shared/model-routing.ts";
import { log } from "../shared/utils.ts";
import { DEFAULT_BROKER_PORT } from "../shared/constants.ts";
import * as path from "node:path";
import * as fs from "node:fs";

const LOG_PREFIX = "launcher";

/** Resolved path to cli.ts — used to build MCP server commands. */
const CLI_PATH = path.resolve(import.meta.dir, "..", "cli.ts");

/**
 * Sweep for `cli.ts mcp-server` processes belonging to this session and kill
 * them, regardless of current parentage.
 *
 * killPidTreeVerified(pid) below only helps if the top-level agent process is
 * still alive (or was just alive) when we walk `pgrep -P`. For agy — unlike
 * claude/codex, which bake `--session <id>` into the mcp-server's own args —
 * the agent CLI exits and its mcp-server grandchild gets reparented (often
 * to PID 1) well before end_session/auto-end ever runs, especially since agy
 * turns tend to finish fast. By then `pgrep -P <original top-level pid>`
 * finds nothing: the grandchild's parent link is already gone.
 *
 * MULTIAGENTS_SESSION is set in spawnEnv on the top-level process and
 * inherited by every descendant it spawns — that inheritance is a property
 * of the process's own environment block, unaffected by reparenting. So
 * instead of walking ancestry, scan every running mcp-server process's
 * environment for this session's id.
 *
 * Linux-only (/proc/<pid>/environ), best-effort.
 */
/**
 * Kill a process and its full descendant tree (including the root pid itself),
 * verifying each target actually died and escalating to SIGKILL after a grace
 * period for any that ignored SIGTERM.
 *
 * Replaces the old pattern of `killProcessTree(pid); proc.kill()` at every
 * termination call site (remove_agent, end_session, auto-end): that pattern
 * fires-and-forgets SIGTERM with no verification, so a process that's
 * mid-syscall or otherwise slow to handle the signal is silently left running
 * — which is how ghost `codex app-server`/`mcp-server` processes were
 * observed surviving `end_session` even though the kill code "succeeded"
 * with no error. This is the single call site every terminator should use.
 *
 * Linux-only (`pgrep -P`, `/proc` not required here); best-effort — failures
 * are swallowed since this is cleanup, not correctness-critical.
 */
export async function killPidTreeVerified(rootPid: number): Promise<void> {
  const toVisit = [rootPid];
  const targets = new Set<number>([rootPid]);

  while (toVisit.length > 0) {
    const current = toVisit.pop()!;
    try {
      const result = Bun.spawnSync(["pgrep", "-P", String(current)]);
      const output = new TextDecoder().decode(result.stdout).trim();
      if (!output) continue;
      for (const line of output.split("\n")) {
        const childPid = parseInt(line, 10);
        if (!isNaN(childPid) && !targets.has(childPid)) {
          targets.add(childPid);
          toVisit.push(childPid);
        }
      }
    } catch { /* pgrep unavailable or process gone — best effort */ }
  }

  const isAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  // Leaves-first-ish ordering doesn't matter for SIGTERM (unlike the old
  // discovery-order kill) since we verify and escalate below regardless.
  for (const pid of targets) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
  }

  await new Promise((resolve) => setTimeout(resolve, 500));

  const survivors = [...targets].filter(isAlive);
  if (survivors.length > 0) {
    log(LOG_PREFIX, `SIGTERM ignored by pid(s) ${survivors.join(", ")} (rooted at ${rootPid}) — escalating to SIGKILL`);
    for (const pid of survivors) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    }
  }
}

export function killSessionMcpServers(sessionId: string): void {
  try {
    const result = Bun.spawnSync(["pgrep", "-f", "cli.ts mcp-server"]);
    const output = new TextDecoder().decode(result.stdout).trim();
    if (!output) return;
    for (const line of output.split("\n")) {
      const pid = parseInt(line, 10);
      if (isNaN(pid)) continue;
      try {
        const environ = fs.readFileSync(`/proc/${pid}/environ`, "latin1");
        if (environ.split("\0").includes(`MULTIAGENTS_SESSION=${sessionId}`)) {
          process.kill(pid, "SIGTERM");
        }
      } catch { /* process exited mid-scan, or /proc unavailable — skip */ }
    }
  } catch { /* pgrep unavailable — best effort */ }
}

/**
 * Build a PATH that includes common CLI installation directories.
 * GUI apps (like Claude Desktop) don't load shell profiles, so their PATH
 * is minimal (just /usr/bin:/bin:/usr/sbin:/sbin). This ensures `which`
 * and spawned child processes can find claude, codex, agy, bun, etc.
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
  agy: "agy",
  custom: "",
};

/**
 * Detect whether an agent CLI is installed and available on PATH.
 * Handles direct agent binaries (claude, codex, and agy).
 */
export async function detectAgent(type: AgentType): Promise<AgentDetection> {
  const cmd = AGENT_COMMANDS[type];
  if (!cmd) {
    return { available: false };
  }

  const spawnEnv = { ...process.env, PATH: ENRICHED_PATH };

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

  // --- Antigravity CLI: ~/.gemini/config/mcp_config.json ---
  const agyConfigDir = path.join(process.env.HOME ?? "", ".gemini", "config");
  const agyMcpConfigPath = path.join(agyConfigDir, "mcp_config.json");
  try {
    if (!fs.existsSync(agyConfigDir)) fs.mkdirSync(agyConfigDir, { recursive: true });
    let agyConfig: Record<string, unknown> = {};
    try {
      const existing = await Bun.file(agyMcpConfigPath).text();
      agyConfig = JSON.parse(existing);
    } catch (error) {
      // A missing file is expected. Preserve malformed user configuration
      // instead of replacing it with a new object.
      if (fs.existsSync(agyMcpConfigPath)) throw error;
    }

    const agyMcpServers = (agyConfig.mcpServers as Record<string, unknown>) ?? {};
    // Remove stale "multiagents" entries from older versions
    delete agyMcpServers["multiagents"];
    const agyMcp = mcpServerCommand("agy");
    agyMcpServers["multiagents-peer"] = {
      command: agyMcp.command,
      args: agyMcp.args,
    };
    agyConfig.mcpServers = agyMcpServers;
    await Bun.write(agyMcpConfigPath, JSON.stringify(agyConfig, null, 2));
  } catch {
    // Antigravity config is optional; launch can still continue without MCP.
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
  optimization: TokenOptimizationConfig = {},
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

  const modelPolicy = resolveModelPolicy(config, optimization);
  const cliPolicy = optimization.enabled === false ? undefined : modelPolicy;
  await brokerClient.updateSlot({
    id: slot.id,
    context_snapshot: JSON.stringify({
      optimization: modelPolicy,
      original_task: config.initial_task,
      last_status: "starting",
      updated_at: Date.now(),
    }),
  });
  log(LOG_PREFIX, `Optimizer selected ${modelPolicy.tier}/${modelPolicy.model ?? "provider-default"} (${modelPolicy.reasoning_effort}) for ${config.name}`);

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
  // Codex/AGY agents get file-based inbox instructions since they lack push notifications
  const isNonPushAgent = config.agent_type === "codex" || config.agent_type === "agy";

  const taskPrompt = [
    `You are "${config.name}", role: ${config.role}.`,
    enrichedDescription,
    `Task: ${config.initial_task}`,
    "Output discipline: keep summaries concise and omit repeated context.",
    "",
    "Coordinate through the multiagents-peer MCP server:",
    "- At start: set_summary, then check_team_status, get_plan and check_messages.",
    "- Check messages at meaningful milestones and reply when action is required.",
    "- Update your summary/plan only when status changes; do not report every command.",
    "- When complete, call signal_done once with changes and verification evidence.",
    ...(isNonPushAgent ? [`- Inbox fallback: .multiagents/inbox/${config.name}.md.`] : []),
  ].join("\n");

  // Build env — enrich PATH for GUI-spawned contexts, unset CLAUDECODE for nesting
  const spawnEnv: Record<string, string | undefined> = {
    ...process.env,
    PATH: ENRICHED_PATH,
    MULTIAGENTS_SESSION: sessionId,
    MULTIAGENTS_ROLE: config.role,
    MULTIAGENTS_ROLE_DESCRIPTION: enrichedDescription,
    MULTIAGENTS_NAME: config.name,
    MULTIAGENTS_SLOT: String(slot.id),
    MULTIAGENTS_TIER: cliPolicy?.tier,
    MULTIAGENTS_CODEX_VERBOSITY: cliPolicy ? (cliPolicy.tier === "expert" ? "medium" : "low") : undefined,
  };
  delete spawnEnv.CLAUDECODE;

  // Update session file with slot info so sandboxed agents (Codex, AGY)
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
    "Use multiagents-peer at milestones; call signal_done with concise verification evidence when done.",
    ].join("\n");

    // Codex-specific task prompt: lightweight, action-focused.
    // Codex is slow per tool call (~10-30s each), so the heavy "MANDATORY MCP"
    // block causes it to burn minutes on MCP overhead before doing real work.
    // The developerInstructions already cover MCP tools — keep the task prompt
    // focused on the actual task with minimal MCP instructions.
    const codexTaskPrompt = [
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
        // Start the real task directly. The old acknowledgement-only bootstrap
        // spent a full model turn without advancing the task.
        const taskResult = await driver.startSession({
          prompt: codexTaskPrompt,
          cwd: projectDir,
          sandbox: "workspace-write",
          developerInstructions,
          model: cliPolicy?.model,
          reasoningEffort: cliPolicy?.reasoning_effort,
        });
        log(LOG_PREFIX, `${config.name} task turn complete: thread=${taskResult.threadId}`);

        await brokerClient.updateSlot({
          id: slot.id,
          context_snapshot: JSON.stringify({
            optimization: modelPolicy,
            original_task: config.initial_task,
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

  // --- Claude / AGY / Custom: traditional process spawn ---
  const args = buildCliArgs(config.agent_type, taskPrompt, spawnEnv, cliPolicy);
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
      JSON.stringify({
        slot_id: slot.id,
        role: config.role,
        role_description: enrichedDescription,
        name: config.name,
        session_id: sessionId,
        tier: cliPolicy?.tier,
      }),
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
  const isNonPush = slot.agent_type === "codex" || slot.agent_type === "agy";
  const taskPrompt = [
    `You are "${agentName}", role: ${slot.role ?? "general"}.`,
    enrichedDescription,
    "",
    handoffTask,
    "",
    "Use multiagents-peer at meaningful milestones: check status/messages on start,",
    "update summary only when it changes, and call signal_done with verification when done.",
    ...(isNonPush ? [`Also read .multiagents/inbox/${agentName}.md for real-time messages.`] : []),
  ].join("\n");

  let storedPolicy: ResolvedModelPolicy | undefined;
  try { storedPolicy = JSON.parse(slot.context_snapshot ?? "{}").optimization; } catch { /* use provider defaults */ }

  const spawnEnv: Record<string, string | undefined> = {
    ...process.env,
    PATH: ENRICHED_PATH,
    MULTIAGENTS_SESSION: sessionId,
    MULTIAGENTS_ROLE: slot.role ?? undefined,
    MULTIAGENTS_ROLE_DESCRIPTION: enrichedDescription,
    MULTIAGENTS_NAME: slot.display_name ?? undefined,
    MULTIAGENTS_SLOT: String(slot.id),
    MULTIAGENTS_TIER: storedPolicy?.tier,
    MULTIAGENTS_CODEX_VERBOSITY: storedPolicy ? (storedPolicy.tier === "expert" ? "medium" : "low") : undefined,
  };
  delete spawnEnv.CLAUDECODE;

  const args = buildCliArgs(slot.agent_type, taskPrompt, spawnEnv, storedPolicy);
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
export function buildCliArgs(
  agentType: AgentType,
  task: string,
  env?: Record<string, string | undefined>,
  policy?: Pick<ResolvedModelPolicy, "model" | "reasoning_effort" | "max_output_tokens">,
): string[] {
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
      if (env?.MULTIAGENTS_ROLE_DESCRIPTION) mcpArgs.push("--role-description", env.MULTIAGENTS_ROLE_DESCRIPTION);
      if (env?.MULTIAGENTS_NAME) mcpArgs.push("--name", env.MULTIAGENTS_NAME);
      if (env?.MULTIAGENTS_TIER) mcpArgs.push("--tier", env.MULTIAGENTS_TIER);

      const mcpConfigJson = JSON.stringify({
        mcpServers: {
          "multiagents-peer": {
            command: claudeMcp.command,
            args: mcpArgs,
          },
        },
      });
      const args = [
        "--print",
        "--verbose",
        "--output-format", "stream-json",
        "--max-turns", "200",
        "--dangerously-skip-permissions",
        "--mcp-config", mcpConfigJson,
      ];
      if (policy?.model) args.push("--model", policy.model);
      if (policy?.reasoning_effort) args.push("--effort", policy.reasoning_effort);
      args.push("-p", task);
      return args;
    }
    case "codex": {
      // IMPORTANT: Codex CLI's `-c` flag does NOT support injecting MCP servers.
      // MCP servers are loaded exclusively from ~/.codex/config.toml (global).
      // The `-c mcp_servers.*` overrides are silently ignored.
      // MCP injection is handled by ensureMcpConfigs() writing to the global config.
      const args = [
        "exec",
        "--sandbox", "workspace-write",
        "--full-auto",
        "--json",
      ];
      if (policy?.model) args.push("--model", policy.model);
      args.push("-c", `model_reasoning_effort="${policy?.reasoning_effort ?? "high"}"`);
      args.push(task);
      return args;
    }
    case "agy": {
      // Antigravity CLI is a native binary. MCP is configured globally in
      // ~/.gemini/config/mcp_config.json by ensureMcpConfigs. Headless mode
      // uses the same stream-json output contract as the previous integration.
      const args = [
        "--sandbox",
        "--dangerously-skip-permissions",
        "--output-format", "stream-json",
      ];
      if (policy?.model) args.push("--model", policy.model);
      if (policy?.reasoning_effort) args.push("--effort", policy.reasoning_effort);
      args.push("-p", task);
      return args;
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
