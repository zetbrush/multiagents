#!/usr/bin/env bun
// ============================================================================
// multiagents — Orchestrator MCP Server
// ============================================================================
// MCP server for Claude Desktop that provides tools to manage a team of
// headless AI agents. Exposes create_team, status, broadcast, control, etc.
// ============================================================================

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Subprocess } from "bun";

import * as fs from "node:fs";
import { BrokerClient } from "../shared/broker-client.ts";
import type { AgentLaunchConfig } from "../shared/types.ts";
import { log, getGitRoot, slugify, formatDuration, safeJsonParse } from "../shared/utils.ts";
import {
  DEFAULT_BROKER_PORT,
  BROKER_HOSTNAME,
  GUARDRAIL_CHECK_INTERVAL,
  CONFLICT_CHECK_INTERVAL,
  FLAP_WINDOW_MS,
} from "../shared/constants.ts";

import { detectAgent, launchAgent, relaunchIntoSlot, announceNewMember, buildTeamContext } from "./launcher.ts";
import { getGuide, formatTopicList, type GuideTopic } from "./guide.ts";
import { monitorProcess, monitorCodexDriver, clearSlotTracking, clearAllTracking, type AgentEvent } from "./monitor.ts";
import { getTeamStatus, formatTeamStatusForDisplay } from "./progress.ts";
import { checkGuardrails, enforceGuardrails } from "./guardrails.ts";
import { handleAgentCrash, clearAllCrashHistory } from "./recovery.ts";
import { controlSession, broadcastToTeam, resolveTarget } from "./session-control.ts";

const LOG_PREFIX = "orchestrator";
const BROKER_URL = `http://${BROKER_HOSTNAME}:${DEFAULT_BROKER_PORT}`;

// Track active processes per session
const activeProcesses: Map<string, Map<number, Subprocess>> = new Map();
// Track pending events to push as notifications
const pendingEvents: AgentEvent[] = [];
// Track active CodexDriver instances: Map<sessionId, Map<slotId, state>>
import type { CodexDriver, CodexTurnResult } from "./codex-driver.ts";
interface CodexSlotState {
  driver: CodexDriver;
  threadId: string | null;
  /** True when a reply() is in flight (prevents double-dispatch). */
  busy: boolean;
  /** Timestamp of last steer nudge (prevents spam). */
  lastNudge: number;
}
const activeCodexDrivers: Map<string, Map<number, CodexSlotState>> = new Map();

// --- Dashboard auto-launch ---

const CLI_PATH = new URL("../cli.ts", import.meta.url).pathname;

/**
 * Launch the TUI dashboard in a new terminal window.
 * Tries macOS Terminal.app first via `open`, falls back to detached process.
 */
function launchDashboard(sessionId: string, projectDir: string): void {
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      // macOS: open a new Terminal.app tab running the dashboard
      const script = `tell application "Terminal" to do script "cd ${projectDir} && bun ${CLI_PATH} dashboard ${sessionId}"`;
      Bun.spawn(["osascript", "-e", script], {
        stdio: ["ignore", "ignore", "ignore"],
      }).unref();
    } else if (platform === "linux") {
      // Linux: try common terminal emulators
      for (const term of ["gnome-terminal", "xterm", "konsole"]) {
        const which = Bun.spawnSync(["which", term]);
        if (which.exitCode === 0) {
          Bun.spawn([term, "--", "bun", CLI_PATH, "dashboard", sessionId], {
            cwd: projectDir,
            stdio: ["ignore", "ignore", "ignore"],
          }).unref();
          break;
        }
      }
    }
    log(LOG_PREFIX, `Dashboard launched for session ${sessionId}`);
  } catch (e) {
    log(LOG_PREFIX, `Dashboard auto-launch failed (non-critical): ${e}`);
  }
}

// --- Broker lifecycle ---

async function ensureBroker(brokerClient: BrokerClient): Promise<void> {
  if (await brokerClient.isAlive()) {
    log(LOG_PREFIX, "Broker already running");
    return;
  }

  log(LOG_PREFIX, "Starting broker daemon...");
  const brokerScript = new URL("../broker.ts", import.meta.url).pathname;
  const proc = Bun.spawn(["bun", brokerScript], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await brokerClient.isAlive()) {
      log(LOG_PREFIX, "Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

// --- Event handler ---

function handleEvent(event: AgentEvent): void {
  log(LOG_PREFIX, `[${event.severity}] ${event.message}`);

  // Auto-respawn on crash (unless flapping)
  if (event.type === "agent_crashed" && event.data && !event.data.is_flapping) {
    const sessionMeta = activeSessions.get(event.sessionId);
    if (sessionMeta) {
      const brokerClient = new BrokerClient(BROKER_URL);
      handleAgentCrash(event.slotId, event.data.exit_code as number, event.sessionId, brokerClient)
        .then(async (crashEvent) => {
          pendingEvents.push(crashEvent);
          if (!crashEvent.data?.is_flapping) {
            try {
              const { respawnAgent } = await import("./recovery.ts");
              const result = await respawnAgent(event.sessionId, event.slotId, brokerClient, sessionMeta.projectDir);

              // CRITICAL: Track the new process and CodexDriver
              const sessionProcs = activeProcesses.get(event.sessionId);
              if (sessionProcs && result.process) {
                sessionProcs.set(event.slotId, result.process);
              }

              // If respawned as CodexDriver, track in activeCodexDrivers (not monitorProcess)
              if (result.codexDriver) {
                let drivers = activeCodexDrivers.get(event.sessionId);
                if (!drivers) {
                  drivers = new Map();
                  activeCodexDrivers.set(event.sessionId, drivers);
                }
                drivers.set(event.slotId, { driver: result.codexDriver, threadId: result.codexDriver.threadId, busy: false, lastNudge: 0 });
                monitorCodexDriver(result.codexDriver, event.slotId, event.sessionId, brokerClient, handleEvent);
                result.codexDriver.onExit(() => {
                  handleEvent({
                    type: "agent_crashed", severity: "critical",
                    slotId: event.slotId, sessionId: event.sessionId,
                    message: `Codex driver for slot ${event.slotId} exited after respawn`,
                    data: { exit_code: -1 },
                  });
                });
              } else {
                // Non-Codex: traditional process monitoring
                if (sessionProcs && result.process) {
                  monitorProcess(result.process, event.slotId, event.sessionId, brokerClient, handleEvent);
                }
              }
              log(LOG_PREFIX, `Auto-respawned slot ${event.slotId} (PID ${result.pid}${result.codexDriver ? ", CodexDriver" : ""})`);

              pendingEvents.push({
                type: "agent_restarted",
                severity: "info",
                slotId: event.slotId,
                sessionId: event.sessionId,
                message: `Slot ${event.slotId} auto-respawned after crash (PID ${result.pid})`,
              });
            } catch (err) {
              log(LOG_PREFIX, `Failed to auto-respawn slot ${event.slotId}: ${err}`);
            }
          }
        })
        .catch((err) => log(LOG_PREFIX, `Crash handler error: ${err}`));
    }
  } else if (event.type === "agent_completed" && event.data) {
    // Codex agents exit with code 0 when they finish their turn, but they may
    // not have actually completed their task. Check task_state — if the agent
    // hasn't signaled done (still "idle" or "addressing_feedback"), auto-respawn
    // with a continuation prompt so it picks up where it left off.
    const brokerClient = new BrokerClient(BROKER_URL);
    autoRestartIfIncomplete(event.slotId, event.sessionId, brokerClient)
      .then((restarted) => {
        if (!restarted) {
          pendingEvents.push(event);
        }
      })
      .catch((err) => {
        log(LOG_PREFIX, `Auto-restart check error: ${err}`);
        pendingEvents.push(event);
      });
  } else {
    pendingEvents.push(event);
  }
}

/** Flap detection for code-0 auto-restarts (separate from crash flap detection). */
const completionRestartHistory: Map<number, number[]> = new Map();
const COMPLETION_RESTART_LIMIT = 3; // max code-0 restarts in FLAP_WINDOW_MS

/** Check if a completed agent actually finished its task; if not, respawn it. */
async function autoRestartIfIncomplete(
  slotId: number,
  sessionId: string,
  brokerClient: BrokerClient,
): Promise<boolean> {
  try {
    const taskInfo = await brokerClient.getTaskState(slotId);
    const state = taskInfo.task_state;
    const name = taskInfo.display_name ?? `Slot ${slotId}`;

    // Only restart if the agent hasn't completed its work
    // "working" = actively implementing (was incorrectly "in_progress" before)
    if (state === "idle" || state === "working" || state === "addressing_feedback") {
      // Flap detection for code-0 exits — prevent infinite restart loops
      const now = Date.now();
      const history = completionRestartHistory.get(slotId) ?? [];
      const recent = history.filter((t) => now - t < FLAP_WINDOW_MS);
      recent.push(now);
      completionRestartHistory.set(slotId, recent);

      if (recent.length >= COMPLETION_RESTART_LIMIT) {
        log(LOG_PREFIX, `${name} hit code-0 restart limit (${recent.length} in 5 min) — stopping auto-restart`);
        pendingEvents.push({
          type: "agent_flapping",
          severity: "critical",
          slotId,
          sessionId,
          message: `${name} keeps exiting without completing work (${recent.length} restarts). Stopped auto-restart. Investigate why the agent exits early.`,
        });
        return false;
      }

      log(LOG_PREFIX, `${name} exited with code 0 but task_state="${state}" — auto-restarting (${recent.length}/${COMPLETION_RESTART_LIMIT})`);

      const sessionMeta = activeSessions.get(sessionId);
      if (!sessionMeta) {
        log(LOG_PREFIX, `No session metadata for ${sessionId}, cannot restart`);
        return false;
      }

      const { respawnAgent } = await import("./recovery.ts");
      const result = await respawnAgent(sessionId, slotId, brokerClient, sessionMeta.projectDir);

      // CRITICAL: Track the new process and CodexDriver
      const sessionProcesses = activeProcesses.get(sessionId);
      if (sessionProcesses && result.process) {
        sessionProcesses.set(slotId, result.process);
      }
      if (result.codexDriver) {
        let drivers = activeCodexDrivers.get(sessionId);
        if (!drivers) { drivers = new Map(); activeCodexDrivers.set(sessionId, drivers); }
        drivers.set(slotId, { driver: result.codexDriver, threadId: result.codexDriver.threadId, busy: false, lastNudge: 0 });
        monitorCodexDriver(result.codexDriver, slotId, sessionId, brokerClient, handleEvent);
        result.codexDriver.onExit(() => {
          handleEvent({
            type: "agent_crashed", severity: "critical", slotId, sessionId,
            message: `Codex driver for slot ${slotId} exited after code-0 respawn`,
            data: { exit_code: -1 },
          });
        });
      } else if (sessionProcesses && result.process) {
        monitorProcess(result.process, slotId, sessionId, brokerClient, handleEvent);
      }
      log(LOG_PREFIX, `Auto-restarted ${name} (PID ${result.pid}${result.codexDriver ? ", CodexDriver" : ""})`);

      pendingEvents.push({
        type: "agent_restarted",
        severity: "info",
        slotId,
        sessionId,
        message: `${name} auto-restarted (was task_state="${state}", exited code 0)`,
      });
      return true;
    }

    // Agent completed normally (done_pending_review, approved, released)
    log(LOG_PREFIX, `${name} completed with task_state="${state}" — no restart needed`);
    return false;
  } catch (err) {
    log(LOG_PREFIX, `Failed to check task state for slot ${slotId}: ${err}`);
    return false;
  }
}

/** Track session metadata for restart purposes. */
const activeSessions: Map<string, { projectDir: string }> = new Map();

// --- MCP Server Setup ---

const server = new Server(
  { name: "multiagents-orch", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// Tool definitions
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "create_team",
      description: `Create a new multi-agent team session. Launches headless agents with assigned roles and file ownership. The project_dir will be created if it does not exist, and git will be initialized if needed.

IMPORTANT — For best results, provide detailed role_descriptions including platform/framework, expertise, and constraints. The richer the description, the better the agent performs.

Recommended team compositions:
- Feature development: Software Engineer + Code Reviewer + QA Engineer
- UI feature: UI/UX Designer + Software Engineer + Code Reviewer + QA Engineer
- Bug fix: Software Engineer + QA Engineer

Core roles: 'Software Engineer', 'UI/UX Designer', 'QA Engineer', 'Code Reviewer'
Prefix with platform: 'Android Software Engineer', 'Web QA Engineer', 'iOS UI/UX Designer'

Each agent receives role-specific best practices, tool discovery hints, and completion criteria automatically based on their role name and description. Agents communicate bidirectionally and loop until all parties approve.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          project_dir: { type: "string", description: "Absolute path where agents will work. Will be created if it does not exist." },
          session_name: { type: "string", description: "Short name for this session. Used to generate session_id." },
          agents: {
            type: "array",
            items: {
              type: "object",
              properties: {
                agent_type: { type: "string", enum: ["claude", "codex", "gemini"] },
                name: { type: "string", description: "Display name for the agent, e.g., 'Alice' or 'Backend Engineer'" },
                role: { type: "string", description: "Core role: 'Software Engineer', 'UI/UX Designer', 'QA Engineer', 'Code Reviewer'. Prefix with platform for specificity: 'Android Software Engineer', 'Web QA Engineer'." },
                role_description: { type: "string", description: "Detailed role brief including platform (web/android/ios/cli/api), framework/stack, specific expertise, constraints, and acceptance criteria. The richer this is, the better the agent performs." },
                initial_task: { type: "string", description: "Specific task with acceptance criteria. Include what 'done' looks like, files to modify, APIs to use, and verification steps." },
                file_ownership: { type: "array", items: { type: "string" }, description: "Glob patterns for files this agent owns exclusively, e.g., 'src/auth/**'" },
              },
              required: ["agent_type", "name", "role", "role_description", "initial_task"],
            },
          },
          plan: {
            type: "array",
            description: "Plan items to track progress. Include review and QA tasks, not just implementation. Example: [{label: 'Implement auth API', agent_name: 'Engineer'}, {label: 'Review auth code', agent_name: 'Reviewer'}, {label: 'Test auth E2E', agent_name: 'QA'}]",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "What needs to be done" },
                agent_name: { type: "string", description: "Name of the agent assigned to this item" },
              },
              required: ["label"],
            },
          },
        },
        required: ["project_dir", "session_name", "agents"],
      },
    },
    {
      name: "get_team_status",
      description: "Get current status of all agents in a multiagents session — their roles, connection state, task state (idle/working/done/addressing_feedback), and what they are working on. Use the session_id returned by create_team.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
        },
        required: ["session_id"],
      },
    },
    {
      name: "broadcast_to_team",
      description: "Send a message to ALL connected agents in a multiagents session. Use for requirement changes, priority shifts, or announcements that every team member must see.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
          message: { type: "string" },
          exclude_roles: { type: "array", items: { type: "string" } },
        },
        required: ["session_id", "message"],
      },
    },
    {
      name: "direct_agent",
      description: "Send a direct message to a specific agent by name, role, or slot ID. The agent receives this as a peer message and must respond.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
          target: { type: "string", description: "Agent name, role, or slot ID" },
          message: { type: "string" },
        },
        required: ["session_id", "target", "message"],
      },
    },
    {
      name: "add_agent",
      description: "Spawn and add a new agent to an existing multiagents session. The agent auto-connects to the broker, receives team context, and gets role-specific best practices injected automatically based on role name and description.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
          agent_type: { type: "string", enum: ["claude", "codex", "gemini"] },
          name: { type: "string", description: "Display name for the agent" },
          role: { type: "string", description: "Core role: 'Software Engineer', 'UI/UX Designer', 'QA Engineer', 'Code Reviewer'. Prefix with platform for specificity." },
          role_description: { type: "string", description: "Detailed role brief including platform, framework, expertise, constraints. The richer this is, the better the agent performs." },
          initial_task: { type: "string", description: "Specific task with acceptance criteria. Include what 'done' looks like." },
          file_ownership: { type: "array", items: { type: "string" }, description: "Glob patterns for files this agent owns exclusively" },
        },
        required: ["session_id", "agent_type", "name", "role", "role_description", "initial_task"],
      },
    },
    {
      name: "remove_agent",
      description: "Gracefully stop and remove an agent from the session. Kills the CLI process and marks the slot as disconnected.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
          target: { type: "string", description: "Agent name, role, or slot ID" },
        },
        required: ["session_id", "target"],
      },
    },
    {
      name: "control_session",
      description: "Control a multiagents session. Actions: pause_all (pause every agent), resume_all (resume every agent), pause_agent (pause one by name/role), resume_agent (resume one), extend_budget (add minutes to time limit), set_budget (set exact time limit), status (get control state).",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
          action: { type: "string", enum: ["pause_all", "resume_all", "pause_agent", "resume_agent", "extend_budget", "set_budget", "status"] },
          target: { type: "string", description: "Agent name/role/slot for agent-level actions, or guardrail_id for set_budget" },
          value: { type: "number", description: "New value for budget actions" },
        },
        required: ["session_id", "action"],
      },
    },
    {
      name: "adjust_guardrail",
      description: "View or update multiagents session guardrail limits (e.g. max restarts per agent). Use action='view' to see all guardrails, action='update' to change one.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
          action: { type: "string", enum: ["view", "update"] },
          guardrail_id: { type: "string" },
          new_value: { type: "number" },
        },
        required: ["session_id", "action"],
      },
    },
    {
      name: "get_session_log",
      description: "Get the inter-agent message history for a multiagents session. Returns timestamped messages between agents with sender/recipient info.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
          limit: { type: "number" },
          since: { type: "number", description: "Epoch ms timestamp to get messages after" },
        },
        required: ["session_id"],
      },
    },
    {
      name: "release_agent",
      description: "Release a specific agent from the multiagents session, allowing it to disconnect. Only use after their work is approved and complete. Agents cannot self-disconnect — only the orchestrator can release them.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
          target: { type: "string", description: "Agent name, role, or slot ID" },
          message: { type: "string", description: "Optional release message" },
        },
        required: ["session_id", "target"],
      },
    },
    {
      name: "release_all",
      description: "Release ALL agents in a multiagents session, allowing them to disconnect. Use when the entire team's work is complete and production-grade.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
          message: { type: "string", description: "Optional release message" },
        },
        required: ["session_id"],
      },
    },
    {
      name: "end_session",
      description: "End a multiagents session: releases and stops all agents, archives the session. Use when the project is complete.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
          create_pr: { type: "boolean" },
        },
        required: ["session_id"],
      },
    },
    {
      name: "cleanup_dead_slots",
      description: "Remove disconnected/dead slots from a session that will never reconnect. Useful when crashed agents left stale slots behind.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
          keep_released: { type: "boolean", description: "If true, keep slots in 'released' state (default: false — removes all non-connected)" },
        },
        required: ["session_id"],
      },
    },
    {
      name: "list_sessions",
      description: "List all multiagents sessions (active, paused, archived). Use to discover sessions from previous conversations that can be resumed with resume_session.",
      inputSchema: {
        type: "object" as const,
        properties: {
          status_filter: { type: "string", enum: ["all", "active", "paused", "archived"], description: "Filter by session status. Default: all" },
        },
      },
    },
    {
      name: "resume_session",
      description: "Resume a previously paused or stopped multiagents session. Respawns all disconnected agents with their previous role, context, message history, and plan items. Use list_sessions first to find the session_id.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string", description: "Session ID to resume (from list_sessions)" },
          agents_to_skip: { type: "array", items: { type: "string" }, description: "Agent names or roles to NOT respawn (optional)" },
        },
        required: ["session_id"],
      },
    },
    {
      name: "delete_session",
      description: "Permanently delete a multiagents session and all its data (slots, messages, plans, file locks). Use when a session is no longer needed. Kills any running agents first. Cannot be undone.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string", description: "Session ID to delete (from list_sessions)" },
        },
        required: ["session_id"],
      },
    },
    {
      name: "get_guide",
      description: "Get comprehensive documentation and guidance for using multiagents. Call with no topic to see all available topics. Topics: overview, quickstart, roles, workflows, tools, session_lifecycle, troubleshooting, examples, best_practices. Start with 'quickstart' for a step-by-step tutorial.",
      inputSchema: {
        type: "object" as const,
        properties: {
          topic: { type: "string", enum: ["overview", "quickstart", "roles", "workflows", "tools", "session_lifecycle", "troubleshooting", "examples", "best_practices"], description: "Guide topic to read. Omit to see the topic list." },
        },
      },
    },
  ],
}));

// Tool implementations
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const brokerClient = new BrokerClient(BROKER_URL);

  try {
    switch (name) {
      // ---- create_team ----
      case "create_team": {
        const { project_dir, session_name, agents, plan: planItems } = args as {
          project_dir: string;
          session_name: string;
          agents: AgentLaunchConfig[];
          plan?: { label: string; agent_name?: string }[];
        };

        // Detect available agents — check ALL before failing, report what IS available
        const unavailable: { name: string; type: string }[] = [];
        const availableTypes = new Set<string>();
        for (const agentCfg of agents) {
          const detection = await detectAgent(agentCfg.agent_type);
          if (!detection.available) {
            unavailable.push({ name: agentCfg.name, type: agentCfg.agent_type });
          } else {
            availableTypes.add(agentCfg.agent_type);
          }
        }
        if (unavailable.length > 0) {
          // Check what IS available on this machine
          const allTypes: Array<"claude" | "codex" | "gemini"> = ["claude", "codex", "gemini"];
          for (const t of allTypes) {
            const d = await detectAgent(t);
            if (d.available) availableTypes.add(t);
          }
          const availableList = availableTypes.size > 0
            ? `Available agent CLIs on this machine: ${[...availableTypes].join(", ")}.`
            : "No agent CLIs found. Install claude, codex, or gemini CLI first.";
          const failedList = unavailable.map(u => `${u.name} (${u.type})`).join(", ");
          return {
            content: [{
              type: "text",
              text: `Cannot create team — the following agent CLIs are not installed: ${failedList}.\n\n${availableList}\n\nPlease adjust your team to only use available agent types, or install the missing CLIs.`,
            }],
          };
        }

        // Generate unique session ID — check existing sessions to avoid collisions
        let sessionId = slugify(session_name);
        try {
          const existing = await brokerClient.listSessions();
          const existingIds = new Set(existing.map((s: any) => s.id));
          if (existingIds.has(sessionId)) {
            // Append incrementing suffix until unique
            let i = 2;
            while (existingIds.has(`${sessionId}-${i}`)) i++;
            sessionId = `${sessionId}-${i}`;
          }
        } catch { /* broker may not support list yet — proceed with base slug */ }

        // Auto-create project directory if it doesn't exist
        if (!fs.existsSync(project_dir)) {
          fs.mkdirSync(project_dir, { recursive: true });
        }

        // Init git if not already a repo (needed for file coordination, but session works without it)
        let gitRoot = await getGitRoot(project_dir);
        if (!gitRoot) {
          try {
            const initProc = Bun.spawnSync(["git", "init"], { cwd: project_dir });
            if (initProc.exitCode === 0) {
              gitRoot = project_dir;
            }
          } catch { /* git not installed — session still works without it */ }
        }

        // Create session in broker
        await brokerClient.createSession({
          id: sessionId,
          name: session_name,
          project_dir,
          git_root: gitRoot,
        });

        const sessionProcs = new Map<number, Subprocess>();
        activeProcesses.set(sessionId, sessionProcs);
        activeSessions.set(sessionId, { projectDir: project_dir });

        // Launch each agent with staggered delays to prevent race conditions.
        // Codex agents share a global skills directory (~/.codex/system-skills/)
        // that gets corrupted when multiple instances initialize simultaneously.
        // Gemini via npx can also race on package caching.
        const launchedAgents: { name: string; slot_id: number; pid: number }[] = [];
        const launchedTypes = new Set<string>();
        for (const agentCfg of agents) {
          // Stagger if we've already launched an agent of this type
          if (launchedTypes.has(agentCfg.agent_type)) {
            await new Promise((r) => setTimeout(r, 3000));
          }
          launchedTypes.add(agentCfg.agent_type);

          const result = await launchAgent(sessionId, project_dir, agentCfg, brokerClient);
          sessionProcs.set(result.slotId, result.process);

          // Track CodexDriver instances for message forwarding
          if (result.codexDriver) {
            let sessionDrivers = activeCodexDrivers.get(sessionId);
            if (!sessionDrivers) {
              sessionDrivers = new Map();
              activeCodexDrivers.set(sessionId, sessionDrivers);
            }
            sessionDrivers.set(result.slotId, { driver: result.codexDriver, threadId: result.codexDriver.threadId, busy: false, lastNudge: 0 });
            monitorCodexDriver(result.codexDriver, result.slotId, sessionId, brokerClient, handleEvent);

            // Monitor driver process exit for auto-restart
            result.codexDriver.onExit(() => {
              handleEvent({
                type: "agent_crashed",
                severity: "critical",
                slotId: result.slotId,
                sessionId,
                message: `Codex driver for slot ${result.slotId} exited unexpectedly`,
                data: { exit_code: -1 },
              });
            });
          } else {
            // Start process monitoring for non-Codex agents (Claude, Gemini)
            monitorProcess(result.process, result.slotId, sessionId, brokerClient, handleEvent);
          }

          // Announce to previously launched agents
          const slot = await brokerClient.getSlot(result.slotId);
          await announceNewMember(sessionId, slot, agentCfg, brokerClient);

          launchedAgents.push({
            name: agentCfg.name,
            slot_id: result.slotId,
            pid: result.pid,
          });
        }

        // Create plan if provided, then broadcast to each agent with their assigned items
        let planSummary = "";
        if (planItems && planItems.length > 0) {
          const slotByName = new Map(launchedAgents.map((a) => [a.name, a.slot_id]));
          const lastAgentSlot = launchedAgents[launchedAgents.length - 1]?.slot_id;

          // Every plan item MUST have an assignee — unassigned items go to
          // the last agent in the list (responsible for final verification)
          const items = planItems.map((item) => {
            const resolved = item.agent_name ? slotByName.get(item.agent_name) : undefined;
            return {
              label: item.label,
              assigned_to_slot: resolved ?? lastAgentSlot,
            };
          });
          await brokerClient.createPlan({
            session_id: sessionId,
            title: session_name,
            items,
          });

          // Fetch the created plan to get actual item IDs
          const plan = await brokerClient.getPlan(sessionId);
          if (plan?.items) {
            // Send each agent their personalized plan context
            for (const agent of launchedAgents) {
              const myItems = plan.items.filter((i: any) => i.assigned_to_slot === agent.slot_id);
              if (myItems.length === 0) continue;

              const slot = await brokerClient.getSlot(agent.slot_id);
              if (!slot?.peer_id) continue;

              const itemLines = myItems.map((i: any) =>
                `  [ ] #${i.id}: ${i.label}`
              ).join("\n");

              await brokerClient.sendMessage({
                from_id: "orchestrator",
                to_id: slot.peer_id,
                text: `PLAN — Your assigned items:\n${itemLines}\n\nAs you complete each item, call: update_plan({item_id: <ID>, status: "done"}).\nCall get_plan to see the full plan anytime.`,
                msg_type: "system",
                session_id: sessionId,
              });
            }
          }

          planSummary = `\nPlan: ${planItems.length} items tracked.`;
        }

        const status = await getTeamStatus(sessionId, brokerClient);
        const display = formatTeamStatusForDisplay(status);

        // Auto-launch dashboard in a new terminal
        launchDashboard(sessionId, project_dir);

        return {
          content: [{
            type: "text",
            text: [
              `Session "${sessionId}" created with ${launchedAgents.length} agents.${planSummary}`,
              "",
              display,
              "",
              "IMPORTANT: Agents take 15-60 seconds to start up (loading MCP servers, connecting to broker).",
              "They will show as 'starting' until they register. This is NORMAL — do NOT call cleanup_dead_slots",
              "or assume agents have crashed. Wait at least 60 seconds before checking status.",
              "",
              `Dashboard launched — run \`multiagents dashboard ${sessionId}\` to reopen.`,
            ].join("\n"),
          }],
        };
      }

      // ---- get_team_status ----
      case "get_team_status": {
        const { session_id } = args as { session_id: string };
        const status = await getTeamStatus(session_id, brokerClient);
        const display = formatTeamStatusForDisplay(status);

        // Include any pending events
        const events = pendingEvents.splice(0, pendingEvents.length);
        const eventText = events.length > 0
          ? "\n\nRecent events:\n" + events.map((e) => `[${e.severity}] ${e.message}`).join("\n")
          : "";

        // Check for BLOCKED messages from agents to orchestrator
        let blockedText = "";
        try {
          const recentMsgs = await brokerClient.getMessageLog(session_id, { limit: 50 });
          const blockedMsgs = recentMsgs.filter((m: any) =>
            m.to_id === "orchestrator" && m.text && /BLOCKED|NEED HELP|ESCALAT/i.test(m.text)
          );
          if (blockedMsgs.length > 0) {
            blockedText = "\n\nBLOCKED AGENTS (need your help):\n" +
              blockedMsgs.slice(0, 5).map((m: any) => {
                const fromSlot = status.agents.find((a) => a.slot_id === m.from_slot_id);
                const fromName = fromSlot?.name ?? m.from_id;
                return `  [!] ${fromName}: ${m.text.slice(0, 200)}`;
              }).join("\n");
          }
        } catch { /* best effort */ }

        // Completion check: all agents approved → suggest releasing
        let completionText = "";
        const connectedAgents = status.agents.filter((a) => a.status === "connected");
        const allApproved = connectedAgents.length > 0 && connectedAgents.every((a) => a.task_state === "approved");
        const allDoneOrApproved = connectedAgents.length > 0 && connectedAgents.every((a) =>
          a.task_state === "approved" || a.task_state === "released"
        );
        if (allApproved) {
          completionText = "\n\nALL AGENTS APPROVED — Team work is complete. You can now call release_all to release all agents, or end_session to archive the session.";
        } else if (!allDoneOrApproved && connectedAgents.length > 0) {
          const needsWork = connectedAgents.filter((a) => a.task_state !== "approved" && a.task_state !== "released");
          completionText = `\n\nCompletion: ${connectedAgents.length - needsWork.length}/${connectedAgents.length} agents approved. Still working: ${needsWork.map((a) => `${a.name} (${a.task_state})`).join(", ")}`;
        }

        return { content: [{ type: "text", text: display + eventText + blockedText + completionText }] };
      }

      // ---- broadcast_to_team ----
      case "broadcast_to_team": {
        const { session_id, message, exclude_roles } = args as {
          session_id: string;
          message: string;
          exclude_roles?: string[];
        };
        const result = await broadcastToTeam(session_id, message, brokerClient, exclude_roles);
        return { content: [{ type: "text", text: `Broadcast delivered to ${result.delivered_to} agents.` }] };
      }

      // ---- direct_agent ----
      case "direct_agent": {
        const { session_id, target, message } = args as {
          session_id: string;
          target: string;
          message: string;
        };
        const slot = await resolveTarget(session_id, target, brokerClient);
        if (!slot || !slot.peer_id) {
          return { content: [{ type: "text", text: `Could not find connected agent matching "${target}".` }] };
        }

        await brokerClient.sendMessage({
          from_id: "orchestrator",
          to_id: slot.peer_id,
          text: message,
          msg_type: "chat",
          session_id,
        });

        return { content: [{ type: "text", text: `Message sent to ${slot.display_name ?? `slot ${slot.id}`}.` }] };
      }

      // ---- add_agent ----
      case "add_agent": {
        const { session_id, agent_type, name: agentName, role, role_description, initial_task, file_ownership } = args as {
          session_id: string;
          agent_type: "claude" | "codex" | "gemini";
          name: string;
          role: string;
          role_description: string;
          initial_task: string;
          file_ownership?: string[];
        };

        const detection = await detectAgent(agent_type);
        if (!detection.available) {
          return { content: [{ type: "text", text: `Error: ${agent_type} CLI not found.` }] };
        }

        const session = await brokerClient.getSession(session_id);
        const config: AgentLaunchConfig = {
          agent_type,
          name: agentName,
          role,
          role_description,
          initial_task,
          file_ownership,
        };

        const result = await launchAgent(session_id, session.project_dir, config, brokerClient);

        const sessionProcs = activeProcesses.get(session_id) ?? new Map();
        sessionProcs.set(result.slotId, result.process);
        activeProcesses.set(session_id, sessionProcs);
        if (!activeSessions.has(session_id)) {
          activeSessions.set(session_id, { projectDir: session.project_dir });
        }

        // Track CodexDriver for message forwarding (same pattern as create_team)
        if (result.codexDriver) {
          let sessionDrivers = activeCodexDrivers.get(session_id);
          if (!sessionDrivers) {
            sessionDrivers = new Map();
            activeCodexDrivers.set(session_id, sessionDrivers);
          }
          sessionDrivers.set(result.slotId, { driver: result.codexDriver, threadId: result.codexDriver.threadId, busy: false, lastNudge: 0 });
          monitorCodexDriver(result.codexDriver, result.slotId, session_id, brokerClient, handleEvent);
        } else {
          monitorProcess(result.process, result.slotId, session_id, brokerClient, handleEvent);
        }

        const slot = await brokerClient.getSlot(result.slotId);
        await announceNewMember(session_id, slot, config, brokerClient);

        return {
          content: [{
            type: "text",
            text: `Added ${agentName} (${agent_type}) as ${role} in slot ${result.slotId} (PID ${result.pid}).`,
          }],
        };
      }

      // ---- remove_agent ----
      case "remove_agent": {
        const { session_id, target } = args as { session_id: string; target: string };
        const slot = await resolveTarget(session_id, target, brokerClient);
        if (!slot) {
          return { content: [{ type: "text", text: `Could not find agent matching "${target}".` }] };
        }

        // Kill the process if we have it
        const sessionProcs = activeProcesses.get(session_id);
        if (sessionProcs) {
          const proc = sessionProcs.get(slot.id);
          if (proc) {
            proc.kill();
            sessionProcs.delete(slot.id);
          }
        }

        // Update slot to disconnected
        await brokerClient.updateSlot({ id: slot.id, status: "disconnected" });

        // Notify remaining team
        const slots = await brokerClient.listSlots(session_id);
        for (const s of slots) {
          if (s.id !== slot.id && s.status === "connected" && s.peer_id) {
            await brokerClient.sendMessage({
              from_id: "orchestrator",
              to_id: s.peer_id,
              text: `[Team Update] ${slot.display_name ?? `Agent #${slot.id}`} (${slot.role ?? "unassigned"}) has been removed from the team.`,
              msg_type: "team_change",
              session_id,
            });
          }
        }

        return { content: [{ type: "text", text: `Removed ${slot.display_name ?? `slot ${slot.id}`} from the session.` }] };
      }

      // ---- control_session ----
      case "control_session": {
        const { session_id, action, target, value } = args as {
          session_id: string;
          action: string;
          target?: string;
          value?: number;
        };
        const result = await controlSession(session_id, action, brokerClient, target, value);
        return { content: [{ type: "text", text: result.message }] };
      }

      // ---- adjust_guardrail ----
      case "adjust_guardrail": {
        const { session_id, action, guardrail_id, new_value } = args as {
          session_id: string;
          action: "view" | "update";
          guardrail_id?: string;
          new_value?: number;
        };

        if (action === "view") {
          const checks = await checkGuardrails(session_id, brokerClient);
          const lines = checks.map((c) => {
            const icon = c.status === "triggered" ? "[!]" : c.status === "warning" ? "[?]" : "[ok]";
            return `${icon} ${c.message}`;
          });
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        if (action === "update") {
          if (!guardrail_id || new_value === undefined) {
            return { content: [{ type: "text", text: "guardrail_id and new_value required for update." }] };
          }
          const updated = await brokerClient.updateGuardrail({
            session_id,
            guardrail_id,
            new_value,
            changed_by: "orchestrator",
          });
          return { content: [{ type: "text", text: `Updated ${guardrail_id} to ${new_value} ${updated.unit}.` }] };
        }

        return { content: [{ type: "text", text: `Unknown guardrail action: ${action}` }] };
      }

      // ---- get_session_log ----
      case "get_session_log": {
        const { session_id, limit, since } = args as {
          session_id: string;
          limit?: number;
          since?: number;
        };
        const messages = await brokerClient.getMessageLog(session_id, { limit: limit ?? 50, since });
        const lines = messages.map((m) => {
          const from = m.from_slot_id !== null ? `slot ${m.from_slot_id}` : m.from_id;
          const to = m.to_slot_id !== null ? `slot ${m.to_slot_id}` : m.to_id;
          return `[${m.sent_at}] ${from} -> ${to} (${m.msg_type}): ${m.text.slice(0, 200)}`;
        });
        return { content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "No messages found." }] };
      }

      // ---- release_agent ----
      case "release_agent": {
        const { session_id, target, message } = args as { session_id: string; target: string; message?: string };
        const slot = await resolveTarget(session_id, target, brokerClient);
        if (!slot) {
          const slots = await brokerClient.listSlots(session_id);
          return { content: [{ type: "text", text: `Agent "${target}" not found. Available: ${slots.map(s => s.display_name || s.role || s.id).join(", ")}` }] };
        }
        const result = await brokerClient.releaseAgent({
          session_id,
          target_slot_id: slot.id,
          released_by: "__orchestrator__",
          message,
        });
        return {
          content: [{ type: "text", text: `Released ${slot.display_name || slot.role || slot.id}. Task state: ${result.task_state}. Agent can now disconnect.` }],
        };
      }

      // ---- release_all ----
      case "release_all": {
        const { session_id, message } = args as { session_id: string; message?: string };
        const slots = await brokerClient.listSlots(session_id);

        // Warn if not all agents are approved
        const connectedSlots = slots.filter((s) => s.status === "connected");
        const notApproved = connectedSlots.filter((s) =>
          s.task_state !== "approved" && s.task_state !== "released"
        );
        if (notApproved.length > 0) {
          const warning = `WARNING: ${notApproved.length} agent(s) not yet approved: ${notApproved.map((s) => `${s.display_name || s.role || s.id} (${s.task_state || "idle"})`).join(", ")}. Releasing anyway as requested.`;
          log(LOG_PREFIX, warning);
          // Still proceed — orchestrator explicitly asked to release
        }

        let released = 0;
        for (const slot of slots) {
          if (slot.task_state !== "released" && slot.task_state !== "idle") {
            await brokerClient.releaseAgent({
              session_id,
              target_slot_id: slot.id,
              released_by: "__orchestrator__",
              message: message || "All agents released. Session complete.",
            });
            released++;
          }
        }
        return {
          content: [{ type: "text", text: `Released ${released} agent(s). All agents can now disconnect.` }],
        };
      }

      // ---- cleanup_dead_slots ----
      case "cleanup_dead_slots": {
        const { session_id, keep_released } = args as { session_id: string; keep_released?: boolean };
        const slots = await brokerClient.listSlots(session_id);
        let removed = 0;
        const removedNames: string[] = [];

        const now = Date.now();
        let skippedStarting = 0;

        for (const slot of slots) {
          const isDead = slot.status === "disconnected" && slot.task_state !== "released";
          const isReleased = slot.task_state === "released";
          const shouldRemove = isDead || (isReleased && !keep_released);

          // SAFETY: Never clean up slots that are still starting up.
          // A slot that has never been connected (last_connected is null) is still
          // booting its MCP server. Deleting it destroys the session.
          if (shouldRemove && isDead && !slot.last_connected) {
            skippedStarting++;
            continue; // Still starting — don't delete
          }
          // Also skip slots that were recently connected (within 2 min) — might be restarting
          if (shouldRemove && isDead && slot.last_disconnected && (now - slot.last_disconnected < 120_000)) {
            skippedStarting++;
            continue;
          }

          if (shouldRemove) {
            // Delete the slot from the broker DB
            await brokerClient.deleteSlot(slot.id);
            removedNames.push(slot.display_name || slot.role || `slot-${slot.id}`);
            removed++;

            // Also remove from active process tracking
            const sessionProcs = activeProcesses.get(session_id);
            if (sessionProcs) {
              const proc = sessionProcs.get(slot.id);
              if (proc) {
                try { proc.kill(); } catch { /* already dead */ }
                sessionProcs.delete(slot.id);
              }
            }
          }
        }

        const startingNote = skippedStarting > 0
          ? `\nSkipped ${skippedStarting} slot(s) still starting up — these agents are booting and will connect shortly. Do NOT clean them up.`
          : "";
        return {
          content: [{
            type: "text",
            text: (removed > 0
              ? `Cleaned up ${removed} dead slot(s): ${removedNames.join(", ")}`
              : `No dead slots found. All ${slots.length} slot(s) are active.`) + startingNote,
          }],
        };
      }

      // ---- end_session ----
      case "end_session": {
        const { session_id, create_pr } = args as { session_id: string; create_pr?: boolean };

        // Kill all active processes
        const sessionProcs = activeProcesses.get(session_id);
        if (sessionProcs) {
          for (const [slotId, proc] of sessionProcs) {
            log(LOG_PREFIX, `Stopping agent in slot ${slotId}`);
            try { proc.kill(); } catch { /* already dead */ }
          }
          sessionProcs.clear();
          activeProcesses.delete(session_id);
        }

        // Kill CodexDriver processes
        const sessionDrivers = activeCodexDrivers.get(session_id);
        if (sessionDrivers) {
          for (const [slotId, state] of sessionDrivers) {
            log(LOG_PREFIX, `Stopping Codex driver in slot ${slotId}`);
            try { state.driver.kill(); } catch { /* already dead */ }
          }
          sessionDrivers.clear();
          activeCodexDrivers.delete(session_id);
        }

        // Clean driver-mode sentinel file
        try {
          const session = await brokerClient.getSession(session_id);
          const sentinelPath = require("node:path").join(session.project_dir, ".multiagents", ".driver-mode");
          require("node:fs").unlinkSync(sentinelPath);
        } catch { /* ok */ }

        // Mark all slots as disconnected
        const slots = await brokerClient.listSlots(session_id);
        for (const slot of slots) {
          if (slot.status === "connected") {
            await brokerClient.updateSlot({ id: slot.id, status: "disconnected" });
          }
        }

        // Archive session
        await brokerClient.updateSession({
          id: session_id,
          status: "archived",
        });

        // Clean up per-slot tracking state (memory leak prevention)
        for (const slot of slots) {
          clearSlotTracking(slot.id);
          completionRestartHistory.delete(slot.id);
        }
        clearAllCrashHistory();
        activeSessions.delete(session_id);

        let prMessage = "";
        if (create_pr) {
          prMessage = "\nNote: PR creation should be done by running `gh pr create` in the project directory.";
        }

        return {
          content: [{
            type: "text",
            text: `Session "${session_id}" ended. ${slots.length} agents stopped. Session archived.${prMessage}`,
          }],
        };
      }

      // ---- delete_session ----
      case "delete_session": {
        const { session_id } = args as { session_id: string };

        // Kill any running agent processes first
        const sessionProcs = activeProcesses.get(session_id);
        if (sessionProcs) {
          for (const [slotId, proc] of sessionProcs) {
            try { proc.kill(); } catch { /* already dead */ }
          }
          activeProcesses.delete(session_id);
        }
        // Kill CodexDriver processes
        const delDrivers = activeCodexDrivers.get(session_id);
        if (delDrivers) {
          for (const [, state] of delDrivers) {
            try { state.driver.kill(); } catch { /* already dead */ }
          }
          activeCodexDrivers.delete(session_id);
        }
        activeSessions.delete(session_id);

        // Clean up per-slot tracking state (memory leak prevention)
        clearAllTracking();
        clearAllCrashHistory();
        completionRestartHistory.clear();

        const result = await brokerClient.deleteSession(session_id);
        if (!result.ok) {
          return { content: [{ type: "text", text: `Session "${session_id}" not found.` }] };
        }

        return {
          content: [{
            type: "text",
            text: `Session "${session_id}" permanently deleted. Removed: ${result.deleted.slots} slot(s), ${result.deleted.messages} message(s), ${result.deleted.plans} plan(s).`,
          }],
        };
      }

      // ---- list_sessions ----
      case "list_sessions": {
        const { status_filter } = args as { status_filter?: string };
        const allSessions = await brokerClient.listSessions();

        // Filter by status
        const filtered = status_filter && status_filter !== "all"
          ? allSessions.filter((s: any) => s.status === status_filter)
          : allSessions;

        if (filtered.length === 0) {
          return { content: [{ type: "text", text: `No sessions found${status_filter ? ` with status "${status_filter}"` : ""}.` }] };
        }

        // Enrich each session with slot counts and plan progress
        const lines: string[] = ["=== Multiagents Sessions ===", ""];
        for (const session of filtered) {
          const sid = (session as any).id;
          let slotInfo = "";
          let planInfo = "";
          try {
            const slots = await brokerClient.listSlots(sid);
            const connected = slots.filter((s: any) => s.status === "connected").length;
            const disconnected = slots.filter((s: any) => s.status === "disconnected").length;
            slotInfo = ` | Agents: ${connected} online, ${disconnected} disconnected (${slots.length} total)`;

            // Plan progress
            const plan = await brokerClient.getPlan(sid);
            if (plan?.items && plan.items.length > 0) {
              const done = plan.items.filter((i: any) => i.status === "done").length;
              planInfo = ` | Plan: ${done}/${plan.items.length} done`;
            }
          } catch { /* best effort */ }

          const elapsed = Date.now() - ((session as any).created_at ?? 0);
          const isManaged = activeProcesses.has(sid) ? " [MANAGED]" : "";
          lines.push(`  ${sid}`);
          lines.push(`    Name: ${(session as any).name} | Status: ${(session as any).status}${isManaged} | Elapsed: ${formatDuration(elapsed)}`);
          lines.push(`    Dir: ${(session as any).project_dir}${slotInfo}${planInfo}`);
          lines.push("");
        }

        lines.push(`${filtered.length} session(s) found. Use resume_session to restart a paused/stopped session.`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ---- resume_session ----
      case "resume_session": {
        const { session_id, agents_to_skip } = args as { session_id: string; agents_to_skip?: string[] };
        const skipSet = new Set((agents_to_skip ?? []).map(s => s.toLowerCase()));

        // Get session
        const session = await brokerClient.getSession(session_id);
        if (!session) {
          return { content: [{ type: "text", text: `Session "${session_id}" not found.` }] };
        }

        // Update session status to active
        await brokerClient.updateSession({
          id: session_id,
          status: "active",
          pause_reason: null,
          paused_at: null,
        });

        // Get all slots
        const slots = await brokerClient.listSlots(session_id);
        const disconnected = slots.filter((s: any) =>
          s.status === "disconnected" &&
          s.task_state !== "released" &&
          !skipSet.has((s.display_name ?? "").toLowerCase()) &&
          !skipSet.has((s.role ?? "").toLowerCase())
        );

        if (disconnected.length === 0) {
          // Track session even if no agents to respawn (for monitoring loops)
          activeSessions.set(session_id, { projectDir: session.project_dir });
          if (!activeProcesses.has(session_id)) {
            activeProcesses.set(session_id, new Map());
          }
          return { content: [{ type: "text", text: `Session "${session_id}" resumed (status → active). No disconnected agents to respawn. ${slots.filter((s: any) => s.status === "connected").length} agent(s) already online.` }] };
        }

        // Respawn each disconnected agent with rich handoff context
        const respawned: string[] = [];
        const failed: string[] = [];
        const resumeLaunchedTypes = new Set<string>();

        for (const slot of disconnected) {
          try {
            // Detect agent CLI availability
            const detection = await detectAgent(slot.agent_type);
            if (!detection.available) {
              failed.push(`${slot.display_name || slot.role || slot.id} (${slot.agent_type} CLI not found)`);
              continue;
            }

            // Build rich handoff prompt
            const snapshot = safeJsonParse<Record<string, any>>(slot.context_snapshot, {});

            // Get message recap for this slot
            let recapLines: string[] = [];
            try {
              const messages = await brokerClient.getMessageLog(session_id, { limit: 30, with_slot: slot.id });
              recapLines = messages.map((m: any) =>
                `[${m.msg_type}] ${m.from_id}: ${(m.text ?? "").slice(0, 200)}`
              );
            } catch { /* ok */ }

            // Get plan items assigned to this slot
            let planItemLines: string[] = [];
            try {
              const plan = await brokerClient.getPlan(session_id);
              if (plan?.items) {
                const myItems = plan.items.filter((i: any) => i.assigned_to_slot === slot.id);
                planItemLines = myItems.map((i: any) => {
                  const marker = i.status === "done" ? "[x]" : i.status === "in_progress" ? "[~]" : "[ ]";
                  return `  ${marker} ${i.label}`;
                });
              }
            } catch { /* ok */ }

            // Build team context
            const teamContext = await buildTeamContext(session_id, slot.id, brokerClient);

            const handoffParts = [
              "SESSION RESUMED — You are being restarted to continue a previous session.",
              "",
              `Your role: ${slot.role ?? "unassigned"}`,
              slot.role_description ? `Role description: ${slot.role_description}` : "",
              snapshot.last_summary ? `Your last status: ${snapshot.last_summary}` : "",
              snapshot.task_state ? `Your task state when you left: ${snapshot.task_state}` : "",
              "",
              teamContext,
            ];

            if (planItemLines.length > 0) {
              handoffParts.push("", "Your assigned plan items:");
              handoffParts.push(...planItemLines);
            }

            if (recapLines.length > 0) {
              handoffParts.push("", "Recent message history (most recent last):");
              handoffParts.push(...recapLines);
            }

            handoffParts.push(
              "",
              "INSTRUCTIONS:",
              "1. Read the current state of the codebase — files may have changed since you disconnected.",
              "2. Call check_team_status to see who else is online and what state they are in.",
              "3. Call get_plan to see overall progress.",
              "4. Resume your work from where you left off. If your task_state was 'addressing_feedback', check for unresolved feedback first.",
              "5. Call set_summary to broadcast your current status to the team.",
            );

            const handoffTask = handoffParts.filter(Boolean).join("\n");

            // Stagger same-type agent launches to prevent race conditions
            if (resumeLaunchedTypes.has(slot.agent_type)) {
              await new Promise((r) => setTimeout(r, 3000));
            }
            resumeLaunchedTypes.add(slot.agent_type);

            // Relaunch into existing slot
            const result = await relaunchIntoSlot(session_id, session.project_dir, slot, handoffTask, brokerClient);

            // Track process
            const sessionProcs = activeProcesses.get(session_id) ?? new Map();
            sessionProcs.set(result.slotId, result.process);
            activeProcesses.set(session_id, sessionProcs);

            // Monitor process
            monitorProcess(result.process, result.slotId, session_id, brokerClient, handleEvent);

            // Release held messages for this slot
            try {
              await brokerClient.releaseHeldMessages(session_id, slot.id);
            } catch { /* ok */ }

            respawned.push(`${slot.display_name || slot.role || slot.id} (PID ${result.pid})`);
          } catch (err) {
            failed.push(`${slot.display_name || slot.role || slot.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Track session for monitoring loops
        activeSessions.set(session_id, { projectDir: session.project_dir });

        // Launch dashboard
        launchDashboard(session_id, session.project_dir);

        const lines: string[] = [`Session "${session_id}" resumed.`];
        if (respawned.length > 0) {
          lines.push(`Respawned ${respawned.length} agent(s): ${respawned.join(", ")}`);
        }
        if (failed.length > 0) {
          lines.push(`Failed to respawn ${failed.length}: ${failed.join("; ")}`);
        }
        const skipped = slots.length - disconnected.length - slots.filter((s: any) => s.status === "connected").length;
        if (skipped > 0) {
          lines.push(`Skipped ${skipped} slot(s) (released/archived).`);
        }
        lines.push(`\nDashboard launched. Use get_team_status to monitor progress.`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ---- get_guide ----
      case "get_guide": {
        const { topic } = args as { topic?: string };
        if (!topic) {
          return { content: [{ type: "text", text: formatTopicList() }] };
        }
        const content = getGuide(topic as GuideTopic);
        if (!content) {
          return { content: [{ type: "text", text: `Unknown topic "${topic}".\n\n${formatTopicList()}` }] };
        }
        return { content: [{ type: "text", text: content }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(LOG_PREFIX, `Tool error (${name}): ${errMsg}`);
    return { content: [{ type: "text", text: `Error: ${errMsg}` }], isError: true };
  }
});

// --- Background loops ---

let guardrailTimer: ReturnType<typeof setInterval> | null = null;
let conflictTimer: ReturnType<typeof setInterval> | null = null;

function startBackgroundLoops(brokerClient: BrokerClient): void {
  // Guardrail check loop
  guardrailTimer = setInterval(async () => {
    for (const sessionId of activeProcesses.keys()) {
      try {
        await enforceGuardrails(sessionId, brokerClient, handleEvent);
      } catch (err) {
        log(LOG_PREFIX, `Guardrail check error for ${sessionId}: ${err}`);
      }
    }
  }, GUARDRAIL_CHECK_INTERVAL);

  // Dead slot auto-cleanup loop — every 60s, remove slots disconnected for >5 min
  setInterval(async () => {
    const now = Date.now();
    for (const sessionId of activeProcesses.keys()) {
      try {
        const slots = await brokerClient.listSlots(sessionId);
        for (const slot of slots) {
          if (slot.status !== "disconnected") continue;

          // CRITICAL: Skip slots that have NEVER connected — they're still starting up.
          // Without this check, last_disconnected is null → defaults to 0 → deadFor = now
          // (billions of ms) → the slot looks dead for "54 years" → gets deleted immediately.
          // This was THE bug that caused all starting agents to vanish from the dashboard.
          if (!slot.last_connected) continue;

          const disconnectedAt = slot.last_disconnected ?? slot.last_connected ?? now;
          const deadFor = now - disconnectedAt;
          if (deadFor < 5 * 60 * 1000) continue; // <5 min, might reconnect

          // Skip driver-managed Codex slots — orchestrator controls their lifecycle
          const sessionDrivers = activeCodexDrivers.get(sessionId);
          if (sessionDrivers?.has(slot.id)) continue;

          // Auto-cleanup: delete the dead slot
          try {
            await brokerClient.deleteSlot(slot.id);
            log(LOG_PREFIX, `Auto-deleted dead slot ${slot.id} (${slot.display_name || slot.role}) — disconnected for ${Math.round(deadFor / 60000)}m`);
          } catch { /* best effort */ }
        }
      } catch { /* ok */ }
    }
  }, 60_000);

  // --- Codex message forwarding prompt ---
  function buildForwardingPrompt(formatted: string): string {
    return `[Teammate message] ${formatted}\nAcknowledge briefly, then continue your current task.`;
  }

  // --- Codex message forwarding loop ---
  // For CodexDriver-managed agents, poll the broker for undelivered messages
  // and deliver them. Two delivery paths:
  //   1. turn/steer — if Codex has an active turn, inject mid-turn (instant)
  //   2. reply() — if no active turn, start a new turn (fire-and-forget)
  //
  // The loop is NON-BLOCKING: busy slots are skipped (messages stay in
  // broker queue with delivered=0), serviced on the next free cycle.
  setInterval(async () => {
    for (const [sessionId, drivers] of activeCodexDrivers) {
      for (const [slotId, state] of drivers) {
        if (!state.driver.alive) continue;
        const threadId = state.threadId ?? state.driver.threadId;
        if (!threadId) continue; // First turn hasn't completed yet

        // --- Interrupt + signal_done turn: if Codex turn is active but idle for >60s ---
        // The Codex LLM can get stuck in a single long inference call after completing work.
        // turn/steer only works between loop iterations — it can't interrupt mid-generation.
        // Instead: interrupt the stuck turn, then start a new focused turn for signal_done.
        const INTERRUPT_IDLE_MS = 60_000;
        const now = Date.now();
        if (
          state.driver.activeTurnId &&
          now - state.driver.lastNotificationActivity > INTERRUPT_IDLE_MS &&
          now - state.lastNudge > INTERRUPT_IDLE_MS
        ) {
          state.lastNudge = now;
          log(LOG_PREFIX, `Codex slot ${slotId} stuck for ${Math.round((now - state.driver.lastNotificationActivity) / 1000)}s — interrupting turn and requesting signal_done`);
          try {
            await state.driver.interrupt(threadId);
          } catch {
            // Interrupt can fail if turn already completed
          }
          // Wait a moment for the turn to fully complete after interrupt
          await new Promise(r => setTimeout(r, 2000));
          // Start a new focused turn asking only for signal_done
          if (!state.driver.activeTurnId && !state.busy) {
            state.busy = true;
            state.driver.reply(threadId, "Your previous task is complete. Call signal_done NOW with a summary of what you accomplished. This is the ONLY thing you need to do.")
              .then(async (result) => {
                state.threadId = result.threadId;
                state.busy = false;
                log(LOG_PREFIX, `Codex slot ${slotId} signal_done turn completed`);
              })
              .catch((err) => {
                state.busy = false;
                log(LOG_PREFIX, `Codex slot ${slotId} signal_done turn failed: ${err}`);
              });
          }
        }

        // If a reply() is in flight, skip — don't even poll. Messages
        // accumulate in the broker and batch-deliver on the next free cycle.
        if (state.busy) continue;

        try {
          const pollResult = await brokerClient.pollBySlot(slotId);
          if (!pollResult.messages || pollResult.messages.length === 0) continue;

          const formatted = pollResult.messages.map((m: any) => {
            const from = m.from_slot_id !== null
              ? `slot ${m.from_slot_id}`
              : m.from_id;
            return `[${m.msg_type}] From ${from}: ${m.text}`;
          }).join("\n\n---\n\n");

          log(LOG_PREFIX, `Forwarding ${pollResult.messages.length} message(s) to Codex slot ${slotId}`);

          // Path 1: Mid-turn injection via turn/steer (instant, non-blocking)
          if (state.driver.activeTurnId) {
            try {
              await state.driver.steer(threadId, buildForwardingPrompt(formatted));
              log(LOG_PREFIX, `Steered messages into active turn for slot ${slotId}`);
            } catch (err) {
              // Steer can fail if the turn completed between our check and the call.
              // Fall through to Path 2 on next cycle.
              log(LOG_PREFIX, `Steer failed for slot ${slotId} (will retry as new turn): ${err}`);
            }
            continue;
          }

          // Path 2: Start a new turn (fire-and-forget, non-blocking)
          state.busy = true;
          state.driver.reply(threadId, buildForwardingPrompt(formatted))
            .then(async (result) => {
              state.threadId = result.threadId;
              state.busy = false;
              await brokerClient.updateSlot({
                id: slotId,
                context_snapshot: JSON.stringify({
                  codex_thread_id: result.threadId,
                  last_summary: result.content.slice(0, 200),
                  last_status: "working",
                  updated_at: Date.now(),
                }),
              }).catch(() => {});
              log(LOG_PREFIX, `Codex slot ${slotId} finished processing forwarded messages`);
            })
            .catch((err) => {
              state.busy = false;
              log(LOG_PREFIX, `Codex message forwarding error for slot ${slotId}: ${err}`);
            });
        } catch (err) {
          log(LOG_PREFIX, `Codex poll error for slot ${slotId}: ${err}`);
        }
      }
    }
  }, 3_000); // Check every 3 seconds

  // Stuck agent nudge loop — every 45s, nudge agents silent for >1 min
  setInterval(async () => {
    for (const sessionId of activeProcesses.keys()) {
      try {
        const slots = await brokerClient.listSlots(sessionId);
        for (const slot of slots) {
          if (slot.status !== "connected" || !slot.peer_id) continue;
          if (slot.paused === true || (slot.paused as unknown as number) === 1) continue;

          // Codex driver-managed agents get nudges delivered via the
          // forwarding loop (steer or reply). Don't skip them — they need
          // nudges too, especially to prompt signal_done after long turns.

          // Check last_connected or context_snapshot for activity
          const lastActivity = (() => {
            if (slot.context_snapshot) {
              try {
                const snap = JSON.parse(slot.context_snapshot);
                if (snap.updated_at) return snap.updated_at;
              } catch { /* ok */ }
            }
            return slot.last_connected ?? 0;
          })();

          const silentMs = Date.now() - lastActivity;
          if (silentMs > 1 * 60 * 1000) {
            const agentName = slot.display_name || `slot ${slot.id}`;
            const silentMin = Math.round(silentMs / 60000);

            // Nudge the agent
            await brokerClient.sendMessage({
              from_id: "orchestrator",
              to_id: slot.peer_id,
              text: `[NUDGE] You have been silent for ${silentMin} minutes. ` +
                    `Check your teammates with check_team_status and check_messages. ` +
                    `If you are done, call signal_done. If you are blocked, send a message to "orchestrator" explaining what you need.`,
              msg_type: "system",
              session_id: sessionId,
            });

            // Also alert the orchestrator user via pending events
            pendingEvents.push({
              type: "agent_silent",
              severity: silentMs > 5 * 60 * 1000 ? "warning" : "info",
              slotId: slot.id,
              sessionId,
              message: `${agentName} (${slot.role || "unknown"}) silent for ${silentMin}m — task_state: ${(slot as any).task_state || "idle"}. May need intervention.`,
            });
            log(LOG_PREFIX, `Nudged silent agent ${agentName} (${silentMin}m silent)`);
          }
        }
      } catch { /* ok */ }
    }
  }, 45_000);

  // Conflict detection loop — basic git status monitoring
  conflictTimer = setInterval(async () => {
    for (const sessionId of activeProcesses.keys()) {
      try {
        const session = await brokerClient.getSession(sessionId);
        if (session.status !== "active" || !session.git_root) continue;

        const proc = Bun.spawn(["git", "status", "--porcelain"], {
          cwd: session.project_dir,
          stdout: "pipe",
          stderr: "ignore",
        });
        const output = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;

        if (exitCode === 0) {
          // Check for merge conflicts (lines starting with UU, AA, DD, etc.)
          const conflictLines = output
            .split("\n")
            .filter((l) => /^(UU|AA|DD|AU|UA|DU|UD)\s/.test(l));

          if (conflictLines.length > 0) {
            handleEvent({
              type: "git_conflict",
              severity: "critical",
              slotId: -1,
              sessionId,
              message: `Git conflicts detected: ${conflictLines.length} file(s)`,
              data: { files: conflictLines.map((l) => l.slice(3).trim()) },
            });
          }
        }
      } catch (err) {
        log(LOG_PREFIX, `Conflict check error for ${sessionId}: ${err}`);
      }
    }
  }, CONFLICT_CHECK_INTERVAL);

  // Agent escalation monitor — check for messages sent TO "orchestrator" and surface as events
  const seenEscalations = new Set<string>();
  setInterval(async () => {
    for (const sessionId of activeProcesses.keys()) {
      try {
        const messages = await brokerClient.getMessageLog(sessionId, { limit: 30 });
        for (const msg of messages) {
          if (msg.to_id !== "orchestrator") continue;
          // Deduplicate by message id or sent_at+from_id
          const key = `${msg.from_id}:${msg.sent_at}`;
          if (seenEscalations.has(key)) continue;
          seenEscalations.add(key);

          const isBlocked = /BLOCKED|NEED HELP|ESCALAT|STUCK|CANNOT PROCEED/i.test(msg.text);
          if (isBlocked) {
            const slots = await brokerClient.listSlots(sessionId);
            const fromSlot = slots.find((s) => s.peer_id === msg.from_id);
            const fromName = fromSlot?.display_name || fromSlot?.role || msg.from_id;

            pendingEvents.push({
              type: "agent_blocked",
              severity: "warning",
              slotId: fromSlot?.id ?? -1,
              sessionId,
              message: `AGENT BLOCKED — ${fromName}: ${msg.text.slice(0, 300)}`,
            });
            log(LOG_PREFIX, `Agent escalation from ${fromName}: ${msg.text.slice(0, 100)}`);
          }
        }

        // Prune old escalation keys (keep set from growing unbounded)
        if (seenEscalations.size > 500) {
          for (const escalationKey of [...seenEscalations].slice(0, 250)) {
            seenEscalations.delete(escalationKey);
          }
        }
      } catch { /* ok */ }
    }
  }, 15_000);
}

// --- Main ---

async function main(): Promise<void> {
  const brokerClient = new BrokerClient(BROKER_URL);

  // Ensure broker is running
  await ensureBroker(brokerClient);

  // Start background loops
  startBackgroundLoops(brokerClient);

  // Connect MCP over stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log(LOG_PREFIX, "Orchestrator MCP server running on stdio");
}

main().catch((err) => {
  console.error(`[orchestrator] Fatal: ${err}`);
  process.exit(1);
});

// --- Graceful shutdown: kill all managed agent processes ---
function shutdownOrchestrator() {
  log(LOG_PREFIX, "Shutting down — killing all managed agent processes");
  for (const [sessionId, procs] of activeProcesses) {
    for (const [slotId, proc] of procs) {
      try { proc.kill(); } catch { /* already dead */ }
    }
  }
  // Kill CodexDriver processes
  for (const [sessionId, drivers] of activeCodexDrivers) {
    for (const [slotId, state] of drivers) {
      try { state.driver.kill(); } catch { /* already dead */ }
    }
  }
  process.exit(0);
}

process.on("SIGINT", shutdownOrchestrator);
process.on("SIGTERM", shutdownOrchestrator);
