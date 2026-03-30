// ============================================================================
// multiagents — Team Progress & Status
// ============================================================================
// Computes aggregate team health, per-agent status, and formats for display.
// ============================================================================

import type { Slot, Message, Session } from "../shared/types.ts";
import type { BrokerClient } from "../shared/broker-client.ts";
import {
  STUCK_THRESHOLD_MS,
  SLOW_THRESHOLD_MS,
} from "../shared/constants.ts";
import { formatDuration, formatTime, safeJsonParse } from "../shared/utils.ts";

/** Health state for a single agent. */
export type HealthState = "healthy" | "slow" | "stuck" | "crashed";

/** Status for a single agent in the team. */
export interface AgentStatus {
  slot_id: number;
  name: string;
  role: string;
  agent_type: string;
  health: HealthState;
  task_state: string;
  status: string;
  paused: boolean;
  last_activity: string;
  summary: string;
}

/** Issue detected in the team. */
export interface Issue {
  severity: "info" | "warning" | "critical";
  slot_id?: number;
  message: string;
}

/** Full team status snapshot. */
export interface TeamStatus {
  session_id: string;
  session_name: string;
  overall: string;
  elapsed: number;
  agents: AgentStatus[];
  issues: Issue[];
  recent_messages: Message[];
  plan_total: number;
  plan_done: number;
  plan_completion: number;
}

/**
 * Assess the health of a single slot based on timing thresholds.
 */
export function assessHealth(slot: Slot): HealthState {
  if (slot.status === "disconnected") {
    return "crashed";
  }

  if (slot.paused) {
    return "healthy"; // Paused agents are intentionally idle
  }

  // Determine last activity time — prefer updated_at from context_snapshot
  const snapshot = slot.context_snapshot ? JSON.parse(slot.context_snapshot) : null;
  const lastActivity = snapshot?.updated_at ?? slot.last_connected ?? 0;
  const elapsed = Date.now() - lastActivity;

  if (elapsed > STUCK_THRESHOLD_MS) {
    return "stuck";
  }
  if (elapsed > SLOW_THRESHOLD_MS) {
    return "slow";
  }
  return "healthy";
}

/**
 * Aggregate team status from all slots in a session.
 */
export async function getTeamStatus(
  sessionId: string,
  brokerClient: BrokerClient,
): Promise<TeamStatus> {
  const [session, slots, recentMessages] = await Promise.all([
    brokerClient.getSession(sessionId),
    brokerClient.listSlots(sessionId),
    brokerClient.getMessageLog(sessionId, { limit: 10 }),
  ]);

  // Fetch plan progress if available
  let planCompletion = -1;
  let planTotal = 0;
  let planDone = 0;
  try {
    const plan = await brokerClient.getPlan(sessionId);
    if (plan?.items && plan.items.length > 0) {
      planTotal = plan.items.length;
      planDone = plan.items.filter((i: any) => i.status === "done").length;
      planCompletion = Math.round((planDone / planTotal) * 100);
    }
  } catch { /* no plan */ }

  const agents: AgentStatus[] = slots.map((slot) => {
    const health = assessHealth(slot);
    const snapshot = safeJsonParse<{ last_summary?: string; last_status?: string }>(
      slot.context_snapshot,
      {},
    );

    return {
      slot_id: slot.id,
      name: slot.display_name ?? `Agent #${slot.id}`,
      role: slot.role ?? "unassigned",
      agent_type: slot.agent_type,
      health,
      task_state: (slot as any).task_state ?? "idle",
      status: slot.paused ? "paused" : slot.status,
      paused: slot.paused,
      last_activity: slot.last_connected
        ? formatDuration(Date.now() - slot.last_connected) + " ago"
        : "never",
      summary: snapshot.last_summary ?? snapshot.last_status ?? "",
    };
  });

  // Collect issues
  const issues: Issue[] = [];
  for (const agent of agents) {
    if (agent.health === "crashed") {
      issues.push({
        severity: "critical",
        slot_id: agent.slot_id,
        message: `${agent.name} has crashed or disconnected`,
      });
    } else if (agent.health === "stuck") {
      issues.push({
        severity: "warning",
        slot_id: agent.slot_id,
        message: `${agent.name} appears stuck (no activity for ${agent.last_activity})`,
      });
    } else if (agent.health === "slow") {
      issues.push({
        severity: "info",
        slot_id: agent.slot_id,
        message: `${agent.name} is responding slowly`,
      });
    }
  }

  // Determine overall status
  const healthCounts = { healthy: 0, slow: 0, stuck: 0, crashed: 0 };
  for (const a of agents) {
    healthCounts[a.health]++;
  }

  let overall: string;
  if (session.status === "paused") {
    overall = "paused";
  } else if (healthCounts.crashed > 0) {
    overall = "degraded";
  } else if (healthCounts.stuck > 0) {
    overall = "issues";
  } else if (healthCounts.slow > 0) {
    overall = "slow";
  } else {
    overall = "healthy";
  }

  const elapsed = Date.now() - session.created_at;

  return {
    session_id: sessionId,
    session_name: session.name,
    overall,
    elapsed,
    agents,
    issues,
    recent_messages: recentMessages,
    plan_total: planTotal,
    plan_done: planDone,
    plan_completion: planCompletion,
  };
}

/**
 * Format a TeamStatus into a human-readable text table for display.
 */
export function formatTeamStatusForDisplay(status: TeamStatus): string {
  const lines: string[] = [];

  // Header
  lines.push(`=== Team: ${status.session_name} ===`);
  const planInfo = status.plan_completion >= 0 ? ` | Plan: ${status.plan_done}/${status.plan_total} (${status.plan_completion}%)` : "";
  lines.push(`Session: ${status.session_id} | Status: ${status.overall} | Elapsed: ${formatDuration(status.elapsed)}${planInfo}`);
  lines.push("");

  // Agent table with task_state
  lines.push("Agents:");
  lines.push("  Name                 | Role              | Health  | Task State            | Status");
  lines.push("  " + "-".repeat(90));

  for (const agent of status.agents) {
    const name = agent.name.padEnd(20).slice(0, 20);
    const role = agent.role.padEnd(17).slice(0, 17);
    const health = agent.health.padEnd(7).slice(0, 7);
    const taskState = (agent.task_state || "idle").padEnd(21).slice(0, 21);
    const agentStatus = agent.paused ? "paused" : agent.status;
    lines.push(`  ${name} | ${role} | ${health} | ${taskState} | ${agentStatus}`);
  }

  // Workflow status summary
  const byTaskState: Record<string, string[]> = {};
  for (const agent of status.agents) {
    const ts = agent.task_state || "idle";
    if (!byTaskState[ts]) byTaskState[ts] = [];
    byTaskState[ts].push(agent.name);
  }
  const stateEntries = Object.entries(byTaskState);
  if (stateEntries.length > 0) {
    lines.push("");
    lines.push("Workflow:");
    for (const [state, names] of stateEntries) {
      const icon = state === "approved" ? "[OK]" : state === "done_pending_review" ? "[REVIEW]" : state === "addressing_feedback" ? "[FIX]" : state === "released" ? "[DONE]" : "[..]";
      lines.push(`  ${icon} ${state}: ${names.join(", ")}`);
    }
  }

  // Issues
  if (status.issues.length > 0) {
    lines.push("");
    lines.push("Issues:");
    for (const issue of status.issues) {
      const icon = issue.severity === "critical" ? "[!]" : issue.severity === "warning" ? "[?]" : "[i]";
      lines.push(`  ${icon} ${issue.message}`);
    }
  }

  // Recent messages
  if (status.recent_messages.length > 0) {
    lines.push("");
    lines.push("Recent messages:");
    for (const msg of status.recent_messages.slice(0, 5)) {
      const time = formatTime(msg.sent_at);
      const from = msg.from_slot_id !== null ? `slot ${msg.from_slot_id}` : msg.from_id;
      const text = msg.text.slice(0, 80);
      lines.push(`  [${time}] ${from}: ${text}`);
    }
  }

  return lines.join("\n");
}
