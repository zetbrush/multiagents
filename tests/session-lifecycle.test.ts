#!/usr/bin/env bun
/**
 * Session lifecycle tests — validates task state transitions, auto-approve
 * behavior, and session completion detection.
 *
 * These test the broker-level logic that handles:
 * - Reviewer/QA agents auto-approving on signal_done
 * - Orphaned done_pending_review agents (no remaining reviewers)
 * - peek-undelivered endpoint
 * - Session completion when all agents reach terminal state
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";

const BROKER_PORT = 17899; // Use a non-default port to avoid conflicts
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
let brokerProc: import("bun").Subprocess | null = null;
let testCounter = 0;

function uid(prefix = "test"): string {
  return `${prefix}-${Date.now()}-${++testCounter}`;
}

async function post(path: string, body: any): Promise<any> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

beforeAll(async () => {
  // Start a fresh broker on a test-specific port with temp db
  const brokerPath = new URL("../broker.ts", import.meta.url).pathname;
  const tmpDb = `/tmp/multiagents-test-${Date.now()}.db`;
  brokerProc = Bun.spawn(["bun", brokerPath], {
    env: { ...process.env, MULTIAGENTS_PORT: String(BROKER_PORT), MULTIAGENTS_DB: tmpDb },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for broker to be ready
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BROKER_URL}/healthz`);
      if (res.ok) break;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 200));
  }
});

afterAll(() => {
  brokerProc?.kill();
});

// --- Helper: create a 3-agent session (Designer, Engineer, Reviewer) ---
async function createTestSession() {
  const sessionId = uid("session");
  const session = await post("/sessions/create", {
    id: sessionId,
    name: "test-lifecycle",
    project_dir: "/tmp/test-lifecycle",
  });

  const designer = await post("/slots/create", {
    session_id: session.id,
    display_name: "Designer",
    agent_type: "gemini",
    role: "UI/UX Designer",
  });

  const engineer = await post("/slots/create", {
    session_id: session.id,
    display_name: "Engineer",
    agent_type: "claude",
    role: "Software Engineer",
  });

  const reviewer = await post("/slots/create", {
    session_id: session.id,
    display_name: "Reviewer",
    agent_type: "codex",
    role: "Code Reviewer",
  });

  // Register fake peers for each slot
  const designerPeer = await post("/register", {
    agent_type: "gemini",
    pid: 10001 + testCounter,
    cwd: "/tmp/test-lifecycle",
    summary: "Designer starting",
    session_id: session.id,
    slot_id: designer.id,
  });
  const engineerPeer = await post("/register", {
    agent_type: "claude",
    pid: 20001 + testCounter,
    cwd: "/tmp/test-lifecycle",
    summary: "Engineer starting",
    session_id: session.id,
    slot_id: engineer.id,
  });
  const reviewerPeer = await post("/register", {
    agent_type: "codex",
    pid: 30001 + testCounter,
    cwd: "/tmp/test-lifecycle",
    summary: "Reviewer starting",
    session_id: session.id,
    slot_id: reviewer.id,
  });

  return {
    session,
    designer: { slot: designer, peer: designerPeer },
    engineer: { slot: engineer, peer: engineerPeer },
    reviewer: { slot: reviewer, peer: reviewerPeer },
  };
}

describe("Reviewer auto-approve on signal_done", () => {
  test("reviewer role auto-transitions to approved", async () => {
    const { session, reviewer } = await createTestSession();

    // Reviewer signals done
    const result = await post("/lifecycle/signal-done", {
      peer_id: reviewer.peer.id,
      session_id: session.id,
      summary: "Reviewed all code, approved engineer.",
    });

    expect(result.ok).toBe(true);
    expect(result.task_state).toBe("approved"); // Auto-approved, NOT done_pending_review
  });

  test("non-reviewer role goes to done_pending_review", async () => {
    const { session, engineer } = await createTestSession();

    const result = await post("/lifecycle/signal-done", {
      peer_id: engineer.peer.id,
      session_id: session.id,
      summary: "Implemented the feature.",
    });

    expect(result.ok).toBe(true);
    expect(result.task_state).toBe("done_pending_review");
  });

  test("QA role also auto-approves", async () => {
    const session = await post("/sessions/create", {
      id: uid("qa-session"),
      name: "test-qa-approve",
      project_dir: "/tmp/test-qa",
    });
    const qa = await post("/slots/create", {
      session_id: session.id,
      display_name: "QA",
      agent_type: "claude",
      role: "QA Engineer",
    });
    const peer = await post("/register", {
      agent_type: "claude",
      pid: 40001 + testCounter,
      cwd: "/tmp/test-qa",
      summary: "QA starting",
      session_id: session.id,
      slot_id: qa.id,
    });

    const result = await post("/lifecycle/signal-done", {
      peer_id: peer.id,
      session_id: session.id,
      summary: "All tests pass.",
    });

    expect(result.ok).toBe(true);
    expect(result.task_state).toBe("approved");
  });
});

describe("Approval workflow", () => {
  test("reviewer approve transitions engineer to approved", async () => {
    const { session, engineer, reviewer } = await createTestSession();

    // Engineer signals done
    await post("/lifecycle/signal-done", {
      peer_id: engineer.peer.id,
      session_id: session.id,
      summary: "Feature implemented.",
    });

    // Reviewer approves engineer
    const result = await post("/lifecycle/approve", {
      peer_id: reviewer.peer.id,
      session_id: session.id,
      target_slot_id: engineer.slot.id,
    });

    expect(result.ok).toBe(true);
    expect(result.task_state).toBe("approved");
  });
});

describe("peek-undelivered", () => {
  test("returns count and msg_types without consuming", async () => {
    const { session, engineer, designer } = await createTestSession();

    // Send messages to engineer
    await post("/send-message", {
      from_id: designer.peer.id,
      to_id: engineer.peer.id,
      text: "Here are the design specs",
      msg_type: "chat",
      session_id: session.id,
    });
    await post("/send-message", {
      from_id: designer.peer.id,
      to_id: engineer.peer.id,
      text: "Design work complete",
      msg_type: "review_request",
      session_id: session.id,
    });

    // Peek (non-consuming)
    const peek1 = await post("/peek-undelivered", { slot_id: engineer.slot.id });
    expect(peek1.count).toBe(2);
    expect(peek1.msg_types).toContain("chat");
    expect(peek1.msg_types).toContain("review_request");
    // oldest_at should be a recent timestamp (within last 5s)
    expect(peek1.oldest_at).toBeGreaterThan(Date.now() - 5000);
    expect(peek1.oldest_at).toBeLessThanOrEqual(Date.now());

    // Peek again — should still show same count (non-consuming)
    const peek2 = await post("/peek-undelivered", { slot_id: engineer.slot.id });
    expect(peek2.count).toBe(2);

    // Now poll (consuming) — should return and mark delivered
    const poll = await post("/poll-by-slot", { slot_id: engineer.slot.id });
    expect(poll.messages.length).toBe(2);

    // Peek should now show 0 and oldest_at = 0
    const peek3 = await post("/peek-undelivered", { slot_id: engineer.slot.id });
    expect(peek3.count).toBe(0);
    expect(peek3.oldest_at).toBe(0);
  });
});

describe("Signal done notifications", () => {
  test("signal_done sends review_request to reviewer slots", async () => {
    const { session, engineer, reviewer } = await createTestSession();

    await post("/lifecycle/signal-done", {
      peer_id: engineer.peer.id,
      session_id: session.id,
      summary: "Feature done.",
    });

    // Reviewer should have a pending review_request
    const peek = await post("/peek-undelivered", { slot_id: reviewer.slot.id });
    expect(peek.count).toBeGreaterThanOrEqual(1);
    expect(peek.msg_types).toContain("review_request");
  });

  test("signal_done sends task_complete to non-reviewer slots", async () => {
    const { session, engineer, designer } = await createTestSession();

    await post("/lifecycle/signal-done", {
      peer_id: engineer.peer.id,
      session_id: session.id,
      summary: "Feature done.",
    });

    // Designer (non-reviewer) should get task_complete
    const peek = await post("/peek-undelivered", { slot_id: designer.slot.id });
    expect(peek.count).toBeGreaterThanOrEqual(1);
    expect(peek.msg_types).toContain("task_complete");
  });
});

describe("Full session lifecycle", () => {
  test("complete 3-agent workflow: signal_done → approve → all approved", async () => {
    const { session, designer, engineer, reviewer } = await createTestSession();

    // 1. Designer provides specs and signals done (goes to done_pending_review)
    const designerDone = await post("/lifecycle/signal-done", {
      peer_id: designer.peer.id,
      session_id: session.id,
      summary: "Design specs provided.",
    });
    expect(designerDone.task_state).toBe("done_pending_review");

    // 2. Engineer implements and signals done (goes to done_pending_review)
    const engineerDone = await post("/lifecycle/signal-done", {
      peer_id: engineer.peer.id,
      session_id: session.id,
      summary: "Implementation complete.",
    });
    expect(engineerDone.task_state).toBe("done_pending_review");

    // 3. Reviewer approves engineer
    const approveEng = await post("/lifecycle/approve", {
      peer_id: reviewer.peer.id,
      session_id: session.id,
      target_slot_id: engineer.slot.id,
    });
    expect(approveEng.task_state).toBe("approved");

    // 4. Reviewer approves designer
    const approveDes = await post("/lifecycle/approve", {
      peer_id: reviewer.peer.id,
      session_id: session.id,
      target_slot_id: designer.slot.id,
    });
    expect(approveDes.task_state).toBe("approved");

    // 5. Reviewer signals done → auto-approved (reviewer role)
    const reviewerDone = await post("/lifecycle/signal-done", {
      peer_id: reviewer.peer.id,
      session_id: session.id,
      summary: "All code reviewed and approved.",
    });
    expect(reviewerDone.task_state).toBe("approved");

    // Verify all slots are approved
    const slots = await post("/slots/list", { session_id: session.id });
    for (const slot of slots) {
      expect(slot.task_state).toBe("approved");
    }
  });

  test("designer stuck at done_pending_review when reviewer forgets to approve", async () => {
    const { session, designer, engineer, reviewer } = await createTestSession();

    // Designer signals done
    await post("/lifecycle/signal-done", {
      peer_id: designer.peer.id,
      session_id: session.id,
      summary: "Design specs provided.",
    });

    // Engineer signals done
    await post("/lifecycle/signal-done", {
      peer_id: engineer.peer.id,
      session_id: session.id,
      summary: "Implementation complete.",
    });

    // Reviewer approves ONLY engineer (forgets designer)
    await post("/lifecycle/approve", {
      peer_id: reviewer.peer.id,
      session_id: session.id,
      target_slot_id: engineer.slot.id,
    });

    // Reviewer signals done → auto-approved
    await post("/lifecycle/signal-done", {
      peer_id: reviewer.peer.id,
      session_id: session.id,
      summary: "Reviewed and approved engineer.",
    });

    // Check states: designer should still be stuck at done_pending_review
    const slots = await post("/slots/list", { session_id: session.id });
    const designerSlot = slots.find((s: any) => s.display_name === "Designer");
    const engineerSlot = slots.find((s: any) => s.display_name === "Engineer");
    const reviewerSlot = slots.find((s: any) => s.display_name === "Reviewer");

    expect(designerSlot.task_state).toBe("done_pending_review"); // Stuck!
    expect(engineerSlot.task_state).toBe("approved");
    expect(reviewerSlot.task_state).toBe("approved");

    // This is the exact scenario from the circle-shape-html session.
    // The orchestrator's auto-approve loop should detect this and auto-approve
    // the designer when it sees all reviewers are done.
  });
});
