/**
 * Live: the orchestrator MCP server runs a real Claude + Codex team end to end —
 * create_team → the agents work, review and approve → a crashed driver is
 * respawned → release_all closes the drivers → end_session. Runs only with
 * MULTIAGENTS_LIVE_TESTS=1 (costs API usage; set MULTIAGENTS_CLAUDE_MODEL=haiku).
 * The launcher rewrites its section of ~/.codex/config.toml for the test broker; it is restored afterwards.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpStdioClient } from "./helpers/mcp-stdio-client.ts";
import { restoreCodexConfig } from "./helpers/codex-config.ts";

const LIVE = process.env.MULTIAGENTS_LIVE_TESTS === "1";
const BROKER_PORT = 17908;
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const ORCHESTRATOR = new URL("../orchestrator/orchestrator-server.ts", import.meta.url).pathname;
const CODEX_CONFIG = path.join(os.homedir(), ".codex", "config.toml");
const GLOBAL_CONFIGS = [CODEX_CONFIG, path.join(os.homedir(), ".gemini", "settings.json")];
const TMP_PREFIX = "live-orchestrator-";

let brokerProc: import("bun").Subprocess | null = null;
let client: McpStdioClient | null = null;
let tmpDir = "";
const backups = new Map<string, string | null>();

async function post(p: string, body: unknown): Promise<any> {
  const res = await fetch(`${BROKER_URL}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

async function waitFor(label: string, cond: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await Bun.sleep(2000);
  }
}

function children(pattern: string): number[] {
  if (!client) return [];
  const out = Bun.spawnSync(["pgrep", "-P", String(client.pid), "-f", pattern]).stdout.toString();
  return out.split("\n").filter(Boolean).map(Number);
}

const slotsOf = (sessionId: string) => post("/slots/list", { session_id: sessionId }) as Promise<Array<{ display_name: string; status: string; task_state: string }>>;
const stateOf = async (sessionId: string, name: string) => (await slotsOf(sessionId)).find((s) => s.display_name === name);

beforeAll(async () => {
  if (!LIVE) return;
  for (const file of GLOBAL_CONFIGS) backups.set(file, fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
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
    MULTIAGENTS_PORT: String(BROKER_PORT),
    MULTIAGENTS_NO_DASHBOARD: "1",
    MULTIAGENTS_CLAUDE_MODEL: process.env.MULTIAGENTS_CLAUDE_MODEL ?? "haiku",
  };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  client = await McpStdioClient.spawn(["bun", ORCHESTRATOR], { cwd: tmpDir, env, stderrLog: path.join(tmpDir, "orchestrator.log") });
});

afterAll(async () => {
  if (!LIVE) return;
  client?.kill();
  await Bun.sleep(2000);
  brokerProc?.kill();
  for (const [file, content] of backups) {
    if (content === null) { try { fs.unlinkSync(file); } catch { /* never existed */ } }
    // the user's own Codex may have written to its config meanwhile
    else if (file === CODEX_CONFIG) restoreCodexConfig(file, content, TMP_PREFIX);
    else fs.writeFileSync(file, content);
  }
});

describe.skipIf(!LIVE)("live: orchestrator server runs a team", () => {
  test("create_team → approve → crash respawn → release_all closes drivers → end_session", async () => {
    const projectDir = path.join(tmpDir, "project");
    const created = await client!.callTool("create_team", {
      project_dir: projectDir,
      session_name: "live orchestrator",
      agents: [
        {
          agent_type: "claude", name: "Engineer", role: "Software Engineer",
          role_description: "TypeScript engineer. Write clean, typed code.",
          initial_task: [
            "Write src/math.ts exporting `export function fibonacci(n: number): number` (0-indexed, iterative, throws on negative input).",
            "Then: set_summary with what you wrote, send_message to the Reviewer (id from check_team_status) that src/math.ts is ready, and signal_done with the file content as proof.",
            "After signal_done keep calling check_messages every 10 seconds until you are released.",
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
    }, 240_000);
    expect(created.isError).toBe(false);
    const sessionId = created.text.match(/Session "([^"]+)" created/)?.[1];
    expect(sessionId).toBeTruthy();
    expect(children("dashboard/server.ts")).toHaveLength(0);
    expect(children("codex app-server")).toHaveLength(1);
    expect(children("claude")).toHaveLength(1);

    await waitFor("engineer signalled done", async () => ["done_pending_review", "approved"].includes((await stateOf(sessionId!, "Engineer"))?.task_state ?? ""), 240_000);

    // Crash the reviewer's driver: the orchestrator must respawn it (thread/resume) into the same slot.
    const [codexPid] = children("codex app-server");
    expect(codexPid).toBeTruthy();
    process.kill(codexPid!, "SIGKILL");
    await waitFor("reviewer respawned", async () => {
      const pids = children("codex app-server");
      return pids.length === 1 && pids[0] !== codexPid && (await stateOf(sessionId!, "Reviewer"))?.status === "connected";
    }, 120_000);

    await waitFor("both approved", async () => (await slotsOf(sessionId!)).every((s) => s.task_state === "approved"), 300_000);
    const status = await client!.callTool("get_team_status", { session_id: sessionId }, 30_000);
    expect(status.text).toContain("ALL AGENTS APPROVED");
    expect(status.text).toContain("auto-respawned");

    const released = await client!.callTool("release_all", { session_id: sessionId }, 30_000);
    expect(released.text).toContain("Released 2 agent(s)");
    await waitFor("drivers closed after release", async () => (await slotsOf(sessionId!)).every((s) => s.status === "disconnected") && children("codex app-server|claude").length === 0, 180_000);
    await Bun.sleep(12_000);
    expect(children("codex app-server|claude")).toHaveLength(0);
    const after = await client!.callTool("get_team_status", { session_id: sessionId }, 30_000);
    expect(after.text).toContain("exited after being released");
    expect(after.text).not.toContain("auto-respawned after crash");

    const ended = await client!.callTool("end_session", { session_id: sessionId }, 30_000);
    expect(ended.text).toContain("ended");
    const deleted = await client!.callTool("delete_session", { session_id: sessionId }, 30_000);
    expect(deleted.text).toContain("permanently deleted");
  }, 900_000);
});
