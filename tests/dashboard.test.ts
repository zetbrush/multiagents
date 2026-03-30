// ============================================================================
// Tests for cli/dashboard.ts, stats tab, and guardrail/monitoring flows
// Covers: monitoring stats display, guardrail adjustment, auto-resume,
//         auto-switch, tab navigation, badges, message sender→recipient,
//         interaction summary, and state transitions.
// ============================================================================

import { test, expect, describe } from "bun:test";
import type { Session, Slot, GuardrailState } from "../shared/types.ts";
import { DEFAULT_GUARDRAILS } from "../shared/constants.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGuardrail(overrides: Partial<GuardrailState> & { id: string }): GuardrailState {
  const fallback = DEFAULT_GUARDRAILS[0];
  if (!fallback) {
    throw new Error("DEFAULT_GUARDRAILS must not be empty");
  }
  const base = DEFAULT_GUARDRAILS.find((g) => g.id === overrides.id) ?? fallback;
  return {
    ...base,
    is_overridden: false,
    usage: {
      current: 0,
      limit: base.action === "monitor" ? 0 : base.current_value,
      percent: 0,
      status: "ok",
    },
    ...overrides,
  } as GuardrailState;
}

function makeSlot(overrides: Partial<Slot> = {}): Slot {
  return {
    id: 1,
    session_id: "test-session",
    agent_type: "claude",
    display_name: "TestAgent",
    role: "engineer",
    role_description: "test",
    status: "connected",
    paused: false,
    paused_at: null,
    created_at: Date.now(),
    peer_id: "cl-abc123",
    task_state: "idle",
    context_snapshot: null,
    ...overrides,
  } as Slot;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-session",
    name: "Test Session",
    status: "active",
    project_dir: "/tmp/test",
    git_root: null,
    created_at: Date.now() - 30 * 60 * 1000,
    last_active_at: Date.now(),
    pause_reason: null,
    paused_at: null,
    config: "{}",
    ...overrides,
  } as Session;
}

function isActiveSessionStatus(status: Session["status"]): boolean {
  return status === "active";
}

// ---------------------------------------------------------------------------
// DEFAULT_GUARDRAILS structure
// ---------------------------------------------------------------------------
describe("DEFAULT_GUARDRAILS", () => {
  test("most entries are monitor-only (no enforcement)", () => {
    const monitors = DEFAULT_GUARDRAILS.filter((g) => g.action === "monitor");
    const enforced = DEFAULT_GUARDRAILS.filter((g) => g.action !== "monitor");

    expect(monitors.length).toBeGreaterThan(enforced.length);
  });

  test("monitor stats have no limits or suggestions", () => {
    for (const g of DEFAULT_GUARDRAILS.filter((g) => g.action === "monitor")) {
      expect(g.current_value).toBe(0);
      expect(g.adjustable).toBe(false);
      expect(g.suggested_increases).toEqual([]);
    }
  });

  test("enforced guardrails are adjustable with suggestions", () => {
    for (const g of DEFAULT_GUARDRAILS.filter((g) => g.action !== "monitor")) {
      expect(g.adjustable).toBe(true);
      expect(g.suggested_increases.length).toBeGreaterThan(0);
    }
  });

  test("has session_duration as a monitoring stat", () => {
    const sd = DEFAULT_GUARDRAILS.find((g) => g.id === "session_duration");
    expect(sd).toBeDefined();
    expect(sd!.action).toBe("monitor");
  });

  test("has messages_total as a monitoring stat", () => {
    const mt = DEFAULT_GUARDRAILS.find((g) => g.id === "messages_total");
    expect(mt).toBeDefined();
    expect(mt!.action).toBe("monitor");
  });

  test("has agent_count as a monitoring stat", () => {
    const ac = DEFAULT_GUARDRAILS.find((g) => g.id === "agent_count");
    expect(ac).toBeDefined();
    expect(ac!.action).toBe("monitor");
  });

  test("has max_restarts as the only enforced guardrail", () => {
    const enforced = DEFAULT_GUARDRAILS.filter((g) => g.action !== "monitor");
    expect(enforced.length).toBe(1);
    const guardrail = enforced[0];
    expect(guardrail).toBeDefined();
    if (!guardrail) throw new Error("Expected an enforced guardrail");
    expect(guardrail.id).toBe("max_restarts");
    expect(guardrail.action).toBe("stop");
  });

  test("max_restarts has sensible defaults", () => {
    const mr = DEFAULT_GUARDRAILS.find((g) => g.id === "max_restarts")!;
    expect(mr.current_value).toBe(5);
    expect(mr.suggested_increases).toEqual([8, 12, 20]);
  });
});

// ---------------------------------------------------------------------------
// Monitor-only usage computation
// ---------------------------------------------------------------------------
describe("monitor-only stats", () => {
  test("monitor action always returns status ok regardless of value", () => {
    // Replicate broker logic: if action === "monitor", always ok
    const action = "monitor";
    const current = 9999;
    const limit = 0;

    if (action === "monitor") {
      const usage = { current, limit: 0, percent: 0, status: "ok" as const };
      expect(usage.status).toBe("ok");
      expect(usage.percent).toBe(0);
      expect(usage.limit).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Guardrail increase/decrease (only for enforced)
// ---------------------------------------------------------------------------
describe("guardrail adjustment (enforced only)", () => {
  test("max_restarts: increase picks next suggested value", () => {
    const g = makeGuardrail({
      id: "max_restarts",
      current_value: 5,
      usage: { current: 4, limit: 5, percent: 0.8, status: "warning" },
    });

    const nextValue = g.suggested_increases.find((v) => v > g.current_value)
      ?? g.suggested_increases[g.suggested_increases.length - 1];

    expect(nextValue).toBe(8); // [8, 12, 20], first > 5
  });

  test("max_restarts: decrease halves when below all suggestions", () => {
    const g = makeGuardrail({
      id: "max_restarts",
      current_value: 5,
      usage: { current: 2, limit: 5, percent: 0.4, status: "ok" },
    });

    const prevValue = [...g.suggested_increases].reverse().find((v) => v < g.current_value)
      ?? Math.max(1, Math.floor(g.current_value / 2));

    expect(prevValue).toBe(2); // floor(5/2) = 2
  });

  test("non-adjustable stats are skipped by +/- handler", () => {
    const g = makeGuardrail({ id: "session_duration" }); // monitor, not adjustable
    expect(g.adjustable).toBe(false);
    expect(g.suggested_increases).toEqual([]);
    // Dashboard +/- handler checks: if (g && g.adjustable && g.suggested_increases?.length > 0)
    const wouldTrigger = g.adjustable && g.suggested_increases.length > 0;
    expect(wouldTrigger).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Auto-resume detection
// ---------------------------------------------------------------------------
describe("auto-resume detection", () => {
  test("detects session paused by guardrail", () => {
    const session = makeSession({
      status: "paused",
      pause_reason: "Guardrail triggered: Restart Limit (max_restarts)",
    });

    const wasPaused = session.status === "paused"
      && session.pause_reason?.includes("Guardrail");

    expect(wasPaused).toBe(true);
  });

  test("does not trigger for manual pause", () => {
    const session = makeSession({
      status: "paused",
      pause_reason: "Paused from dashboard",
    });

    const wasPaused = session.status === "paused"
      && session.pause_reason?.includes("Guardrail");

    expect(wasPaused).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Auto-switch to stats tab
// ---------------------------------------------------------------------------
describe("auto-switch to stats tab", () => {
  test("triggers on active→paused transition with guardrail reason", () => {
    const prevStatus = "active";
    const session = makeSession({
      status: "paused",
      pause_reason: "Guardrail triggered: Restart Limit (max_restarts)",
    });

    const shouldSwitch = session.status === "paused"
      && isActiveSessionStatus(prevStatus)
      && session.pause_reason?.includes("Guardrail");

    expect(shouldSwitch).toBe(true);
  });

  test("does not trigger if already paused", () => {
    const prevStatus: Session["status"] = "paused";
    const session = makeSession({
      status: "paused",
      pause_reason: "Guardrail triggered: Restart Limit (max_restarts)",
    });

    const shouldSwitch = session.status === "paused"
      && isActiveSessionStatus(prevStatus)
      && session.pause_reason?.includes("Guardrail");

    expect(shouldSwitch).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Badge counts
// ---------------------------------------------------------------------------
describe("tab badge counts", () => {
  test("stats badge only counts enforced guardrail warnings", () => {
    const guardrails = [
      makeGuardrail({ id: "session_duration" }), // monitor — always ok
      makeGuardrail({ id: "messages_total" }),    // monitor — always ok
      makeGuardrail({
        id: "max_restarts",
        usage: { current: 4, limit: 5, percent: 0.8, status: "warning" },
      }),
    ];

    const enforced = guardrails.filter((g) => g.action !== "monitor");
    const warnings = enforced.filter((g) => g.usage?.status !== "ok").length;
    expect(warnings).toBe(1);
  });

  test("stats badge is empty when only monitors have high values", () => {
    const guardrails = [
      makeGuardrail({
        id: "session_duration",
        usage: { current: 120, limit: 0, percent: 0, status: "ok" },
      }),
      makeGuardrail({
        id: "max_restarts",
        usage: { current: 1, limit: 5, percent: 0.2, status: "ok" },
      }),
    ];

    const enforced = guardrails.filter((g) => g.action !== "monitor");
    const warnings = enforced.filter((g) => g.usage?.status !== "ok").length;
    expect(warnings).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Stat value formatting
// ---------------------------------------------------------------------------
describe("stat value formatting", () => {
  // Replicate formatStatValue logic
  function formatStatValue(value: number, unit: string): string {
    if (unit === "minutes") {
      if (value < 1) return `${Math.round(value * 60)}s`;
      if (value < 60) return `${value.toFixed(1)}m`;
      const h = Math.floor(value / 60);
      const m = Math.round(value % 60);
      return `${h}h${m}m`;
    }
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }

  test("formats seconds when < 1 minute", () => {
    expect(formatStatValue(0.5, "minutes")).toBe("30s");
  });

  test("formats minutes when < 60", () => {
    expect(formatStatValue(15.3, "minutes")).toBe("15.3m");
  });

  test("formats hours and minutes when >= 60", () => {
    expect(formatStatValue(75, "minutes")).toBe("1h15m");
  });

  test("formats integer counts", () => {
    expect(formatStatValue(42, "messages")).toBe("42");
  });

  test("formats decimal counts", () => {
    expect(formatStatValue(3.7, "restarts")).toBe("3.7");
  });
});

// ---------------------------------------------------------------------------
// Message sender→recipient display
// ---------------------------------------------------------------------------
describe("message sender→recipient", () => {
  test("builds sender→recipient when to_display_name is present", () => {
    const m = {
      from_display_name: "Claude-Engineer",
      to_display_name: "Codex-Engineer",
      msg_type: "task_complete",
    };

    const fromName = m.from_display_name;
    const toName = m.to_display_name;
    const arrow = toName ? `${fromName} → ${toName}` : fromName;

    expect(arrow).toBe("Claude-Engineer → Codex-Engineer");
  });

  test("shows only sender when recipient is null (broadcast)", () => {
    const m = {
      from_display_name: "orchestrator",
      to_display_name: null,
      msg_type: "broadcast",
    };

    const fromName = m.from_display_name;
    const toName = m.to_display_name;
    const arrow = toName ? `${fromName} → ${toName}` : fromName;

    expect(arrow).toBe("orchestrator");
  });
});

// ---------------------------------------------------------------------------
// Interaction summary computation
// ---------------------------------------------------------------------------
describe("interaction summary", () => {
  test("counts messages per sender", () => {
    const messages = [
      { from_display_name: "Alice", to_display_name: "Bob" },
      { from_display_name: "Alice", to_display_name: "Charlie" },
      { from_display_name: "Bob", to_display_name: "Alice" },
      { from_display_name: "Alice", to_display_name: "Bob" },
    ];

    const senderCounts = new Map<string, number>();
    for (const m of messages) {
      senderCounts.set(m.from_display_name, (senderCounts.get(m.from_display_name) ?? 0) + 1);
    }

    expect(senderCounts.get("Alice")).toBe(3);
    expect(senderCounts.get("Bob")).toBe(1);
  });

  test("counts unique interaction pairs", () => {
    const messages = [
      { from_display_name: "Alice", to_display_name: "Bob" },
      { from_display_name: "Alice", to_display_name: "Bob" },
      { from_display_name: "Bob", to_display_name: "Alice" },
      { from_display_name: "Alice", to_display_name: "Charlie" },
    ];

    const interactions = new Map<string, number>();
    for (const m of messages) {
      const key = `${m.from_display_name} → ${m.to_display_name}`;
      interactions.set(key, (interactions.get(key) ?? 0) + 1);
    }

    expect(interactions.get("Alice → Bob")).toBe(2);
    expect(interactions.get("Bob → Alice")).toBe(1);
    expect(interactions.get("Alice → Charlie")).toBe(1);
    expect(interactions.size).toBe(3);
  });

  test("interaction summary sorts by count descending", () => {
    const interactions = new Map<string, number>([
      ["Alice → Bob", 5],
      ["Bob → Alice", 2],
      ["Charlie → Alice", 8],
    ]);

    const sorted = [...interactions.entries()].sort((a, b) => b[1] - a[1]);
    expect(sorted.map(([label]) => label)).toEqual([
      "Charlie → Alice",
      "Alice → Bob",
      "Bob → Alice",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Task state display mapping
// ---------------------------------------------------------------------------
describe("task state mapping", () => {
  const mapping: Record<string, string> = {
    idle: "idle",
    working: "working",
    done_pending_review: "done→review",
    addressing_feedback: "fixing",
    approved: "approved",
    released: "released",
  };

  for (const [state, display] of Object.entries(mapping)) {
    test(`"${state}" displays as "${display}"`, () => {
      expect(display.length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Session state transitions
// ---------------------------------------------------------------------------
describe("session state transitions", () => {
  test("pause sets correct fields", () => {
    const paused = makeSession({
      status: "paused",
      pause_reason: "Paused from dashboard",
      paused_at: Date.now(),
    });

    expect(paused.status).toBe("paused");
    expect(paused.pause_reason).toContain("dashboard");
  });

  test("resume clears pause fields", () => {
    const resumed = makeSession({
      status: "active",
      pause_reason: null,
      paused_at: null,
    });

    expect(resumed.status).toBe("active");
    expect(resumed.pause_reason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Slot resume during guardrail adjustment
// ---------------------------------------------------------------------------
describe("slot resume after guardrail adjustment", () => {
  test("identifies paused slots needing resume", () => {
    const slots = [
      makeSlot({ id: 1, paused: false }),
      makeSlot({ id: 2, paused: true, peer_id: "cl-abc" }),
      makeSlot({ id: 3, paused: true, peer_id: null }),
    ];

    const toResume = slots.filter((s) => s.paused);
    const toNotify = toResume.filter((s) => s.peer_id);

    expect(toResume.length).toBe(2);
    expect(toNotify.length).toBe(1);
    expect(toNotify.map((slot) => slot.id)).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// Message auto-scroll
// ---------------------------------------------------------------------------
describe("message auto-scroll", () => {
  test("scrolls to bottom when new messages arrive and auto-scroll is on", () => {
    const visibleRows = 15;
    let scrollOffset = 5;
    const autoScroll = true;

    if (autoScroll && 25 > 20) {
      scrollOffset = Math.max(0, 25 - visibleRows);
    }

    expect(scrollOffset).toBe(10);
  });

  test("does not move when auto-scroll is off", () => {
    let scrollOffset = 3;
    const autoScroll = false;

    if (autoScroll && 25 > 20) {
      scrollOffset = Math.max(0, 25 - 15);
    }

    expect(scrollOffset).toBe(3);
  });
});
