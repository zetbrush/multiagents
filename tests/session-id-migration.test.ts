/**
 * Older brokers stored sessions whose name had no ASCII letters under the id "".
 * Starting the broker gives such a session a real id across every table.
 */

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test("a session stored with an empty id is renamed on startup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-id-migration-"));
  const dbPath = path.join(dir, "peers.db");
  const port = 17913;
  const env = { ...process.env, MULTIAGENTS_PORT: String(port), MULTIAGENTS_DB: dbPath };
  const brokerPath = new URL("../broker.ts", import.meta.url).pathname;
  const waitHealthy = async () => {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* not ready */ }
      await Bun.sleep(100);
    }
    throw new Error("broker did not start");
  };

  // First run creates the schema; then plant a legacy row with an empty id
  let proc = Bun.spawn(["bun", brokerPath], { env, stdout: "ignore", stderr: "ignore" });
  await waitHealthy();
  proc.kill();
  await proc.exited;
  const db = new Database(dbPath);
  db.run("INSERT INTO sessions (id, name, project_dir, status, config, created_at, last_active_at) VALUES ('', '食物过敏论文', ?, 'active', '{}', 1000, 1000)", [dir]);
  db.run("INSERT INTO slots (session_id, agent_type, display_name) VALUES ('', 'claude', 'Worker')");
  db.close();

  proc = Bun.spawn(["bun", brokerPath], { env, stdout: "ignore", stderr: "ignore" });
  try {
    await waitHealthy();
    const post = async (p: string, body: unknown) =>
      (await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;
    const sessions = await post("/sessions/list", {});
    expect(sessions.map((s: any) => s.id)).toEqual([`session-${(1000).toString(36)}`]);
    const slots = await post("/slots/list", { session_id: sessions[0].id });
    expect(slots.map((s: any) => s.display_name)).toEqual(["Worker"]);
  } finally {
    proc.kill();
  }
});
