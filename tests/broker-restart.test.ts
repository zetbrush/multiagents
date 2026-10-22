/**
 * A broker left running from before an update is recognised by its missing
 * features and restarted on the current code.
 */
import { test, expect, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BROKER_FEATURES } from "../shared/constants.ts";

const PORT = 17931;
const URL_ = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-restart-"));
const env = { ...process.env, HOME: dir, MULTIAGENTS_PORT: String(PORT), MULTIAGENTS_DB: path.join(dir, "peers.db"), MULTIAGENTS_NO_DASHBOARD: "1" };
let newPid: number | undefined;

afterAll(() => {
  if (newPid) try { process.kill(newPid, "SIGTERM"); } catch { /* gone */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an old broker is reported as missing features and restarted on this code", async () => {
  // Stands in for a broker build from before the feature list existed
  const oldScript = path.join(dir, "old-broker.ts");
  fs.writeFileSync(oldScript, `Bun.serve({ port: ${PORT}, hostname: "127.0.0.1", fetch: () => Response.json({ status: "ok", peers: 0, pid: process.pid, version: "0.0.1" }) });`);
  const old = Bun.spawn(["bun", oldScript], { env, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 50 && !(await fetch(`${URL_}/health`).catch(() => null)); i++) await Bun.sleep(100);

  const runtime = new URL("../orchestrator/runtime.ts", import.meta.url).pathname;
  const client = new URL("../shared/broker-client.ts", import.meta.url).pathname;
  const script = `
    import { missingBrokerFeatures, restartBroker } from ${JSON.stringify(runtime)};
    import { BrokerClient } from ${JSON.stringify(client)};
    const before = await missingBrokerFeatures();
    await restartBroker(new BrokerClient(${JSON.stringify(URL_)}));
    console.log(JSON.stringify({ before, after: await missingBrokerFeatures() }));
    process.exit(0);`;
  const child = Bun.spawn(["bun", "-e", script], { env, stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(child.stdout).text()).trim().split("\n").at(-1)!;
  const { before, after } = JSON.parse(out);
  expect(before).toEqual([...BROKER_FEATURES]);
  expect(after).toEqual([]);
  expect(await old.exited).not.toBeNull();

  const health = await (await fetch(`${URL_}/health`)).json() as { pid: number; features: string[] };
  newPid = health.pid;
  expect(health.features).toEqual([...BROKER_FEATURES]);
}, 30_000);

test("restarting a current broker leaves its agents running and registered", async () => {
  // The broker from the first test is current; register an agent process with it
  const agent = Bun.spawn(["sleep", "60"], { stdout: "ignore" });
  const reg = await (await fetch(`${URL_}/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pid: agent.pid, cwd: dir, git_root: null, tty: null, summary: "working", agent_type: "claude" }),
  })).json() as { id: string };
  expect(reg.id).toBeTruthy();

  const runtime = new URL("../orchestrator/runtime.ts", import.meta.url).pathname;
  const client = new URL("../shared/broker-client.ts", import.meta.url).pathname;
  const child = Bun.spawn(["bun", "-e", `
    import { restartBroker } from ${JSON.stringify(runtime)};
    import { BrokerClient } from ${JSON.stringify(client)};
    await restartBroker(new BrokerClient(${JSON.stringify(URL_)}));
    process.exit(0);`], { env, stdout: "ignore", stderr: "ignore" });
  expect(await child.exited).toBe(0);

  const health = await (await fetch(`${URL_}/health`)).json() as { pid: number; peers: number };
  expect(health.pid).not.toBe(newPid);
  newPid = health.pid;
  expect(health.peers).toBe(1);
  expect(agent.killed || agent.exitCode !== null).toBe(false);
  agent.kill();
}, 30_000);

test("a broker counts as busy while a driver-run agent's slot is connected, even with no peer", async () => {
  const runtime = new URL("../orchestrator/runtime.ts", import.meta.url).pathname;
  const client = new URL("../shared/broker-client.ts", import.meta.url).pathname;
  const post = (p: string, body: unknown) => fetch(`${URL_}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()) as Promise<any>;
  // Drop the peer of the previous test so only the slot can make the broker busy
  for (const p of await post("/list-peers", { scope: "machine", cwd: dir, git_root: null })) await post("/unregister", { id: p.id });
  const idle = async () => {
    const child = Bun.spawn(["bun", "-e", `
      import { brokerIsIdle } from ${JSON.stringify(runtime)};
      import { BrokerClient } from ${JSON.stringify(client)};
      console.log(await brokerIsIdle(new BrokerClient(${JSON.stringify(URL_)})));
      process.exit(0);`], { env, stdout: "pipe", stderr: "ignore" });
    return (await new Response(child.stdout).text()).trim().split("\n").at(-1) === "true";
  };
  await post("/sessions/create", { id: "idle-check", name: "Idle check", project_dir: dir });
  const slot = await post("/slots/create", { session_id: "idle-check", agent_type: "codex", display_name: "Codex" });
  expect(await idle()).toBe(true);
  await post("/slots/update", { id: slot.id, status: "connected" });
  expect(await idle()).toBe(false);
}, 30_000);
