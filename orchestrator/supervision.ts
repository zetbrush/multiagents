// ============================================================================
// multiagents — Orchestrator supervision
// ============================================================================
// Decisions the orchestrator's background loops make about driver-managed
// agents, kept apart from the MCP server so they can be tested on their own.
// ============================================================================

import type { DriverSlot } from "./delivery.ts";
import type { PeekResult } from "../shared/types.ts";

export interface UsageLimits {
  /** input + output tokens per agent */
  agent_tokens?: number;
  agent_cost_usd?: number;
  /** input + output tokens summed over the session's agents */
  session_tokens?: number;
  session_cost_usd?: number;
}

export interface SlotUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_usd?: number | null;
}

export function slotTokens(slot: SlotUsage): number {
  return (slot.input_tokens ?? 0) + (slot.output_tokens ?? 0);
}

/**
 * Why an agent must stop (a limit it reached), or null. `agentTokenLimit` is
 * the agent's own limit when set, else the session's per-agent limit.
 */
export function limitVerdict(slot: SlotUsage, all: SlotUsage[], limits: UsageLimits, agentTokenLimit?: number): string | null {
  const positive = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
  const perAgent = positive(agentTokenLimit) ?? positive(limits.agent_tokens);
  const tokens = slotTokens(slot);
  if (perAgent && tokens >= perAgent) return `token limit reached (${tokens.toLocaleString("en-US")} / ${perAgent.toLocaleString("en-US")})`;
  const agentCost = positive(limits.agent_cost_usd);
  if (agentCost && (slot.cost_usd ?? 0) >= agentCost) return `cost limit reached ($${(slot.cost_usd ?? 0).toFixed(2)} / $${agentCost.toFixed(2)})`;
  const sessionTokens = positive(limits.session_tokens);
  const total = all.reduce((a, s) => a + slotTokens(s), 0);
  if (sessionTokens && total >= sessionTokens) return `session token limit reached (${total.toLocaleString("en-US")} / ${sessionTokens.toLocaleString("en-US")})`;
  const sessionCost = positive(limits.session_cost_usd);
  const cost = all.reduce((a, s) => a + (s.cost_usd ?? 0), 0);
  if (sessionCost && cost >= sessionCost) return `session cost limit reached ($${cost.toFixed(2)} / $${sessionCost.toFixed(2)})`;
  return null;
}

/** Driver-managed agents per session; a slot holds at most one driver. */
export class DriverRegistry {
  private bySession = new Map<string, Map<number, DriverSlot>>();

  get(sessionId: string, slotId: number): DriverSlot | undefined {
    return this.bySession.get(sessionId)?.get(slotId);
  }

  has(sessionId: string, slotId: number): boolean {
    return this.get(sessionId, slotId) !== undefined;
  }

  isLive(sessionId: string, slotId: number): boolean {
    return this.get(sessionId, slotId)?.driver.alive === true;
  }

  sessions(): IterableIterator<[string, Map<number, DriverSlot>]> {
    return this.bySession.entries();
  }

  sessionIds(): IterableIterator<string> {
    return this.bySession.keys();
  }

  /** Registers `state` for the slot; returns a live driver it displaces, which the caller must stop. */
  track(sessionId: string, slotId: number, state: DriverSlot): DriverSlot | null {
    let slots = this.bySession.get(sessionId);
    if (!slots) {
      slots = new Map();
      this.bySession.set(sessionId, slots);
    }
    const previous = slots.get(slotId);
    slots.set(slotId, state);
    return previous && previous !== state && previous.driver.alive ? previous : null;
  }

  /** Forgets `state` if the slot still holds it; false means it was already replaced or its session dropped. */
  detach(sessionId: string, slotId: number, state: DriverSlot): boolean {
    const slots = this.bySession.get(sessionId);
    if (!slots || slots.get(slotId) !== state) return false;
    slots.delete(slotId);
    return true;
  }

  delete(sessionId: string, slotId: number): DriverSlot | undefined {
    const slots = this.bySession.get(sessionId);
    const state = slots?.get(slotId);
    slots?.delete(slotId);
    return state;
  }

  dropSession(sessionId: string): Map<number, DriverSlot> | undefined {
    const slots = this.bySession.get(sessionId);
    this.bySession.delete(sessionId);
    return slots;
  }
}

/** Wraps a loop body so a tick that starts while the previous one still runs is skipped. */
export function nonOverlapping(fn: () => Promise<void>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  };
}

/** An agent told to keep polling may never end its turn: "idle" also means no output for this long after release. */
export const RELEASE_IDLE_MS = 60_000;
/** After this long since release the driver is closed whatever it is doing. */
export const RELEASE_MAX_WAIT_MS = 10 * 60_000;

export interface ReleaseInput {
  /** A forwarding turn started by the delivery loop is in progress. */
  busy: boolean;
  turnActive: boolean;
  /** Last time the driver produced output; for Codex that is a notification, since heartbeat replies prove nothing. */
  lastOutputAt: number;
  releasedAt: number;
  /** Messages (the release notice among them) not yet delivered to the agent. */
  pendingCount: number;
  now: number;
}

export function releaseVerdict(input: ReleaseInput): "keep" | "close" {
  if (input.now - input.releasedAt >= RELEASE_MAX_WAIT_MS) return "close";
  if (input.busy) return "keep";
  if (input.turnActive && input.now - input.lastOutputAt < RELEASE_IDLE_MS) return "keep";
  if (input.pendingCount > 0) return "keep";
  return "close";
}

export interface WatchdogInbox {
  count: number;
  msg_types: string[];
  oldest_at: number;
}

/**
 * The inbox the watchdog judges a slot by. A connected agent is only "not
 * polling" while messages stay unclaimed — a claimed but unacked one is merely
 * waiting for the agent's next tool call. A disconnected slot needs a respawn
 * for anything unacked. Paused agents are never judged.
 */
export function watchdogInbox(slot: { status: string; paused: boolean }, peek: PeekResult): WatchdogInbox | null {
  if (slot.paused === true || (slot.paused as unknown as number) === 1) return null;
  if (slot.status === "connected") {
    return { count: peek.unclaimed_count, msg_types: peek.unclaimed_msg_types, oldest_at: peek.unclaimed_oldest_at };
  }
  return { count: peek.count, msg_types: peek.msg_types, oldest_at: peek.oldest_at };
}

// --- Dead slot cleanup ---

/** A slot that has been disconnected this long may be an orphan */
export const DEAD_SLOT_AFTER_MS = 5 * 60 * 1000;

export interface DeadSlotInput {
  slot: { status: string; task_state: string; last_connected: number | null; last_disconnected: number | null; paused?: boolean | number };
  /** The slot's process is driven by this host (it controls the lifecycle) */
  driven: boolean;
  /** The slot ever sent a message or is assigned a plan item: it took part in the work */
  tookPart: boolean;
  /** The session is paused, waits on a person (human gate, Q&A) or is archived */
  sessionOnHold: boolean;
  now: number;
}

/**
 * Whether the background loop may delete a disconnected slot. Only orphans go:
 * an agent that connected, never started working and never took part. A slot
 * whose agent worked — approved, done, released, or just in the middle of it —
 * stays (shown as offline) until a person removes it, and nothing is deleted
 * while the session is paused or waits on a person.
 */
export function deadSlotVerdict(input: DeadSlotInput): "keep" | "delete" {
  const { slot } = input;
  if (slot.status !== "disconnected") return "keep";
  // Never connected: still starting up
  if (!slot.last_connected) return "keep";
  if (input.driven || input.sessionOnHold || slot.paused === true || slot.paused === 1) return "keep";
  if (slot.task_state !== "idle" || input.tookPart) return "keep";
  const disconnectedAt = slot.last_disconnected ?? slot.last_connected;
  return input.now - disconnectedAt >= DEAD_SLOT_AFTER_MS ? "delete" : "keep";
}
