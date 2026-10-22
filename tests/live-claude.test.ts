#!/usr/bin/env bun
/**
 * Live end-to-end check against the real `claude` binary (costs API usage).
 * Runs only with MULTIAGENTS_LIVE_TESTS=1; set MULTIAGENTS_CLAUDE_MODEL=haiku
 * to keep it cheap.
 *
 * Proves the delivery path this harness depends on: an orchestrator-launched
 * Claude agent registers with the broker, a teammate message injected through
 * the driver reaches the model mid-session, the model answers through
 * send_message, and the driver shuts the session down cleanly.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BrokerClient } from "../shared/broker-client.ts";
import { launchAgent } from "../orchestrator/launcher.ts";
import { deliverPendingMessages, type DriverSlot } from "../orchestrator/delivery.ts";

const LIVE = process.env.MULTIAGENTS_LIVE_TESTS === "1";
const BROKER_PORT = 17905;
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
let brokerProc: import("bun").Subprocess | null = null;
const dummies: import("bun").Subprocess[] = [];

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BROKER_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await Bun.sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  if (!LIVE) return;
  const brokerPath = new URL("../broker.ts", import.meta.url).pathname;
  brokerProc = Bun.spawn(["bun", brokerPath], {
    env: { ...process.env, MULTIAGENTS_PORT: String(BROKER_PORT), MULTIAGENTS_DB: `/tmp/multiagents-live-${Date.now()}.db` },
    stdout: "pipe", stderr: "pipe",
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BROKER_URL}/health`)).ok) break; } catch { /* not ready */ }
    await Bun.sleep(100);
  }
});

afterAll(() => {
  for (const d of dummies) d.kill();
  brokerProc?.kill();
});

describe.skipIf(!LIVE)("live: Claude driver end-to-end", () => {
  test("a launched Claude agent receives an injected teammate message mid-session and answers through the broker", async () => {
    process.env.MULTIAGENTS_PORT = String(BROKER_PORT);
    const brokerClient = new BrokerClient(BROKER_URL);
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-claude-"));
    const sessionId = `live-${Date.now()}`;
    await brokerClient.createSession({ id: sessionId, name: "live", project_dir: projectDir });

    const reviewerSlot = await post("/slots/create", { session_id: sessionId, agent_type: "codex", display_name: "Reviewer", role: "Code Reviewer" });
    const sleeper = Bun.spawn(["sleep", "600"], { stdout: "ignore", stderr: "ignore" });
    dummies.push(sleeper);
    const reviewer = await post("/register", { agent_type: "codex", pid: sleeper.pid, cwd: projectDir, git_root: null, tty: null, summary: "reviewing", session_id: sessionId, slot_id: reviewerSlot.id });

    const launched = await launchAgent(sessionId, projectDir, {
      agent_type: "claude",
      name: "Engineer",
      role: "Software Engineer",
      role_description: "Answers teammates' questions precisely.",
      initial_task: "Call set_summary with exactly 'ready'. Then wait for teammate messages: they will arrive as user messages starting with [Teammate messages]. Answer every question you receive by calling send_message to the sender's peer id with the answer only. Do not write files.",
    }, brokerClient);
    const driver = launched.claudeDriver!;
    expect(driver).toBeDefined();
    const observed: string[] = [];
    driver.onEvent((e) => {
      if (e.type === "user" || e.type === "result" || e.type === "system") observed.push(JSON.stringify(e).slice(0, 300));
    });

    try {
      const agentPeerId = await waitFor(async () => (await post("/slots/get", { id: launched.slotId })).peer_id as string | null, 120_000, "agent registration");
      await waitFor(async () => {
        const peers = await post("/list-peers", { scope: "machine", cwd: projectDir, git_root: null, session_id: sessionId });
        return peers.find((p: any) => p.id === agentPeerId && p.summary === "ready");
      }, 120_000, "set_summary('ready')");

      await post("/send-message", { from_id: reviewer.id, to_id: agentPeerId, text: "Question from Reviewer: what is 7 times 6? Reply with the number only via send_message.", session_id: sessionId });
      const state: DriverSlot = { kind: "claude", driver, busy: false, lastNudge: 0 };
      const outcome = await waitFor(async () => {
        const o = await deliverPendingMessages(sessionId, launched.slotId, state, brokerClient);
        return o === "sent" ? o : null;
      }, 30_000, "driver delivery");
      expect(outcome).toBe("sent");

      const reply = await waitFor(async () => {
        const log = await post("/message-log", { session_id: sessionId, limit: 50 });
        return log.find((m: any) => m.from_id === agentPeerId && m.to_id === reviewer.id && /42/.test(m.text));
      }, 180_000, "the agent's reply through send_message");
      expect(reply.text).toMatch(/42/);

      const unacked = await post("/peek-undelivered", { slot_id: launched.slotId });
      expect(unacked.count).toBe(0);
    } finally {
      console.log(`[live] session=${driver.sessionId} turns=${(driver as { turnsCompleted?: number }).turnsCompleted}\n[live] observed events:\n${observed.join("\n")}`);
      const code = await driver.close(30_000);
      expect(code).toBe(0);
    }
  }, 420_000);
});
