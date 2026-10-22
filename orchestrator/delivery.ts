// ============================================================================
// multiagents — Driver-side message delivery
// ============================================================================
// Hands unacked broker messages for a driver-managed slot to its driver and
// acks them only once the driver confirms the hand-off, so a failed delivery
// is retried on the next cycle instead of being lost.
// ============================================================================

import type { BrokerClient } from "../shared/broker-client.ts";
import type { Message } from "../shared/types.ts";
import type { CodexDriver } from "./codex-driver.ts";
import type { ClaudeSession } from "./claude-driver.ts";
import { log } from "../shared/utils.ts";
import { HUMAN_SENDER, HUMAN_SENDER_LABEL } from "../shared/constants.ts";

const LOG_PREFIX = "delivery";

/** Settings last applied to a running driver (compared with the slot's to apply changes live). */
export interface AppliedSettings {
  model?: string;
  effort?: string;
  approvalMode: string;
}

/** The settings an agent was launched with ("launch" for Claude's auto mode, which is switched to once running). */
export function launchedSettings(kind: "claude" | "codex", s: { model?: string; effort?: string; approvalMode?: string }): AppliedSettings {
  const mode = s.approvalMode ?? "bypass";
  return { model: s.model, effort: s.effort, approvalMode: kind === "claude" && mode === "auto" ? "launch" : mode };
}

/** Supervision state kept next to every driver. */
interface DriverSupervision {
  busy: boolean;
  lastNudge: number;
  releasedAt?: number;
  applied?: AppliedSettings;
  /** The running turn was interrupted because the slot got paused */
  pauseInterrupted?: boolean;
}

export type DriverSlot =
  | ({ kind: "codex"; driver: CodexDriver; threadId: string | null } & DriverSupervision)
  // Claude CLI sessions and API agents (both speak Claude's stream-json events)
  | ({ kind: "claude"; driver: ClaudeSession; inflight?: Set<number> } & DriverSupervision);

export type DeliveryOutcome = "dead" | "not_ready" | "busy" | "none" | "in_flight" | "steered" | "replied" | "sent" | "failed";

type SenderInfo = { display_name: string | null; role: string | null };

/** One line per message: type, sender name/role and the peer id to reply to. */
export function formatForwardedMessages(messages: Message[], senders: Map<number, SenderInfo>): string {
  return messages.map((m) => {
    if (m.from_id === HUMAN_SENDER) return `[${m.msg_type}] ${HUMAN_SENDER_LABEL}: ${m.text}`;
    const sender = m.from_slot_id !== null ? senders.get(m.from_slot_id) : undefined;
    const name = sender?.display_name ?? (m.from_slot_id !== null ? `slot ${m.from_slot_id}` : m.from_id);
    const role = sender?.role ? ` (${sender.role})` : "";
    const idTag = name !== m.from_id && !isOrchestrator(m.from_id) ? ` [id ${m.from_id}]` : "";
    return `[${m.msg_type}] ${name}${role}${idTag}: ${m.text}`;
  }).join("\n\n---\n\n");
}

function isOrchestrator(peerId: string): boolean {
  return peerId === "orchestrator" || peerId === "__orchestrator__";
}

export function buildForwardingPrompt(formatted: string): string {
  return `[Teammate messages]\n${formatted}\n\nReply with send_message where a reply is expected, then continue your current task.`;
}

/** Deliver whatever is pending for `slotId` through its driver. */
export async function deliverPendingMessages(
  sessionId: string,
  slotId: number,
  state: DriverSlot,
  brokerClient: BrokerClient,
): Promise<DeliveryOutcome> {
  if (!state.driver.alive) return "dead";
  const threadId = state.kind === "codex" ? (state.threadId ?? state.driver.threadId) : null;
  if (state.kind === "codex" && !threadId) return "not_ready";
  if (state.busy) return "busy";

  const poll = await brokerClient.pollBySlot(slotId, { retain: true });
  const pending = poll.messages ?? [];
  if (pending.length === 0) return "none";

  if (state.kind === "claude") return deliverToClaude(sessionId, slotId, state, pending, brokerClient);

  const prompt = buildForwardingPrompt(formatForwardedMessages(pending, await senderMap(sessionId, brokerClient)));
  const ids = pending.map((m) => m.id);
  log(LOG_PREFIX, `Forwarding ${pending.length} message(s) to codex slot ${slotId}`);

  if (state.driver.activeTurnId) {
    try {
      await state.driver.steer(threadId!, prompt);
    } catch (err) {
      log(LOG_PREFIX, `Steer failed for slot ${slotId} (will retry): ${err instanceof Error ? err.message : String(err)}`);
      return "failed";
    }
    await ack(brokerClient, ids);
    return "steered";
  }

  state.busy = true;
  state.driver.reply(threadId!, prompt)
    .then(async (result) => {
      state.threadId = result.threadId;
      await ack(brokerClient, ids);
      await brokerClient.updateSlot({
        id: slotId,
        context_patch: {
          codex_thread_id: result.threadId,
          last_summary: result.content.slice(0, 200),
          last_status: "working",
          updated_at: Date.now(),
        },
      }).catch(() => {});
    })
    .catch((err) => {
      log(LOG_PREFIX, `Forwarding turn failed for slot ${slotId} (messages stay unacked): ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      state.busy = false;
    });
  return "replied";
}

/**
 * Claude reads queued stdin at its next tool-call boundary and echoes a message
 * only then — minutes later during a long tool call. The ack waits for that
 * echo; meanwhile the ids are in flight so no tick writes them again, and a
 * host that exits first leaves them unacked for its successor.
 */
async function deliverToClaude(
  sessionId: string,
  slotId: number,
  state: Extract<DriverSlot, { kind: "claude" }>,
  pending: Message[],
  brokerClient: BrokerClient,
): Promise<DeliveryOutcome> {
  const inflight = (state.inflight ??= new Set<number>());
  const messages = pending.filter((m) => !inflight.has(m.id));
  if (messages.length === 0) return "in_flight";

  const prompt = buildForwardingPrompt(formatForwardedMessages(messages, await senderMap(sessionId, brokerClient)));
  const ids = messages.map((m) => m.id);
  if (!state.driver.alive) return "dead";
  log(LOG_PREFIX, `Forwarding ${messages.length} message(s) to claude slot ${slotId}`);

  for (const id of ids) inflight.add(id);
  state.driver.send(prompt, { echoTimeoutMs: Infinity })
    .then(async (echoed) => {
      if (echoed) await ack(brokerClient, ids);
      else log(LOG_PREFIX, `Claude slot ${slotId} exited before reading ${ids.length} message(s) — left for its successor`);
    })
    .catch((err) => log(LOG_PREFIX, `Claude slot ${slotId} send failed (messages stay unacked): ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => { for (const id of ids) inflight.delete(id); });
  return "sent";
}

async function ack(brokerClient: BrokerClient, ids: number[]): Promise<void> {
  try {
    await brokerClient.ackMessages(ids);
  } catch (err) {
    log(LOG_PREFIX, `Ack failed for ${ids.length} message(s): ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function senderMap(sessionId: string, brokerClient: BrokerClient): Promise<Map<number, SenderInfo>> {
  try {
    const slots = await brokerClient.listSlots(sessionId);
    return new Map(slots.map((s) => [s.id, { display_name: s.display_name, role: s.role }]));
  } catch {
    return new Map();
  }
}
