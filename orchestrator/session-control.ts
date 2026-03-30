// ============================================================================
// multiagents — Session Control
// ============================================================================
// Pause/resume agents, broadcast messages, resolve agent targets, and
// dispatch control actions for the orchestrator.
// ============================================================================

import type { Slot } from "../shared/types.ts";
import type { BrokerClient } from "../shared/broker-client.ts";
import { log } from "../shared/utils.ts";
import { resumeAfterGuardrailAdjusted } from "./guardrails.ts";
import { getTeamStatus, formatTeamStatusForDisplay } from "./progress.ts";

const LOG_PREFIX = "session-ctrl";

/** Result of a control action. */
export interface ControlResult {
  status: string;
  affected?: number;
  message: string;
  agents?: any[];
  warnings?: any[];
  guardrail?: any;
}

/**
 * Main dispatch function for session control actions.
 */
export async function controlSession(
  sessionId: string,
  action: string,
  brokerClient: BrokerClient,
  target?: string,
  value?: number,
): Promise<ControlResult> {
  switch (action) {
    case "pause_all":
      return await pauseAll(sessionId, brokerClient);

    case "resume_all":
      return await resumeAll(sessionId, brokerClient);

    case "pause_agent": {
      if (!target) return { status: "error", message: "Target agent required for pause_agent" };
      const slot = await resolveTarget(sessionId, target, brokerClient);
      if (!slot) return { status: "error", message: `Could not find agent matching "${target}"` };
      await pauseAgent(sessionId, slot, brokerClient);
      return { status: "ok", affected: 1, message: `Paused ${slot.display_name ?? `slot ${slot.id}`}` };
    }

    case "resume_agent": {
      if (!target) return { status: "error", message: "Target agent required for resume_agent" };
      const slot = await resolveTarget(sessionId, target, brokerClient);
      if (!slot) return { status: "error", message: `Could not find agent matching "${target}"` };
      await resumeAgent(sessionId, slot, brokerClient);
      return { status: "ok", affected: 1, message: `Resumed ${slot.display_name ?? `slot ${slot.id}`}` };
    }

    case "extend_budget": {
      if (value === undefined) return { status: "error", message: "Value required for extend_budget" };
      // Extend the session_duration guardrail by the given value
      const guardrails = await brokerClient.getGuardrails(sessionId);
      const duration = guardrails.find((g) => g.id === "session_duration");
      if (!duration) return { status: "error", message: "Session duration guardrail not found" };

      const newValue = duration.current_value + value;
      const updated = await brokerClient.updateGuardrail({
        session_id: sessionId,
        guardrail_id: "session_duration",
        new_value: newValue,
        changed_by: "orchestrator",
        reason: `Extended by ${value} ${duration.unit}`,
      });

      // If session was paused due to this guardrail, resume
      const session = await brokerClient.getSession(sessionId);
      if (session.status === "paused" && session.pause_reason?.includes("session_duration")) {
        await resumeAfterGuardrailAdjusted(sessionId, brokerClient);
      }

      return {
        status: "ok",
        message: `Extended session duration to ${newValue} ${duration.unit}`,
        guardrail: updated,
      };
    }

    case "set_budget": {
      if (!target) return { status: "error", message: "Target guardrail_id required" };
      if (value === undefined) return { status: "error", message: "Value required for set_budget" };

      const updated = await brokerClient.updateGuardrail({
        session_id: sessionId,
        guardrail_id: target,
        new_value: value,
        changed_by: "orchestrator",
      });

      // Check if this resolves a pause
      const session = await brokerClient.getSession(sessionId);
      if (session.status === "paused" && session.pause_reason?.includes(target)) {
        await resumeAfterGuardrailAdjusted(sessionId, brokerClient);
      }

      return {
        status: "ok",
        message: `Set ${target} to ${value}`,
        guardrail: updated,
      };
    }

    case "status": {
      const teamStatus = await getTeamStatus(sessionId, brokerClient);
      const display = formatTeamStatusForDisplay(teamStatus);
      return {
        status: "ok",
        message: display,
        agents: teamStatus.agents,
        warnings: teamStatus.issues,
      };
    }

    default:
      return { status: "error", message: `Unknown action: ${action}` };
  }
}

/**
 * Pause a single agent slot. Sends a control message, holds future messages.
 */
export async function pauseAgent(
  sessionId: string,
  slot: Slot,
  brokerClient: BrokerClient,
): Promise<void> {
  // Send control message to the agent BEFORE holding — otherwise the hold
  // makes the pause message itself undeliverable (review finding #2).
  if (slot.peer_id) {
    await brokerClient.sendMessage({
      from_id: "orchestrator",
      to_id: slot.peer_id,
      text: JSON.stringify({ action: "pause", reason: "Paused by orchestrator" }),
      msg_type: "control",
      session_id: sessionId,
    });
  }

  // Update slot state
  await brokerClient.updateSlot({
    id: slot.id,
    paused: true,
    paused_at: Date.now(),
  });

  // Hold future incoming messages
  await brokerClient.holdMessages(sessionId, slot.id);

  // Release file locks held by this agent
  try {
    const locks = await brokerClient.listFileLocks(sessionId);
    for (const lock of locks) {
      if (lock.held_by_slot === slot.id) {
        await brokerClient.releaseFile({
          session_id: sessionId,
          peer_id: lock.held_by_peer,
          file_path: lock.file_path,
        });
      }
    }
  } catch {
    // Best-effort lock release
  }

  log(LOG_PREFIX, `Paused agent ${slot.display_name ?? slot.id}`);
}

/**
 * Resume a paused agent. Sends resume with any held messages + team changes.
 */
export async function resumeAgent(
  sessionId: string,
  slot: Slot,
  brokerClient: BrokerClient,
): Promise<void> {
  // Update slot state
  await brokerClient.updateSlot({
    id: slot.id,
    paused: false,
    paused_at: null,
  });

  // Release held messages
  await brokerClient.releaseHeldMessages(sessionId, slot.id);

  // Send resume control message
  if (slot.peer_id) {
    await brokerClient.sendMessage({
      from_id: "orchestrator",
      to_id: slot.peer_id,
      text: JSON.stringify({
        action: "resume",
        reason: "Resumed by orchestrator",
      }),
      msg_type: "control",
      session_id: sessionId,
    });
  }

  log(LOG_PREFIX, `Resumed agent ${slot.display_name ?? slot.id}`);
}

/**
 * Resolve a target string to a Slot. Supports matching by:
 * - Exact slot ID (number)
 * - Exact display name
 * - Exact role name
 * - Partial/fuzzy match on name or role
 */
export async function resolveTarget(
  sessionId: string,
  target: string,
  brokerClient: BrokerClient,
): Promise<Slot | null> {
  const slots = await brokerClient.listSlots(sessionId);
  const lower = target.toLowerCase();

  // Try exact slot ID
  const asNum = parseInt(target, 10);
  if (!isNaN(asNum)) {
    const byId = slots.find((s) => s.id === asNum);
    if (byId) return byId;
  }

  // Try exact name match
  const byName = slots.find(
    (s) => s.display_name?.toLowerCase() === lower,
  );
  if (byName) return byName;

  // Try exact role match
  const byRole = slots.find((s) => s.role?.toLowerCase() === lower);
  if (byRole) return byRole;

  // Partial match on name
  const partialName = slots.find(
    (s) => s.display_name?.toLowerCase().includes(lower),
  );
  if (partialName) return partialName;

  // Partial match on role
  const partialRole = slots.find(
    (s) => s.role?.toLowerCase().includes(lower),
  );
  if (partialRole) return partialRole;

  return null;
}

/**
 * Broadcast a message to all connected slots in the session.
 */
export async function broadcastToTeam(
  sessionId: string,
  message: string,
  brokerClient: BrokerClient,
  excludeRoles?: string[],
): Promise<{ delivered_to: number }> {
  const slots = await brokerClient.listSlots(sessionId);
  const excludeSet = new Set((excludeRoles ?? []).map((r) => r.toLowerCase()));

  let deliveredTo = 0;

  for (const slot of slots) {
    // Skip disconnected or paused agents
    if (slot.status !== "connected" || slot.paused) continue;
    if (!slot.peer_id) continue;

    // Skip excluded roles
    if (slot.role && excludeSet.has(slot.role.toLowerCase())) continue;

    await brokerClient.sendMessage({
      from_id: "orchestrator",
      to_id: slot.peer_id,
      text: message,
      msg_type: "broadcast",
      session_id: sessionId,
    });

    deliveredTo++;
  }

  log(LOG_PREFIX, `Broadcast to ${deliveredTo} agents`);
  return { delivered_to: deliveredTo };
}

/** Pause all agents in a session. */
async function pauseAll(
  sessionId: string,
  brokerClient: BrokerClient,
): Promise<ControlResult> {
  await brokerClient.updateSession({
    id: sessionId,
    status: "paused",
    pause_reason: "Paused by orchestrator",
    paused_at: Date.now(),
  });

  const slots = await brokerClient.listSlots(sessionId);
  let affected = 0;

  for (const slot of slots) {
    if (slot.status === "connected" && !slot.paused) {
      await pauseAgent(sessionId, slot, brokerClient);
      affected++;
    }
  }

  return { status: "ok", affected, message: `Paused ${affected} agents` };
}

/** Resume all agents in a session. */
async function resumeAll(
  sessionId: string,
  brokerClient: BrokerClient,
): Promise<ControlResult> {
  await brokerClient.updateSession({
    id: sessionId,
    status: "active",
    pause_reason: null,
    paused_at: null,
  });

  const slots = await brokerClient.listSlots(sessionId);
  let affected = 0;

  for (const slot of slots) {
    if (slot.paused) {
      await resumeAgent(sessionId, slot, brokerClient);
      affected++;
    }
  }

  return { status: "ok", affected, message: `Resumed ${affected} agents` };
}
