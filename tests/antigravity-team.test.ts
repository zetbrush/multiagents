/**
 * The orchestrator MCP server runs an Antigravity agent end to end against the
 * fake `agy` host (tests/fakes/fake-agy.ts): create_team → the real adapter,
 * started by the host from the project's MCP config without the launcher's
 * environment, joins the launcher's slot → idle and mid-turn delivery → a
 * crashed session is respawned into its conversation → release_all closes the
 * driver. Broker, orchestrator, driver and adapter are the real ones.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpStdioClient } from "./helpers/mcp-stdio-client.ts";

const BROKER_PORT = 17911;
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const ORCHESTRATOR = new URL("../orchestrator/orchestrator-server.ts", import.meta.url).pathname;
const FAKE_AGY = new URL("./fakes/fake-agy.ts", import.meta.url).pathname;

let brokerProc: import("bun").Subprocess | null = null;
let client: McpStdioClient | null = null;
let tmpDir = "";
let agyLog = "";
let home = "";

async function post(p: string, body: unknown): Promise<any> {
  const res = await fetch(`${BROKER_URL}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

async function waitFor(label: string, cond: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await Bun.sleep(100);
  }
}

const entries = (): any[] => fs.existsSync(agyLog)
  ? fs.readFileSync(agyLog, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
const sessions = () => entries().filter((e) => e.argv && !e.argv.includes("--version"));
const prompts = () => entries().filter((e) => e.stdin).map((e) => e.stdin.message.content as string);
const toolOutputs = () => entries().filter((e) => e.tool).map((e) => e.output as string);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-team-"));
  agyLog = path.join(tmpDir, "agy.log");
  home = path.join(tmpDir, "home");
  fs.mkdirSync(home);
  const brokerPath = new URL("../broker.ts", import.meta.url).pathname;
  brokerProc = Bun.spawn(["bun", brokerPath], {
    env: { ...process.env, MULTIAGENTS_PORT: String(BROKER_PORT), MULTIAGENTS_DB: path.join(tmpDir, "peers.db") },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BROKER_URL}/health`)).ok) break; } catch { /* not ready */ }
    await Bun.sleep(100);
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    MULTIAGENTS_PORT: String(BROKER_PORT),
    MULTIAGENTS_NO_DASHBOARD: "1",
    MULTIAGENTS_ANTIGRAVITY_COMMAND: `bun ${FAKE_AGY}`,
    FAKE_AGY_MCP: "1",
    // stricter than the real CLI, which passes its environment on: the slot file alone must be enough
    FAKE_AGY_MCP_ENV: "clean",
    FAKE_AGY_LOG: agyLog,
  };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  client = await McpStdioClient.spawn(["bun", ORCHESTRATOR], { cwd: tmpDir, env, stderrLog: path.join(tmpDir, "orchestrator.log") });
});

afterAll(async () => {
  client?.kill();
  for (const e of entries()) {
    const pid = e.mcp_pid ?? (e.argv ? e.pid : undefined);
    if (typeof pid === "number" && alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
  brokerProc?.kill();
});

describe("orchestrator runs an Antigravity agent", () => {
  test("create_team → adapter joins the slot → delivery → crash respawn → release", async () => {
    const projectDir = path.join(tmpDir, "project");
    const created = await client!.callTool("create_team", {
      project_dir: projectDir,
      session_name: "agy team",
      agents: [{
        agent_type: "antigravity", name: "Designer", role: "UI/UX Designer",
        role_description: "Designs the settings screen.",
        initial_task: "Sketch the settings screen. CALLTOOL:set_summary",
      }],
    }, 120_000);
    expect(created.isError).toBe(false);
    const sessionId = created.text.match(/Session "([^"]+)" created/)?.[1];
    expect(sessionId).toBeTruthy();
    const slot = async () => (await post("/slots/list", { session_id: sessionId }))[0] as {
      id: number; status: string; peer_id: string | null; context_snapshot: string | null; input_tokens: number; output_tokens: number; task_state: string;
    };
    const unacked = async () => (await post("/peek-undelivered", { slot_id: (await slot()).id })).count as number;

    // launch contract: a stream-json session, the task and the team protocol in the first prompt
    expect(sessions()).toHaveLength(1);
    const argv = sessions()[0].argv as string[];
    expect(argv[argv.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("--conversation");
    await waitFor("first prompt", () => prompts().length === 1);
    expect(prompts()[0]).toContain('You are "Designer", role: UI/UX Designer.');
    expect(prompts()[0]).toContain("Sketch the settings screen.");
    expect(prompts()[0]).toContain("=== AGENT OPERATING SYSTEM ===");

    // the server is registered for this project only; the config agy shares with the app and IDE is not created
    const projectConfig = JSON.parse(fs.readFileSync(path.join(projectDir, ".agents", "mcp_config.json"), "utf-8"));
    expect(projectConfig.mcpServers["multiagents-peer"].env).toEqual({ MULTIAGENTS_PORT: String(BROKER_PORT) });
    expect(fs.existsSync(path.join(home, ".gemini", "config", "mcp_config.json"))).toBe(false);

    // the host-spawned adapter found the launcher's slot without any MULTIAGENTS_* env of its own
    await waitFor("adapter joined the slot", async () => (await slot()).peer_id !== null);
    const joined = await slot();
    expect(joined.peer_id).toMatch(/^ag-/);
    expect(joined.status).toBe("connected");
    expect(await post("/slots/list", { session_id: sessionId })).toHaveLength(1);
    await waitFor("first tool call", () => toolOutputs().length === 1);
    expect(toolOutputs()[0]).toContain("Summary updated");

    await waitFor("conversation id and usage recorded", async () => {
      const s = await slot();
      return s.input_tokens === 100 && JSON.parse(s.context_snapshot ?? "{}").antigravity_conversation_id;
    });
    const conversationId = JSON.parse((await slot()).context_snapshot!).antigravity_conversation_id as string;
    expect(conversationId).toMatch(/^fake-conv-/);
    expect((await slot()).output_tokens).toBe(20);

    // idle session: a teammate message starts a new turn and is acked once read
    await client!.callTool("direct_agent", { session_id: sessionId, target: "Designer", message: "ship it" });
    await waitFor("idle delivery", () => prompts().some((p) => p.startsWith("[Teammate messages]") && p.includes("ship it")));
    await waitFor("idle delivery acked", async () => (await unacked()) === 0);

    // busy session: the message waits unclaimed and reaches the model through its next tool result, once
    await client!.callTool("direct_agent", { session_id: sessionId, target: "Designer", message: "SLEEP:4000 then CALLTOOL:check_team_status" });
    await waitFor("long turn started", () => prompts().some((p) => p.includes("SLEEP:4000")));
    await client!.callTool("direct_agent", { session_id: sessionId, target: "Designer", message: "mid-turn note" });
    await waitFor("mid-turn delivery through a tool result", () => toolOutputs().some((o) => o.includes("[PENDING MESSAGES]") && o.includes("mid-turn note")));
    await Bun.sleep(4000);
    expect(prompts().filter((p) => p.includes("mid-turn note"))).toHaveLength(0);
    expect(await unacked()).toBe(0);

    // crash: respawned into the same slot, resuming the conversation
    const firstPid = sessions()[0].pid as number;
    const firstPeer = (await slot()).peer_id;
    process.kill(firstPid, "SIGKILL");
    await waitFor("respawn", () => sessions().length === 2, 30_000);
    const respawnArgv = sessions()[1].argv as string[];
    expect(respawnArgv[respawnArgv.indexOf("--conversation") + 1]).toBe(conversationId);
    await waitFor("respawned adapter joined the same slot", async () => {
      const s = await slot();
      return s.status === "connected" && s.peer_id !== null && s.peer_id !== firstPeer;
    }, 30_000);
    expect(await post("/slots/list", { session_id: sessionId })).toHaveLength(1);
    expect(prompts().at(-1)).toContain("You are being restarted after a crash");

    // release: the notice is delivered, then the driver is closed and stays closed
    const secondPid = sessions()[1].pid as number;
    const released = await client!.callTool("release_all", { session_id: sessionId });
    expect(released.text).toContain("Released 1 agent(s)");
    await waitFor("driver closed after release", async () => !alive(secondPid) && (await slot()).status === "disconnected", 30_000);
    await Bun.sleep(5000);
    expect(sessions()).toHaveLength(2);
    const status = await client!.callTool("get_team_status", { session_id: sessionId });
    expect(status.text).toContain("exited after being released");

    expect((await client!.callTool("end_session", { session_id: sessionId })).text).toContain("ended");
  }, 180_000);
});
