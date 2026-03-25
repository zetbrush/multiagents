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

import { BrokerClient } from "../shared/broker-client.ts";
import type { AgentLaunchConfig } from "../shared/types.ts";
import { log, getGitRoot, slugify } from "../shared/utils.ts";
import {
  DEFAULT_BROKER_PORT,
  BROKER_HOSTNAME,
  GUARDRAIL_CHECK_INTERVAL,
  CONFLICT_CHECK_INTERVAL,
} from "../shared/constants.ts";

import { detectAgent, launchAgent, announceNewMember, buildTeamContext } from "./launcher.ts";
import { monitorProcess, type AgentEvent } from "./monitor.ts";
import { getTeamStatus, formatTeamStatusForDisplay } from "./progress.ts";
import { checkGuardrails, enforceGuardrails } from "./guardrails.ts";
import { handleAgentCrash } from "./recovery.ts";
import { controlSession, broadcastToTeam, resolveTarget } from "./session-control.ts";

const LOG_PREFIX = "orchestrator";
const BROKER_URL = `http://${BROKER_HOSTNAME}:${DEFAULT_BROKER_PORT}`;

// Track active processes per session
const activeProcesses: Map<string, Map<number, Subprocess>> = new Map();
// Track pending events to push as notifications
const pendingEvents: AgentEvent[] = [];

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
    const sessionProcesses = activeProcesses.get(event.sessionId);
    if (sessionProcesses) {
      // Trigger async respawn — handleAgentCrash is the sole source of the crash event
      const brokerClient = new BrokerClient(BROKER_URL);
      handleAgentCrash(event.slotId, event.data.exit_code as number, event.sessionId, brokerClient)
        .then((crashEvent) => {
          pendingEvents.push(crashEvent);
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
    if (state === "idle" || state === "addressing_feedback") {
      log(LOG_PREFIX, `${name} exited with code 0 but task_state="${state}" — auto-restarting`);

      // Find the session's project dir from active sessions
      const sessionMeta = activeSessions.get(sessionId);
      if (!sessionMeta) {
        log(LOG_PREFIX, `No session metadata for ${sessionId}, cannot restart`);
        return false;
      }

      // Use respawnAgent from recovery module — it preserves context
      const { respawnAgent } = await import("./recovery.ts");
      const result = await respawnAgent(sessionId, slotId, brokerClient, sessionMeta.projectDir);

      // Track the new process
      const sessionProcesses = activeProcesses.get(sessionId);
      if (sessionProcesses && result.pid) {
        // The new process is tracked by respawnAgent's launchAgent call
        log(LOG_PREFIX, `Auto-restarted ${name} (PID ${result.pid})`);
      }

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
      description: "Create a new multi-agent team session. Launches headless agents with assigned roles and file ownership.",
      inputSchema: {
        type: "object" as const,
        properties: {
          project_dir: { type: "string", description: "Absolute path to the project directory" },
          session_name: { type: "string", description: "Human-readable session name (e.g. 'Auth Implementation')" },
          agents: {
            type: "array",
            items: {
              type: "object",
              properties: {
                agent_type: { type: "string", enum: ["claude", "codex", "gemini"] },
                name: { type: "string" },
                role: { type: "string" },
                role_description: { type: "string" },
                initial_task: { type: "string" },
                file_ownership: { type: "array", items: { type: "string" } },
              },
              required: ["agent_type", "name", "role", "role_description", "initial_task"],
            },
          },
          plan: {
            type: "array",
            description: "Optional plan items to track progress. Each item has a label and optional agent_name assignment.",
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
      description: "Get current status of all agents in a session, including health, progress, and issues.",
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
      description: "Send a message to all connected agents in the session.",
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
      description: "Send a direct message to a specific agent by name, role, or slot ID.",
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
      description: "Add a new agent to an existing session.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string" },
          agent_type: { type: "string", enum: ["claude", "codex", "gemini"] },
          name: { type: "string" },
          role: { type: "string" },
          role_description: { type: "string" },
          initial_task: { type: "string" },
          file_ownership: { type: "array", items: { type: "string" } },
        },
        required: ["session_id", "agent_type", "name", "role", "role_description", "initial_task"],
      },
    },
    {
      name: "remove_agent",
      description: "Gracefully stop and remove an agent from the session.",
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
      description: "Control the session: pause_all, resume_all, pause_agent, resume_agent, extend_budget, set_budget, status.",
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
      description: "View or update guardrail limits for a session.",
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
      description: "Get the message history for a session.",
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
      description: "Release a specific agent, allowing it to disconnect. Use after their work is approved and complete.",
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
      description: "Release all agents in a session, allowing them to disconnect. Use when the entire team's work is complete.",
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
      description: "End a session: stop all agents, archive the session. Optionally create a PR.",
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

        // Detect available agents
        for (const agentCfg of agents) {
          const detection = await detectAgent(agentCfg.agent_type);
          if (!detection.available) {
            return { content: [{ type: "text", text: `Error: ${agentCfg.agent_type} CLI not found on PATH. Install it first.` }] };
          }
        }

        const sessionId = slugify(session_name);
        const gitRoot = await getGitRoot(project_dir);

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

        // Launch each agent
        const launchedAgents: { name: string; slot_id: number; pid: number }[] = [];
        for (const agentCfg of agents) {
          const result = await launchAgent(sessionId, project_dir, agentCfg, brokerClient);
          sessionProcs.set(result.slotId, result.process);

          // Start monitoring
          monitorProcess(result.process, result.slotId, sessionId, brokerClient, handleEvent);

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
            text: `Session "${sessionId}" created with ${launchedAgents.length} agents.${planSummary}\n\n${display}\n\nDashboard launched — run \`bun cli.ts dashboard ${sessionId}\` to reopen.`,
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

        return { content: [{ type: "text", text: display + eventText }] };
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

        monitorProcess(result.process, result.slotId, session_id, brokerClient, handleEvent);

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

        for (const slot of slots) {
          const isDead = slot.status === "disconnected" && slot.task_state !== "released";
          const isReleased = slot.task_state === "released";
          const shouldRemove = isDead || (isReleased && !keep_released);

          if (shouldRemove) {
            // Delete the slot from the DB
            try {
              await brokerClient.post("/slots/delete", { id: slot.id });
            } catch {
              // If no delete endpoint, mark it archived via status
              await brokerClient.updateSlot({ id: slot.id, status: "archived" as any });
            }
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

        return {
          content: [{
            type: "text",
            text: removed > 0
              ? `Cleaned up ${removed} dead slot(s): ${removedNames.join(", ")}`
              : `No dead slots found. All ${slots.length} slot(s) are active.`,
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
            proc.kill();
          }
          sessionProcs.clear();
          activeProcesses.delete(session_id);
        }

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
          // Skip if recently disconnected (might be restarting)
          const disconnectedAt = slot.last_disconnected ?? 0;
          const deadFor = now - disconnectedAt;
          if (deadFor < 5 * 60 * 1000) continue; // <5 min, might reconnect

          // Auto-cleanup: mark as archived
          try {
            await brokerClient.updateSlot({ id: slot.id, status: "archived" as any });
            log(LOG_PREFIX, `Auto-cleaned dead slot ${slot.id} (${slot.display_name || slot.role}) — disconnected for ${Math.round(deadFor / 60000)}m`);
          } catch { /* best effort */ }
        }
      } catch { /* ok */ }
    }
  }, 60_000);

  // Stuck agent nudge loop — every 45s, nudge agents silent for >2 min
  setInterval(async () => {
    for (const sessionId of activeProcesses.keys()) {
      try {
        const slots = await brokerClient.listSlots(sessionId);
        for (const slot of slots) {
          if (slot.status !== "connected" || !slot.peer_id) continue;
          if (slot.paused === true || (slot.paused as unknown as number) === 1) continue;

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
          if (silentMs > 2 * 60 * 1000) {
            // Nudge the agent
            await brokerClient.sendMessage({
              from_id: "orchestrator",
              to_id: slot.peer_id,
              text: `[NUDGE] You have been silent for ${Math.round(silentMs / 60000)} minutes. ` +
                    `Check your teammates with check_team_status and check_messages. ` +
                    `If you are done, call signal_done. If you are blocked, message your team for help.`,
              msg_type: "system",
              session_id: sessionId,
            });
            log(LOG_PREFIX, `Nudged silent agent ${slot.display_name || slot.id} (${Math.round(silentMs / 60000)}m silent)`);
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
