#!/usr/bin/env bun
/**
 * Live end-to-end check against the real Antigravity CLI (`agy`, signed in or
 * configured for a Gemini API key). Runs only with MULTIAGENTS_LIVE_TESTS=1;
 * set MULTIAGENTS_ANTIGRAVITY_MODEL to a cheap slug from `agy models`.
 *
 * Proves what the fake host can only assume: an orchestrator-launched agent's
 * MCP adapter joins the launcher's slot, a teammate message is delivered as a
 * new turn once the session is idle, the model answers through send_message,
 * and the session exits cleanly on stdin EOF; then the same through the
 * orchestrator server, with a crash respawn into the conversation and a
 * release; and, when `codex` is installed too, a mixed team in which an
 * Antigravity engineer and a Codex reviewer take a task to approval. The
 * launcher registers multiagents-peer in the temporary project; a global
 * ~/.gemini/config/mcp_config.json that already holds a multiagents entry is
 * repointed for the run and restored afterwards, as is the multiagents-peer
 * section the Codex launch rewrites in ~/.codex/config.toml.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BrokerClient } from "../shared/broker-client.ts";
import { McpStdioClient } from "./helpers/mcp-stdio-client.ts";
import { restoreCodexConfig } from "./helpers/codex-config.ts";
import { launchAgent, detectAgent, antigravityMcpConfigPath, antigravityMcpServer } from "../orchestrator/launcher.ts";
import { deliverPendingMessages, type DriverSlot } from "../orchestrator/delivery.ts";

const LIVE = process.env.MULTIAGENTS_LIVE_TESTS === "1" && (await detectAgent("antigravity")).available;
const LIVE_WITH_CODEX = LIVE && (await detectAgent("codex")).available;
const BROKER_PORT = 17912;
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const MCP_CONFIG = antigravityMcpConfigPath();
const ORCHESTRATOR = new URL("../orchestrator/orchestrator-server.ts", import.meta.url).pathname;
let brokerProc: import("bun").Subprocess | null = null;
const CODEX_CONFIG = path.join(os.homedir(), ".codex", "config.toml");
/** Temp-dir prefix of the mixed-team project; Codex writes a trust entry for that path into its config. */
const TEAM_PROJECT_PREFIX = "live-agy-codex-";
let mcpConfigBackup: string | null = null;
let codexConfigBackup: string | null = null;
const orchestrators: McpStdioClient[] = [];
const dummies: import("bun").Subprocess[] = [];

async function startOrchestrator(cwd: string): Promise<McpStdioClient> {
  const env: Record<string, string | undefined> = { ...process.env, MULTIAGENTS_PORT: String(BROKER_PORT), MULTIAGENTS_NO_DASHBOARD: "1" };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const client = await McpStdioClient.spawn(["bun", ORCHESTRATOR], { cwd, env, stderrLog: path.join(cwd, "orchestrator.log") });
  orchestrators.push(client);
  return client;
}

const children = (client: McpStdioClient, pattern: string) =>
  Bun.spawnSync(["pgrep", "-P", String(client.pid), "-f", pattern]).stdout.toString().split("\n").filter(Boolean).map(Number);

function orchestratorLog(dir: string, keep: RegExp): string {
  const file = path.join(dir, "orchestrator.log");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  return text.split("\n").filter((l) => keep.test(l)).slice(0, 80).join("\n");
}

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
  mcpConfigBackup = fs.existsSync(MCP_CONFIG) ? fs.readFileSync(MCP_CONFIG, "utf-8") : null;
  if (LIVE_WITH_CODEX && fs.existsSync(CODEX_CONFIG)) codexConfigBackup = fs.readFileSync(CODEX_CONFIG, "utf-8");
  const brokerPath = new URL("../broker.ts", import.meta.url).pathname;
  brokerProc = Bun.spawn(["bun", brokerPath], {
    env: { ...process.env, MULTIAGENTS_PORT: String(BROKER_PORT), MULTIAGENTS_DB: `/tmp/multiagents-live-agy-${Date.now()}.db` },
    stdout: "pipe", stderr: "pipe",
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BROKER_URL}/health`)).ok) break; } catch { /* not ready */ }
    await Bun.sleep(100);
  }
});

afterAll(async () => {
  for (const client of orchestrators) client.kill();
  if (orchestrators.length > 0) await Bun.sleep(1500);
  for (const d of dummies) d.kill();
  brokerProc?.kill();
  if (!LIVE) return;
  if (mcpConfigBackup === null) fs.rmSync(MCP_CONFIG, { force: true });
  else fs.writeFileSync(MCP_CONFIG, mcpConfigBackup);
  if (codexConfigBackup !== null) restoreCodexConfig(CODEX_CONFIG, codexConfigBackup, TEAM_PROJECT_PREFIX);
});

describe.skipIf(!LIVE)("live: Antigravity driver end-to-end", () => {
  test("a launched Antigravity agent joins its slot, gets a teammate message as a new turn and answers through the broker", async () => {
    process.env.MULTIAGENTS_PORT = String(BROKER_PORT);
    const brokerClient = new BrokerClient(BROKER_URL);
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-agy-"));
    const sessionId = `live-agy-${Date.now()}`;
    await brokerClient.createSession({ id: sessionId, name: "live", project_dir: projectDir });

    const reviewerSlot = await post("/slots/create", { session_id: sessionId, agent_type: "codex", display_name: "Reviewer", role: "Code Reviewer" });
    const sleeper = Bun.spawn(["sleep", "600"], { stdout: "ignore", stderr: "ignore" });
    dummies.push(sleeper);
    const reviewer = await post("/register", { agent_type: "codex", pid: sleeper.pid, cwd: projectDir, git_root: null, tty: null, summary: "reviewing", session_id: sessionId, slot_id: reviewerSlot.id });

    const launched = await launchAgent(sessionId, projectDir, {
      agent_type: "antigravity",
      name: "Designer",
      role: "UI/UX Designer",
      role_description: "Answers teammates' questions precisely.",
      initial_task: "Call set_summary with exactly 'ready', then end your turn. Teammate messages will arrive later as user messages starting with [Teammate messages]. Answer every question you receive by calling send_message to the sender's peer id with the answer only. Do not write files.",
    }, brokerClient);
    const driver = launched.antigravityDriver!;
    expect(driver).toBeDefined();
    expect(JSON.parse(fs.readFileSync(path.join(projectDir, ".agents", "mcp_config.json"), "utf-8")).mcpServers["multiagents-peer"]).toMatchObject(antigravityMcpServer());
    const globalHasEntry = /"multiagents(-peer)?"/.test(mcpConfigBackup ?? "");
    if (!globalHasEntry) expect(fs.existsSync(MCP_CONFIG) ? fs.readFileSync(MCP_CONFIG, "utf-8") : null).toBe(mcpConfigBackup);
    const observed: string[] = [];
    let lastUsage: { input_tokens?: number } | undefined;
    driver.onEvent((e) => {
      observed.push(JSON.stringify(e).slice(0, 300));
      if (e.event === "result") lastUsage = (e.result as { usage?: { input_tokens?: number } } | undefined)?.usage;
    });

    try {
      const agentPeerId = await waitFor(async () => (await post("/slots/get", { id: launched.slotId })).peer_id as string | null, 180_000, "agent registration into the launcher's slot");
      expect(agentPeerId).toMatch(/^ag-/);
      expect(await post("/slots/list", { session_id: sessionId })).toHaveLength(2);
      await waitFor(async () => {
        const peers = await post("/list-peers", { scope: "machine", cwd: projectDir, git_root: null, session_id: sessionId });
        return peers.find((p: any) => p.id === agentPeerId && p.summary === "ready");
      }, 180_000, "set_summary('ready')");
      await waitFor(async () => !driver.busy, 180_000, "the first turn to end");

      await post("/send-message", { from_id: reviewer.id, to_id: agentPeerId, text: "Question from Reviewer: what is 7 times 6? Reply with the number only via send_message.", session_id: sessionId });
      const state: DriverSlot = { kind: "antigravity", driver, busy: false, lastNudge: 0 };
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
      expect((await post("/peek-undelivered", { slot_id: launched.slotId })).count).toBe(0);
      expect(lastUsage?.input_tokens ?? 0).toBeGreaterThan(0);
    } finally {
      console.log(`[live] conversation=${driver.conversationId} permissions=${driver.permissionMode} turns=${driver.turnsCompleted}\n[live] observed events:\n${observed.slice(0, 60).join("\n")}`);
      const code = await driver.close(60_000);
      expect(code).toBe(0);
    }
  }, 600_000);
});

describe.skipIf(!LIVE)("live: orchestrator runs an Antigravity agent", () => {
  test("create_team → delivery through the loop → crash respawn into the conversation → release closes the session", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-agy-orch-"));
    const projectDir = path.join(tmpDir, "project");
    const orchestrator = await startOrchestrator(tmpDir);
    const agyPids = () => children(orchestrator, "agy --input-format");
    const commandOf = (pid: number) => Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]).stdout.toString().trim();

    const created = await orchestrator.callTool("create_team", {
      project_dir: projectDir,
      session_name: "live agy team",
      agents: [{
        agent_type: "antigravity", name: "Designer", role: "UI/UX Designer",
        role_description: "Follows instructions exactly and keeps turns short.",
        initial_task: "Call set_summary with exactly 'ready', then end your turn. Later instructions arrive as user messages starting with [Teammate messages]; do exactly what each one says and end your turn. Do not write files.",
      }],
    }, 240_000);
    expect(created.isError).toBe(false);
    const sessionId = created.text.match(/Session "([^"]+)" created/)?.[1];
    expect(sessionId).toBeTruthy();
    const slot = async () => (await post("/slots/list", { session_id: sessionId }))[0] as {
      id: number; status: string; peer_id: string | null; context_snapshot: string | null; input_tokens: number; task_state: string;
    };
    const summaryOf = async (peerId: string | null) =>
      (await post("/list-peers", { scope: "machine", cwd: projectDir, git_root: null, session_id: sessionId })).find((p: any) => p.id === peerId)?.summary as string | undefined;

    try {
      const firstPeer = await waitFor(async () => (await slot()).peer_id, 180_000, "the adapter joining the slot");
      await waitFor(async () => (await summaryOf(firstPeer)) === "ready", 180_000, "set_summary('ready')");
      const conversationId = await waitFor(async () => JSON.parse((await slot()).context_snapshot ?? "{}").antigravity_conversation_id as string | undefined, 30_000, "the conversation id on the slot");
      await waitFor(async () => (await slot()).input_tokens > 0, 120_000, "token usage from the first turn");
      expect(await post("/slots/list", { session_id: sessionId })).toHaveLength(1);

      await orchestrator.callTool("direct_agent", { session_id: sessionId, target: "Designer", message: "Call set_summary with exactly 'got it', then end your turn." });
      await waitFor(async () => (await summaryOf(firstPeer)) === "got it", 180_000, "the instruction delivered by the loop being carried out");
      await waitFor(async () => (await post("/peek-undelivered", { slot_id: (await slot()).id })).count === 0, 30_000, "the message being acked");

      const [firstPid] = agyPids();
      expect(firstPid).toBeTruthy();
      process.kill(firstPid!, "SIGKILL");
      const secondPid = await waitFor(async () => agyPids().find((pid) => pid !== firstPid), 120_000, "the respawned session");
      expect(commandOf(secondPid)).toContain(`--conversation ${conversationId}`);
      await waitFor(async () => {
        const s = await slot();
        return s.status === "connected" && s.peer_id !== null && s.peer_id !== firstPeer;
      }, 180_000, "the respawned adapter joining the same slot");
      expect(JSON.parse((await slot()).context_snapshot!).antigravity_conversation_id).toBe(conversationId);
      expect(await post("/slots/list", { session_id: sessionId })).toHaveLength(1);

      const released = await orchestrator.callTool("release_all", { session_id: sessionId });
      expect(released.text).toContain("Released 1 agent(s)");
      await waitFor(async () => agyPids().length === 0 && (await slot()).status === "disconnected", 240_000, "the released session closing");
      await Bun.sleep(8000);
      expect(agyPids()).toHaveLength(0);
      const status = await orchestrator.callTool("get_team_status", { session_id: sessionId });
      expect(status.text).toContain("exited after being released");
    } finally {
      console.log(`[live] orchestrator log (launcher/delivery/driver lines):\n${orchestratorLog(tmpDir, /launcher|delivery|antigravity|recovery|orchestrator\] \[|released|Respawn/i)}`);
      await orchestrator.callTool("end_session", { session_id: sessionId }).catch(() => {});
    }
  }, 900_000);
});

describe.skipIf(!LIVE_WITH_CODEX)("live: an Antigravity engineer and a Codex reviewer work as a team", () => {
  test("create_team → engineer signals done → reviewer crash respawn → both approved → release_all closes both drivers", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), TEAM_PROJECT_PREFIX));
    const projectDir = path.join(tmpDir, "project");
    const orchestrator = await startOrchestrator(tmpDir);
    const agyPids = () => children(orchestrator, "agy --input-format");
    const codexPids = () => children(orchestrator, "codex app-server");
    let sessionId: string | undefined;
    const slotsOf = () => post("/slots/list", { session_id: sessionId }) as Promise<Array<{ display_name: string; status: string; task_state: string }>>;
    const stateOf = async (name: string) => (await slotsOf()).find((s) => s.display_name === name);

    try {
      const created = await orchestrator.callTool("create_team", {
        project_dir: projectDir,
        session_name: "live agy codex",
        agents: [
          {
            agent_type: "antigravity", name: "Engineer", role: "Software Engineer",
            role_description: "TypeScript engineer. Write clean, typed code.",
            initial_task: [
              "Write src/math.ts exporting `export function fibonacci(n: number): number` (0-indexed, iterative, throws on negative input).",
              "Then: set_summary with what you wrote, send_message to the Reviewer (id from check_team_status) that src/math.ts is ready, and signal_done with the file content as proof.",
              "After signal_done end your turn; feedback arrives later as user messages.",
            ].join("\n"),
          },
          {
            agent_type: "codex", name: "Reviewer", role: "Code Reviewer",
            role_description: "Reviews TypeScript for correctness. Waits for the engineer before reviewing.",
            initial_task: [
              "Wait until src/math.ts exists (check every 10 seconds, up to 12 times), then review it: fibonacci(0)=0, fibonacci(1)=1, fibonacci(10)=55, negative input throws.",
              "Verify with `bun -e` one-liners. If correct, call approve(target=\"Engineer\") and then signal_done with your verification output as proof.",
            ].join("\n"),
          },
        ],
        plan: [
          { label: "Implement fibonacci in src/math.ts", agent_name: "Engineer" },
          { label: "Review and approve src/math.ts", agent_name: "Reviewer" },
        ],
      }, 300_000);
      expect(created.isError).toBe(false);
      sessionId = created.text.match(/Session "([^"]+)" created/)?.[1];
      expect(sessionId).toBeTruthy();
      expect(agyPids()).toHaveLength(1);
      expect(codexPids()).toHaveLength(1);

      await waitFor(async () => ["done_pending_review", "approved"].includes((await stateOf("Engineer"))?.task_state ?? ""), 420_000, "the engineer signalling done");
      expect(fs.existsSync(path.join(projectDir, "src", "math.ts"))).toBe(true);

      const [codexPid] = codexPids();
      expect(codexPid).toBeTruthy();
      process.kill(codexPid!, "SIGKILL");
      await waitFor(async () => {
        const pids = codexPids();
        return pids.length === 1 && pids[0] !== codexPid && (await stateOf("Reviewer"))?.status === "connected";
      }, 180_000, "the reviewer being respawned");

      await waitFor(async () => (await slotsOf()).every((s) => s.task_state === "approved"), 600_000, "both agents approved");
      const status = await orchestrator.callTool("get_team_status", { session_id: sessionId }, 30_000);
      expect(status.text).toContain("ALL AGENTS APPROVED");

      const released = await orchestrator.callTool("release_all", { session_id: sessionId }, 30_000);
      expect(released.text).toContain("Released 2 agent(s)");
      await waitFor(async () => (await slotsOf()).every((s) => s.status === "disconnected") && agyPids().length === 0 && codexPids().length === 0, 300_000, "both drivers closing after release");
      await Bun.sleep(10_000);
      expect([...agyPids(), ...codexPids()]).toHaveLength(0);
    } finally {
      console.log(`[live] team state: ${JSON.stringify(sessionId ? await slotsOf().catch(() => []) : [])}`);
      console.log(`[live] orchestrator log:\n${orchestratorLog(tmpDir, /launcher|delivery|recovery|orchestrator\] |codex-driver\] (Handshake|Session|Reply|codex app-server exited)|antigravity-driver/i)}`);
      if (sessionId) await orchestrator.callTool("end_session", { session_id: sessionId }).catch(() => {});
    }
  }, 1_500_000);
});

