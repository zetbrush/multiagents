// ============================================================================
// multiagents — Guardrail Enforcement
// ============================================================================
// Checks guardrail limits (duration, message counts, agent counts, etc.)
// and enforces them by pausing/warning as needed.
// ============================================================================

import type { Guardrail, GuardrailState } from "../shared/types.ts";
import type { BrokerClient } from "../shared/broker-client.ts";
import type { AgentEvent } from "./monitor.ts";
import { log } from "../shared/utils.ts";

const LOG_PREFIX = "guardrails";

/** Result of checking a single guardrail. */
export interface GuardrailCheck {
  guardrail: GuardrailState;
  status: "ok" | "warning" | "triggered";
  message: string;
}

/**
 * Check all guardrails for a session and return their current status.
 * Fetches guardrail state from the broker (which computes usage).
 */
export async function checkGuardrails(
  sessionId: string,
  brokerClient: BrokerClient,
): Promise<GuardrailCheck[]> {
  const guardrails = await brokerClient.getGuardrails(sessionId);
  const checks: GuardrailCheck[] = [];

  for (const g of guardrails) {
    const { usage } = g;

    if (usage.status === "triggered") {
      checks.push({
        guardrail: g,
        status: "triggered",
        message: `${g.label} reached limit: ${usage.current}/${usage.limit} ${g.unit} (${Math.round(usage.percent * 100)}%)`,
      });
    } else if (usage.status === "warning") {
      checks.push({
        guardrail: g,
        status: "warning",
        message: `${g.label} approaching limit: ${usage.current}/${usage.limit} ${g.unit} (${Math.round(usage.percent * 100)}%)`,
      });
    } else {
      checks.push({
        guardrail: g,
        status: "ok",
        message: `${g.label}: ${usage.current}/${usage.limit} ${g.unit} (${Math.round(usage.percent * 100)}%)`,
      });
    }
  }

  return checks;
}

/**
 * Run guardrail checks and enforce limits:
 * - Emit warning events when warn_at_percent is reached
 * - Pause session when a guardrail is triggered at 100%
 */
export async function enforceGuardrails(
  sessionId: string,
  brokerClient: BrokerClient,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  const checks = await checkGuardrails(sessionId, brokerClient);

  for (const check of checks) {
    // Skip monitor-only stats — they never trigger enforcement
    if (check.guardrail.action === "monitor") continue;

    if (check.status === "warning") {
      onEvent({
        type: "guardrail_warning",
        severity: "warning",
        slotId: -1,
        sessionId,
        message: check.message,
        data: {
          guardrail_id: check.guardrail.id,
          usage_percent: check.guardrail.usage.percent,
          current: check.guardrail.usage.current,
          limit: check.guardrail.usage.limit,
        },
      });
    }

    if (check.status === "triggered") {
      const { guardrail } = check;

      if (guardrail.action === "pause") {
        log(LOG_PREFIX, `Guardrail triggered — pausing session: ${check.message}`);
        await pauseForGuardrail(sessionId, guardrail, brokerClient);

        onEvent({
          type: "guardrail_triggered",
          severity: "critical",
          slotId: -1,
          sessionId,
          message: `Session paused: ${check.message}`,
          data: {
            guardrail_id: guardrail.id,
            action: "pause",
            suggested_increases: guardrail.suggested_increases,
            adjustable: guardrail.adjustable,
          },
        });
      } else if (guardrail.action === "stop") {
        log(LOG_PREFIX, `Guardrail triggered — stop action: ${check.message}`);

        onEvent({
          type: "guardrail_triggered",
          severity: "critical",
          slotId: -1,
          sessionId,
          message: `Guardrail stop: ${check.message}`,
          data: {
            guardrail_id: guardrail.id,
            action: "stop",
            suggested_increases: guardrail.suggested_increases,
            adjustable: guardrail.adjustable,
          },
        });
      } else if (guardrail.action === "warn") {
        onEvent({
          type: "guardrail_triggered",
          severity: "warning",
          slotId: -1,
          sessionId,
          message: check.message,
          data: {
            guardrail_id: guardrail.id,
            action: "warn",
          },
        });
      }
    }
  }
}

/**
 * Pause the entire session due to a guardrail being triggered.
 * Sends control messages to all connected agents and marks session as paused.
 */
export async function pauseForGuardrail(
  sessionId: string,
  guardrail: Guardrail | GuardrailState,
  brokerClient: BrokerClient,
): Promise<void> {
  // Mark session as paused
  await brokerClient.updateSession({
    id: sessionId,
    status: "paused",
    pause_reason: `Guardrail triggered: ${guardrail.label} (${guardrail.id})`,
    paused_at: Date.now(),
  });

  // Pause all connected slots
  const slots = await brokerClient.listSlots(sessionId);
  for (const slot of slots) {
    if (slot.status === "connected" && !slot.paused) {
      await brokerClient.updateSlot({
        id: slot.id,
        paused: true,
        paused_at: Date.now(),
      });

      // Hold messages for paused agents
      await brokerClient.holdMessages(sessionId, slot.id);

      // Send control message if agent has a peer connection
      if (slot.peer_id) {
        await brokerClient.sendMessage({
          from_id: "orchestrator",
          to_id: slot.peer_id,
          text: JSON.stringify({
            action: "pause",
            reason: `Guardrail "${guardrail.label}" reached limit`,
            guardrail_id: guardrail.id,
            adjustable: guardrail.adjustable,
            suggested_increases: guardrail.suggested_increases,
          }),
          msg_type: "control",
          session_id: sessionId,
        });
      }
    }
  }

  log(LOG_PREFIX, `Session ${sessionId} paused for guardrail: ${guardrail.id}`);
}

/**
 * Resume a session after a guardrail limit has been adjusted upward.
 * Unpauses all slots and releases held messages.
 */
export async function resumeAfterGuardrailAdjusted(
  sessionId: string,
  brokerClient: BrokerClient,
): Promise<void> {
  // Update session status
  await brokerClient.updateSession({
    id: sessionId,
    status: "active",
    pause_reason: null,
    paused_at: null,
  });

  // Resume all paused slots
  const slots = await brokerClient.listSlots(sessionId);
  for (const slot of slots) {
    if (slot.paused) {
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
            reason: "Guardrail limit adjusted",
          }),
          msg_type: "control",
          session_id: sessionId,
        });
      }
    }
  }

  log(LOG_PREFIX, `Session ${sessionId} resumed after guardrail adjustment`);
}
