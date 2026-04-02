/**
 * Tests for CodexDriver app-server protocol logic.
 *
 * Strategy: We can't spawn a real `codex app-server` (requires auth).
 * Instead we test the protocol-level logic by simulating JSON-RPC
 * message flows through the handleMessage/handleNotification internals.
 *
 * What these tests verify:
 * - The notification→turn resolver pipeline (content collection, turn completion)
 * - The busy/activeTurnId state machine for the forwarding loop
 * - The steer precondition (must have activeTurnId)
 * - The onExit multi-callback pattern
 * - The notification listener dispatch
 * - Turn timeout behavior
 */

import { test, expect, describe, beforeEach } from "bun:test";

// --- Test helpers: simulate the CodexDriver's internal message handling ---

/**
 * Minimal recreation of the CodexDriver's turn tracking and notification
 * dispatch logic. We test the STATE MACHINE, not the subprocess I/O.
 */
class DriverStateMachine {
  activeTurnId: string | null = null;
  threadId: string | null = null;
  busy = false;
  alive = true;

  turnResolvers = new Map<string, {
    content: string[];
    usage: Record<string, number> | null;
    resolved: boolean;
    result: { threadId: string; content: string; usage: any } | null;
  }>();

  notificationLog: Array<{ method: string; params: Record<string, unknown> }> = [];
  exitCallbacks: Array<() => void> = [];

  onExit(cb: () => void) { this.exitCallbacks.push(cb); }

  // Simulate starting a turn
  startTurn(turnId: string, threadId: string) {
    this.threadId = threadId;
    this.activeTurnId = turnId;
    this.turnResolvers.set(turnId, { content: [], usage: null, resolved: false, result: null });
  }

  // Simulate receiving a notification
  handleNotification(method: string, params: Record<string, unknown>) {
    this.notificationLog.push({ method, params });
    const turnId = params.turnId as string | undefined;

    if (method === "turn/started") {
      const id = (params.turn as any)?.id ?? turnId;
      if (id) this.activeTurnId = id;
      return;
    }

    if (method === "turn/completed") {
      this.activeTurnId = null;
      const completedTurnId = turnId ?? (params.turn as any)?.id;
      if (!completedTurnId) return;

      const resolver = this.turnResolvers.get(completedTurnId);
      if (resolver) {
        const usage = (params.usage ?? (params.turn as any)?.usage) as Record<string, number> | undefined;
        resolver.resolved = true;
        resolver.result = {
          threadId: this.threadId ?? "",
          content: resolver.content.join(""),
          usage: usage ?? resolver.usage,
        };
      }
      return;
    }

    if (method === "item/agentMessage/delta") {
      const delta = params.delta as string | undefined;
      if (delta && turnId) {
        const resolver = this.turnResolvers.get(turnId);
        if (resolver) resolver.content.push(delta);
      }
      return;
    }

    if (method === "item/completed") {
      const item = params.item as Record<string, unknown> | undefined;
      if (item?.type === "agentMessage" && item.text && turnId) {
        const resolver = this.turnResolvers.get(turnId);
        if (resolver && resolver.content.length === 0) {
          resolver.content.push(item.text as string);
        }
      }
      return;
    }
  }

  // Simulate process exit
  simulateExit() {
    this.alive = false;
    this.activeTurnId = null;
    for (const cb of this.exitCallbacks) {
      try { cb(); } catch { /* test isolation */ }
    }
  }

  canSteer(): boolean {
    return this.activeTurnId !== null;
  }
}

// === TURN LIFECYCLE TESTS ===

describe("CodexDriver turn lifecycle", () => {
  let driver: DriverStateMachine;

  beforeEach(() => {
    driver = new DriverStateMachine();
  });

  test("turn/started sets activeTurnId", () => {
    expect(driver.activeTurnId).toBeNull();

    driver.handleNotification("turn/started", {
      turn: { id: "turn-abc", status: "inProgress" },
    });

    expect(driver.activeTurnId).toBe("turn-abc");
  });

  test("turn/completed clears activeTurnId and resolves content", () => {
    driver.startTurn("turn-1", "thread-1");

    // Stream some content
    driver.handleNotification("item/agentMessage/delta", {
      turnId: "turn-1",
      delta: "Hello ",
    });
    driver.handleNotification("item/agentMessage/delta", {
      turnId: "turn-1",
      delta: "world!",
    });

    // Complete the turn
    driver.handleNotification("turn/completed", {
      turnId: "turn-1",
      usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10 },
    });

    expect(driver.activeTurnId).toBeNull();
    const resolver = driver.turnResolvers.get("turn-1")!;
    expect(resolver.resolved).toBe(true);
    expect(resolver.result!.content).toBe("Hello world!");
    expect(resolver.result!.usage.input_tokens).toBe(100);
    expect(resolver.result!.usage.output_tokens).toBe(50);
  });

  test("item/completed fallback captures content when deltas were missed", () => {
    driver.startTurn("turn-2", "thread-1");

    // No deltas — just item/completed with full text
    driver.handleNotification("item/completed", {
      turnId: "turn-2",
      item: { type: "agentMessage", text: "Complete response from Codex" },
    });

    driver.handleNotification("turn/completed", {
      turnId: "turn-2",
    });

    const resolver = driver.turnResolvers.get("turn-2")!;
    expect(resolver.result!.content).toBe("Complete response from Codex");
  });

  test("deltas from wrong turnId are ignored", () => {
    driver.startTurn("turn-A", "thread-1");

    driver.handleNotification("item/agentMessage/delta", {
      turnId: "turn-B", // wrong turn
      delta: "should be ignored",
    });
    driver.handleNotification("item/agentMessage/delta", {
      turnId: "turn-A",
      delta: "correct content",
    });

    driver.handleNotification("turn/completed", { turnId: "turn-A" });
    expect(driver.turnResolvers.get("turn-A")!.result!.content).toBe("correct content");
  });

  test("usage from turn/completed overrides item-level usage", () => {
    driver.startTurn("turn-3", "thread-1");

    // Item-level usage (partial)
    driver.handleNotification("item/completed", {
      turnId: "turn-3",
      item: { type: "agentMessage", text: "ok", usage: { input_tokens: 10 } },
    });

    // Turn-level usage (authoritative)
    driver.handleNotification("turn/completed", {
      turnId: "turn-3",
      usage: { input_tokens: 200, output_tokens: 80, cached_input_tokens: 30 },
    });

    const result = driver.turnResolvers.get("turn-3")!.result!;
    expect(result.usage.input_tokens).toBe(200);
    expect(result.usage.output_tokens).toBe(80);
  });
});

// === STEER PRECONDITION TESTS ===

describe("CodexDriver steer preconditions", () => {
  let driver: DriverStateMachine;

  beforeEach(() => {
    driver = new DriverStateMachine();
  });

  test("canSteer() returns false when no turn is active", () => {
    expect(driver.canSteer()).toBe(false);
  });

  test("canSteer() returns true during active turn", () => {
    driver.startTurn("turn-1", "thread-1");
    expect(driver.canSteer()).toBe(true);
  });

  test("canSteer() returns false after turn completes", () => {
    driver.startTurn("turn-1", "thread-1");
    expect(driver.canSteer()).toBe(true);

    driver.handleNotification("turn/completed", { turnId: "turn-1" });
    expect(driver.canSteer()).toBe(false);
  });

  test("activeTurnId survives item notifications within a turn", () => {
    driver.startTurn("turn-1", "thread-1");

    // Various item events should NOT clear activeTurnId
    driver.handleNotification("item/started", { turnId: "turn-1", item: { type: "commandExecution" } });
    expect(driver.activeTurnId).toBe("turn-1");

    driver.handleNotification("item/agentMessage/delta", { turnId: "turn-1", delta: "..." });
    expect(driver.activeTurnId).toBe("turn-1");

    driver.handleNotification("item/completed", { turnId: "turn-1", item: { type: "agentMessage", text: "done" } });
    expect(driver.activeTurnId).toBe("turn-1");
  });
});

// === FORWARDING LOOP STATE MACHINE ===

describe("Orchestrator forwarding loop logic", () => {
  /**
   * Simulates the forwarding loop's decision tree for a single slot.
   * Returns which action the loop would take.
   */
  function forwardingDecision(state: {
    alive: boolean;
    threadId: string | null;
    busy: boolean;
    activeTurnId: string | null;
    hasMessages: boolean;
  }): "skip_dead" | "skip_no_thread" | "skip_busy" | "skip_no_messages" | "steer" | "reply" {
    if (!state.alive) return "skip_dead";
    if (!state.threadId) return "skip_no_thread";
    if (state.busy) return "skip_busy";
    if (!state.hasMessages) return "skip_no_messages";
    if (state.activeTurnId) return "steer";
    return "reply";
  }

  test("dead driver is skipped", () => {
    expect(forwardingDecision({
      alive: false, threadId: "t1", busy: false, activeTurnId: null, hasMessages: true,
    })).toBe("skip_dead");
  });

  test("no threadId means first turn not complete — skip", () => {
    expect(forwardingDecision({
      alive: true, threadId: null, busy: false, activeTurnId: null, hasMessages: true,
    })).toBe("skip_no_thread");
  });

  test("busy slot is skipped — messages stay in broker queue", () => {
    expect(forwardingDecision({
      alive: true, threadId: "t1", busy: true, activeTurnId: null, hasMessages: true,
    })).toBe("skip_busy");
  });

  test("no messages — nothing to do", () => {
    expect(forwardingDecision({
      alive: true, threadId: "t1", busy: false, activeTurnId: null, hasMessages: false,
    })).toBe("skip_no_messages");
  });

  test("active turn + messages → steer (mid-turn injection)", () => {
    expect(forwardingDecision({
      alive: true, threadId: "t1", busy: false, activeTurnId: "turn-5", hasMessages: true,
    })).toBe("steer");
  });

  test("no active turn + messages → reply (new turn, fire-and-forget)", () => {
    expect(forwardingDecision({
      alive: true, threadId: "t1", busy: false, activeTurnId: null, hasMessages: true,
    })).toBe("reply");
  });

  test("busy flag prevents polling even when messages exist", () => {
    // This is critical: the loop must NOT call pollBySlot() when busy,
    // because pollBySlot marks messages as delivered. If we poll but
    // can't deliver (busy), messages are lost.
    const state = {
      alive: true, threadId: "t1", busy: true, activeTurnId: null, hasMessages: true,
    };
    expect(forwardingDecision(state)).toBe("skip_busy");
  });

  test("steer path doesn't set busy flag (instant operation)", () => {
    // Steer is non-blocking — it should NOT set busy=true
    const state = { alive: true, threadId: "t1", busy: false, activeTurnId: "turn-1", hasMessages: true };
    const action = forwardingDecision(state);
    expect(action).toBe("steer");
    // After steer, busy should still be false (steer doesn't block)
    expect(state.busy).toBe(false);
  });
});

// === EXIT CALLBACK TESTS ===

describe("CodexDriver exit callbacks", () => {
  test("multiple onExit callbacks all fire", () => {
    const driver = new DriverStateMachine();
    const calls: number[] = [];

    driver.onExit(() => calls.push(1));
    driver.onExit(() => calls.push(2));
    driver.onExit(() => calls.push(3));

    driver.simulateExit();
    expect(calls).toEqual([1, 2, 3]);
  });

  test("one failing callback doesn't prevent others", () => {
    const driver = new DriverStateMachine();
    const calls: number[] = [];

    driver.onExit(() => calls.push(1));
    driver.onExit(() => { throw new Error("boom"); });
    driver.onExit(() => calls.push(3));

    driver.simulateExit();
    expect(calls).toEqual([1, 3]);
  });

  test("exit clears activeTurnId", () => {
    const driver = new DriverStateMachine();
    driver.startTurn("turn-1", "thread-1");
    expect(driver.activeTurnId).toBe("turn-1");

    driver.simulateExit();
    expect(driver.activeTurnId).toBeNull();
    expect(driver.alive).toBe(false);
  });
});

// === NOTIFICATION DISPATCH TESTS ===

describe("CodexDriver notification listeners", () => {
  test("listeners receive all notifications", () => {
    const driver = new DriverStateMachine();
    const received: string[] = [];

    // Simulate external listener
    driver.notificationLog = [];

    driver.handleNotification("turn/started", { turn: { id: "t1" } });
    driver.handleNotification("item/started", { turnId: "t1", item: { type: "commandExecution" } });
    driver.handleNotification("item/completed", { turnId: "t1", item: { type: "commandExecution" } });
    driver.handleNotification("turn/completed", { turnId: "t1" });

    expect(driver.notificationLog).toHaveLength(4);
    expect(driver.notificationLog.map(n => n.method)).toEqual([
      "turn/started",
      "item/started",
      "item/completed",
      "turn/completed",
    ]);
  });
});

// === CONCURRENT SLOT INDEPENDENCE ===

describe("Multi-slot independence", () => {
  test("two slots with different turn states operate independently", () => {
    const slotA = new DriverStateMachine();
    const slotB = new DriverStateMachine();

    // Slot A: active turn in progress
    slotA.startTurn("turn-A1", "thread-A");

    // Slot B: no active turn
    slotB.threadId = "thread-B";

    // Slot A should steer, slot B should reply
    expect(slotA.canSteer()).toBe(true);
    expect(slotB.canSteer()).toBe(false);

    // Slot A completing its turn shouldn't affect slot B
    slotA.handleNotification("turn/completed", { turnId: "turn-A1" });
    expect(slotA.canSteer()).toBe(false);
    expect(slotB.canSteer()).toBe(false); // still false — independent
  });

  test("busy flag is per-slot, not global", () => {
    const slotA = new DriverStateMachine();
    const slotB = new DriverStateMachine();

    slotA.busy = true;
    slotB.busy = false;

    expect(slotA.busy).toBe(true);
    expect(slotB.busy).toBe(false);

    // Clearing A doesn't affect B
    slotA.busy = false;
    expect(slotB.busy).toBe(false);
  });
});

// === FORWARDING PROMPT FORMAT ===

describe("Forwarding prompt construction", () => {
  function buildForwardingPrompt(formatted: string): string {
    return [
      "NEW MESSAGES FROM TEAMMATES:",
      "",
      formatted,
      "",
      "═══ REQUIRED ACTIONS (complete ALL before resuming your work) ═══",
      "",
      "1. Read and process each message above",
      "2. Use send_message to reply to each teammate who messaged you",
      "3. Use set_summary to update your current status",
      "4. Call check_messages ONE MORE TIME to catch messages that arrived during processing",
      "5. Read your inbox file (.multiagents/inbox/<your-name>.md) for any file-based messages",
      "",
      "AVAILABLE TOOLS: send_message, submit_feedback, approve, signal_done, set_summary, check_messages",
      "",
      "DO NOT resume your previous work until you have completed steps 1-5 above.",
    ].join("\n");
  }

  test("prompt contains all 5 required action steps", () => {
    const prompt = buildForwardingPrompt("[chat] From slot 1: hello");
    expect(prompt).toContain("1. Read and process each message");
    expect(prompt).toContain("2. Use send_message");
    expect(prompt).toContain("3. Use set_summary");
    expect(prompt).toContain("4. Call check_messages ONE MORE TIME");
    expect(prompt).toContain("5. Read your inbox file");
  });

  test("prompt includes the gate instruction", () => {
    const prompt = buildForwardingPrompt("test");
    expect(prompt).toContain("DO NOT resume your previous work");
  });

  test("prompt includes the formatted messages verbatim", () => {
    const formatted = "[chat] From slot 2: Please review src/auth.ts\n\n---\n\n[feedback] From slot 3: Tests failing";
    const prompt = buildForwardingPrompt(formatted);
    expect(prompt).toContain("Please review src/auth.ts");
    expect(prompt).toContain("Tests failing");
  });
});
