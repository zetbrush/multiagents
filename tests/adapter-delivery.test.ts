#!/usr/bin/env bun
/**
 * Adapter delivery — drives real adapter processes (server.ts) over MCP stdio
 * against a test broker and checks that teammate messages reach the model
 * through tool results, are acked exactly once, and that instructions fit the
 * host CLIs' limits.
 */

import { test, expect, beforeAll, afterAll, afterEach, describe } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpStdioClient } from "./helpers/mcp-stdio-client.ts";
import { ClaudeAdapter } from "../adapters/claude-adapter.ts";
import { CodexAdapter } from "../adapters/codex-adapter.ts";
import { GeminiAdapter } from "../adapters/gemini-adapter.ts";
import { AntigravityAdapter } from "../adapters/antigravity-adapter.ts";

const BROKER_PORT = 17902;
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const SERVER_TS = new URL("../server.ts", import.meta.url).pathname;
let brokerProc: import("bun").Subprocess | null = null;
let counter = 0;
const dummies: import("bun").Subprocess[] = [];
const clients: McpStdioClient[] = [];

const uid = (prefix = "t") => `${prefix}-${Date.now()}-${++counter}`;

function livePid(): number {
  const proc = Bun.spawn(["sleep", "600"], { stdout: "ignore", stderr: "ignore" });
  dummies.push(proc);
  return proc.pid;
}

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

beforeAll(async () => {
  const brokerPath = new URL("../broker.ts", import.meta.url).pathname;
  brokerProc = Bun.spawn(["bun", brokerPath], {
    env: { ...process.env, MULTIAGENTS_PORT: String(BROKER_PORT), MULTIAGENTS_DB: `/tmp/multiagents-adapter-${Date.now()}.db` },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BROKER_URL}/health`)).ok) break; } catch { /* not ready */ }
    await Bun.sleep(100);
  }
});

afterEach(() => {
  for (const c of clients.splice(0)) c.kill();
});

afterAll(() => {
  for (const d of dummies) d.kill();
  brokerProc?.kill();
});

/** Session with one adapter-backed slot and a sender peer (fake, live pid). */
async function spawnAgent(agentType: "claude" | "codex" | "gemini" | "antigravity", extraEnv: Record<string, string> = {}) {
  const sessionId = uid("s");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-delivery-"));
  await post("/sessions/create", { id: sessionId, name: "adapter", project_dir: projectDir });
  const slot = await post("/slots/create", { session_id: sessionId, agent_type: agentType, display_name: "Agent", role: "Software Engineer" });
  const senderSlot = await post("/slots/create", { session_id: sessionId, agent_type: "codex", display_name: "Reviewer", role: "Code Reviewer" });
  const sender = await post("/register", { agent_type: "codex", pid: livePid(), cwd: projectDir, git_root: null, tty: null, summary: "reviewing", session_id: sessionId, slot_id: senderSlot.id });

  const client = await McpStdioClient.spawn(["bun", SERVER_TS, "--agent-type", agentType], {
    cwd: projectDir,
    env: {
      ...process.env,
      MULTIAGENTS_PORT: String(BROKER_PORT),
      MULTIAGENTS_SESSION: sessionId,
      MULTIAGENTS_SLOT: String(slot.id),
      ...extraEnv,
    },
  });
  clients.push(client);

  let peerId: string | null = null;
  for (let i = 0; i < 50 && !peerId; i++) {
    const s = await post("/slots/get", { id: slot.id });
    peerId = s.peer_id;
    if (!peerId) await Bun.sleep(100);
  }
  if (!peerId) throw new Error("adapter never registered with the broker");

  const send = (text: string, msg_type = "chat") =>
    post("/send-message", { from_id: sender.id, to_id: peerId, text, msg_type, session_id: sessionId });
  const unacked = async () => (await post("/peek-undelivered", { slot_id: slot.id })).count as number;
  /** Call a tool until its result carries `text`; the poll loop stages messages between calls (every 0.3–1 s). */
  const resultCarrying = async (text: string) => {
    const deadline = Date.now() + 10_000;
    while (true) {
      const result = await client.callTool("set_summary", { summary: "working" });
      if (result.text.includes(text)) return result;
      if (Date.now() > deadline) throw new Error(`no tool result carried ${JSON.stringify(text)}`);
      await Bun.sleep(150);
    }
  };
  const pushed = async (count: number) => {
    const deadline = Date.now() + 10_000;
    while (client.notifications.filter((n) => n.method === "notifications/claude/channel").length < count) {
      if (Date.now() > deadline) throw new Error(`expected ${count} channel notification(s)`);
      await Bun.sleep(100);
    }
  };

  return { client, sessionId, slot, peerId, send, unacked, resultCarrying, pushed };
}

describe("tool-result delivery", () => {
  for (const agentType of ["claude", "codex", "gemini", "antigravity"] as const) {
    test(`${agentType}: a teammate message is piggybacked onto the next tool result and acked`, async () => {
      const agent = await spawnAgent(agentType);
      await agent.send("please review auth.ts");

      const result = await agent.resultCarrying("please review auth.ts");
      expect(result.text).toMatch(/Reviewer \(Code Reviewer\) \[id cx-[a-z0-9]+\]: please review auth\.ts/);
      expect(await agent.unacked()).toBe(0);

      const next = await agent.client.callTool("set_summary", { summary: "still working" });
      expect(next.text).not.toContain("please review auth.ts");
    }, 30_000);
  }

  test("claude: check_messages returns an unread message once and acks it", async () => {
    const agent = await spawnAgent("claude");
    await agent.send("are you done?");

    const first = await agent.client.callTool("check_messages");
    expect(first.text).toContain("are you done?");
    expect(await agent.unacked()).toBe(0);

    const second = await agent.client.callTool("check_messages");
    expect(second.text).toBe("No new messages.");
  }, 30_000);

  test("claude: the channel notification is still pushed as best-effort", async () => {
    const agent = await spawnAgent("claude");
    await agent.send("channel me");
    await agent.pushed(1);

    const pushed = agent.client.notifications.filter((n) => n.method === "notifications/claude/channel");
    expect(pushed).toHaveLength(1);
    expect((pushed[0]!.params as any).content).toBe("channel me");
    expect(await agent.unacked()).toBe(1);
  }, 30_000);

  test("driver mode: no background polling, check_messages returns only unclaimed messages and acks them", async () => {
    const agent = await spawnAgent("claude", { MULTIAGENTS_DRIVER_MODE: "1" });
    await agent.send("handled by the driver");
    await Bun.sleep(1500);
    expect(agent.client.notifications.filter((n) => n.method === "notifications/claude/channel")).toHaveLength(0);

    const quiet = await agent.client.callTool("set_summary", { summary: "working" });
    expect(quiet.text).not.toContain("handled by the driver");

    // The driver claims the message (poll-by-slot, retained until acked) before injecting it; the adapter must not double-deliver it.
    await post("/poll-by-slot", { slot_id: agent.slot.id, retain: true });
    await agent.send("fresh one");
    const check = await agent.client.callTool("check_messages");
    expect(check.text).toContain("fresh one");
    expect(check.text).not.toContain("handled by the driver");
    expect(await agent.unacked()).toBe(1);
  }, 30_000);
});

describe("antigravity under an orchestrator driver", () => {
  test("unclaimed messages ride on any tool result, the ones the driver claimed do not", async () => {
    const agent = await spawnAgent("antigravity", { MULTIAGENTS_DRIVER_MODE: "1" });
    await agent.send("claimed by the driver");
    await Bun.sleep(1000);
    expect((await post("/message-log", { session_id: agent.sessionId }))[0].delivered).toBe(0);
    await post("/poll-by-slot", { slot_id: agent.slot.id, retain: true });

    await agent.send("arrived mid-turn");
    const result = await agent.client.callTool("set_summary", { summary: "working" });
    expect(result.text).toContain("[PENDING MESSAGES]");
    expect(result.text).toContain("arrived mid-turn");
    expect(result.text).not.toContain("claimed by the driver");
    expect(await agent.unacked()).toBe(1);

    const next = await agent.client.callTool("set_summary", { summary: "still working" });
    expect(next.text).not.toContain("arrived mid-turn");
  }, 30_000);

  test("a host that does not pass its environment on is matched to its slot through its slot file", async () => {
    const sessionId = uid("s");
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-slotfile-"));
    await post("/sessions/create", { id: sessionId, name: "adapter", project_dir: projectDir });
    const slot = await post("/slots/create", { session_id: sessionId, agent_type: "antigravity", display_name: "Designer", role: "UI/UX Designer" });
    const senderSlot = await post("/slots/create", { session_id: sessionId, agent_type: "codex", display_name: "Reviewer", role: "Code Reviewer" });
    const sender = await post("/register", { agent_type: "codex", pid: livePid(), cwd: projectDir, git_root: null, tty: null, summary: "", session_id: sessionId, slot_id: senderSlot.id });

    // The shell stands in for `agy`: the launcher keys the slot file by its pid and the MCP server is its direct child (as with agy 1.5.13).
    const slotJson = JSON.stringify({ slot_id: slot.id, session_id: sessionId, role: "UI/UX Designer", name: "Designer", driver_mode: true });
    const script = `mkdir -p .multiagents/slots && printf '%s' '${slotJson}' > .multiagents/slots/$$.json; bun '${SERVER_TS}' --agent-type antigravity; true`;
    const client = await McpStdioClient.spawn(["sh", "-c", script], {
      cwd: projectDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, MULTIAGENTS_PORT: String(BROKER_PORT) },
    });
    clients.push(client);

    let linked: { peer_id: string | null; status: string } = { peer_id: null, status: "" };
    for (let i = 0; i < 50 && !linked.peer_id; i++) {
      linked = await post("/slots/get", { id: slot.id });
      if (!linked.peer_id) await Bun.sleep(100);
    }
    expect(linked.peer_id).toMatch(/^ag-/);
    expect(linked.status).toBe("connected");
    expect((await post("/slots/list", { session_id: sessionId })).length).toBe(2);

    // driver mode came from the slot file: nothing is polled in the background, tool results carry what is unclaimed
    await post("/send-message", { from_id: sender.id, to_slot_id: slot.id, text: "use the new palette", msg_type: "chat", session_id: sessionId });
    await Bun.sleep(1000);
    expect((await post("/message-log", { session_id: sessionId }))[0].delivered).toBe(0);
    const result = await client.callTool("set_summary", { summary: "designing" });
    expect(result.text).toContain("use the new palette");
  }, 30_000);
});

describe("slot files", () => {
  test("a slot file written for an earlier process that had the same pid is ignored", async () => {
    const sessionId = uid("s");
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-stale-slot-"));
    await post("/sessions/create", { id: sessionId, name: "adapter", project_dir: projectDir });
    const slot = await post("/slots/create", { session_id: sessionId, agent_type: "antigravity", display_name: "Designer", role: "UI/UX Designer" });

    const slotJson = JSON.stringify({ slot_id: slot.id, session_id: sessionId, role: "UI/UX Designer", name: "Designer", driver_mode: true, host_started: "Thu Jan  1 00:00:00 1970" });
    const script = `mkdir -p .multiagents/slots && printf '%s' '${slotJson}' > .multiagents/slots/$$.json; bun '${SERVER_TS}' --agent-type antigravity; true`;
    const client = await McpStdioClient.spawn(["sh", "-c", script], {
      cwd: projectDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, MULTIAGENTS_PORT: String(BROKER_PORT) },
    });
    clients.push(client);

    // the adapter is up and registered, but not as that slot's agent
    expect((await client.callTool("set_summary", { summary: "standalone" })).text).toContain("Summary updated");
    const untouched = await post("/slots/get", { id: slot.id });
    expect(untouched.peer_id).toBeNull();
    expect(untouched.status).toBe("disconnected");
  }, 30_000);
});

describe("startup", () => {
  test("a tool call that arrives before the broker registration finished waits for it", async () => {
    const sessionId = uid("s");
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-startup-"));
    await post("/sessions/create", { id: sessionId, name: "adapter", project_dir: projectDir });
    const slot = await post("/slots/create", { session_id: sessionId, agent_type: "claude", display_name: "Agent", role: "Software Engineer" });
    const client = await McpStdioClient.spawn(["bun", SERVER_TS, "--agent-type", "claude"], {
      cwd: projectDir,
      env: { ...process.env, MULTIAGENTS_PORT: String(BROKER_PORT), MULTIAGENTS_SESSION: sessionId, MULTIAGENTS_SLOT: String(slot.id) },
    });
    clients.push(client);

    const result = await client.callTool("set_summary", { summary: "first call" });
    expect(result.text).toContain('Summary updated: "first call"');
  }, 30_000);
});

describe("team status", () => {
  test("check_team_status names each teammate's peer id so send_message can address them", async () => {
    const agent = await spawnAgent("claude");
    const status = await agent.client.callTool("check_team_status");
    expect(status.text).toMatch(/Reviewer \| codex \| Code Reviewer \| ONLINE \| task: idle \| id: cx-[a-z0-9]+/);
    expect(status.text).toMatch(/Agent \| claude \| Software Engineer \| ONLINE \| task: idle \| id: cl-[a-z0-9]+ \(you\)/);
  }, 30_000);
});

describe("instruction budget", () => {
  test("MCP instructions fit Claude Code's 4096-char cap for every adapter", () => {
    for (const adapter of [new ClaudeAdapter(), new CodexAdapter(), new GeminiAdapter(), new AntigravityAdapter()]) {
      const text = adapter.getInstructions();
      expect(text.length).toBeLessThanOrEqual(4096);
      expect(text).toContain("signal_done");
      expect(text).toContain("check_messages");
    }
  });

  test("the first 512 chars (all Codex reads) name the core tools", () => {
    const head = new CodexAdapter().getInstructions().slice(0, 512);
    for (const tool of ["check_messages", "send_message", "set_summary", "signal_done"]) {
      expect(head).toContain(tool);
    }
  });
});
