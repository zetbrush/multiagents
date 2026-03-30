// ============================================================================
// multiagents — Crash Recovery
// ============================================================================
// Handles agent crashes: flap detection, context preservation, respawn with
// handoff prompts.
// ============================================================================

import type { BrokerClient } from "../shared/broker-client.ts";
import type { AgentEvent } from "./monitor.ts";
import { FLAP_THRESHOLD, FLAP_WINDOW_MS } from "../shared/constants.ts";
import { log, safeJsonParse, formatDuration } from "../shared/utils.ts";
import { relaunchIntoSlot, buildTeamContext } from "./launcher.ts";

const LOG_PREFIX = "recovery";

/** Track crash timestamps per slot for flap detection. */
const crashHistory: Map<number, number[]> = new Map();

/**
 * Handle an agent crash: check for flapping, gather context, and return
 * an event with suggested actions.
 */
export async function handleAgentCrash(
  slotId: number,
  exitCode: number,
  sessionId: string,
  brokerClient: BrokerClient,
): Promise<AgentEvent> {
  const now = Date.now();

  // Record this crash
  const history = crashHistory.get(slotId) ?? [];
  history.push(now);
  crashHistory.set(slotId, history);

  // Prune old crashes outside the flap window
  const recentCrashes = history.filter((t) => now - t < FLAP_WINDOW_MS);
  crashHistory.set(slotId, recentCrashes);

  // Check for flapping
  const isFlapping = recentCrashes.length >= FLAP_THRESHOLD;

  // Get slot info for context
  let slotName = `Slot ${slotId}`;
  let slotRole = "unknown";
  let lastSummary = "";

  try {
    const slot = await brokerClient.getSlot(slotId);
    slotName = slot.display_name ?? slotName;
    slotRole = slot.role ?? slotRole;
    const snapshot = safeJsonParse<{ last_summary?: string }>(
      slot.context_snapshot,
      {},
    );
    lastSummary = snapshot.last_summary ?? "";
  } catch {
    // Slot may already be cleaned up
  }

  // Build event with suggested actions
  const suggestedActions: string[] = [];

  if (isFlapping) {
    suggestedActions.push("Agent is flapping — do NOT auto-restart");
    suggestedActions.push("Investigate root cause before restarting");
    suggestedActions.push("Consider reassigning this agent's tasks");

    log(
      LOG_PREFIX,
      `${slotName} is flapping: ${recentCrashes.length} crashes in ${formatDuration(FLAP_WINDOW_MS)}`,
    );

    return {
      type: "agent_flapping",
      severity: "critical",
      slotId,
      sessionId,
      message: `${slotName} (${slotRole}) is flapping: ${recentCrashes.length} crashes in ${formatDuration(FLAP_WINDOW_MS)}. Exit code: ${exitCode}`,
      data: {
        exit_code: exitCode,
        crash_count: recentCrashes.length,
        flap_window_ms: FLAP_WINDOW_MS,
        is_flapping: true,
        last_summary: lastSummary,
        suggested_actions: suggestedActions,
      },
    };
  }

  // Not flapping — suggest respawn
  suggestedActions.push("Auto-respawn recommended");
  suggestedActions.push("Respawn will include handoff context from previous run");

  log(LOG_PREFIX, `${slotName} crashed (exit ${exitCode}), crash ${recentCrashes.length}/${FLAP_THRESHOLD} in window`);

  return {
    type: "agent_crashed",
    severity: "critical",
    slotId,
    sessionId,
    message: `${slotName} (${slotRole}) crashed with exit code ${exitCode}. Crash ${recentCrashes.length}/${FLAP_THRESHOLD} in window.`,
    data: {
      exit_code: exitCode,
      crash_count: recentCrashes.length,
      is_flapping: false,
      last_summary: lastSummary,
      suggested_actions: suggestedActions,
    },
  };
}

/**
 * Respawn a crashed agent with a handoff prompt that includes:
 * - The original role and task context
 * - A recap of recent messages
 * - Team roster
 */
export async function respawnAgent(
  sessionId: string,
  slotId: number,
  brokerClient: BrokerClient,
  projectDir: string,
): Promise<{ pid: number; process: import("bun").Subprocess }> {
  // Get the crashed slot's info
  const slot = await brokerClient.getSlot(slotId);
  const snapshot = safeJsonParse<{ last_summary?: string; last_status?: string }>(
    slot.context_snapshot,
    {},
  );

  // Get recent messages for this slot to build recap
  const messages = await brokerClient.getMessageLog(sessionId, {
    limit: 20,
    with_slot: slotId,
  });

  const recapLines = messages.map(
    (m) => `[${m.msg_type}] ${m.from_slot_id !== null ? `slot ${m.from_slot_id}` : m.from_id}: ${m.text.slice(0, 150)}`,
  );

  // Build team context
  const teamContext = await buildTeamContext(sessionId, slotId, brokerClient);

  // Build handoff task prompt
  const handoffTask = [
    `You are being restarted after a crash. Here is your context:`,
    "",
    `Role: ${slot.role ?? "unassigned"}`,
    slot.role_description ? `Role description: ${slot.role_description}` : "",
    snapshot.last_summary ? `Last known status: ${snapshot.last_summary}` : "",
    "",
    teamContext,
    "",
    recapLines.length > 0
      ? `Recent message history:\n${recapLines.join("\n")}`
      : "No recent message history.",
    "",
    "Continue from where you left off. Check the current state of your files before making changes.",
  ]
    .filter(Boolean)
    .join("\n");

  // Relaunch into the EXISTING slot (not a new one) to preserve plan items,
  // file ownership, message history, and task-state continuity (review finding #3).
  const result = await relaunchIntoSlot(sessionId, projectDir, slot, handoffTask, brokerClient);

  log(LOG_PREFIX, `Respawned into existing slot ${slotId} (PID ${result.pid})`);

  return { pid: result.pid, process: result.process };
}
