/**
 * "Other" agents: an OpenAI-compatible provider (a fake one here) runs an
 * agent with the team tools and local tools, through a real broker and the
 * web dashboard — streamed thinking, tool steps, messages to the person,
 * token accounting, step approvals and a live model switch.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { realThroughExistingAncestor } from "../orchestrator/api-driver.ts";

const BROKER_PORT = 17941;
const DASHBOARD_PORT = 17942;
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const DASHBOARD_URL = `http://127.0.0.1:${DASHBOARD_PORT}`;

let brokerProc: import("bun").Subprocess | null = null;
let dashboardProc: import("bun").Subprocess | null = null;
let fakeApi: ReturnType<typeof Bun.serve> | null = null;
let tmpDir = "";
const requests: Array<{ model: string; messages: any[]; tools: any[]; reasoning_effort?: string }> = [];

// --- A scripted OpenAI-compatible server ---
// The latest user message holds the script: THINK:<words> | then actions
// TOOL:Read:<path>, TOOL:Bash:<cmd>, SAY:<words_with_underscores> (send_message
// to the person). Each tool result advances to the next action; then a final reply.
function scriptFor(messages: any[]) {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") { lastUser = i; break; }
  const text = String(messages[lastUser]?.content ?? "");
  const done = messages.slice(lastUser + 1).filter((m) => m.role === "tool").length;
  const actions = [...text.matchAll(/(TOOL:(\w+):([^\s|]+)|SAY:([^\s|]+))/g)].map((m) => m[4]
    ? { name: "send_message", args: { to_id: "human", message: m[4].replace(/_/g, " ") } }
    : { name: m[2]!, args: m[2] === "Bash" ? { command: m[3]!.replace(/_/g, " ") } : { file_path: m[3]! } });
  const think = done === 0 ? text.match(/THINK:([^|]+)/)?.[1]?.trim() : undefined;
  return { action: actions[done], think, text };
}

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

async function post(p: string, body: unknown): Promise<any> {
  return (await fetch(`${BROKER_URL}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
}
async function api(action: string, body?: unknown): Promise<{ status: number; ok: boolean; result?: any; error?: string }> {
  const res = await fetch(`${DASHBOARD_URL}/api/${action}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, ...(await res.json()) as any };
}
async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(150);
  }
  throw new Error("waitFor timed out");
}
const activity = async (sid: string) => ((await (await fetch(`${DASHBOARD_URL}/api/activity?session_id=${encodeURIComponent(sid)}`)).json()) as any).result as any[];

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-agent-"));
  fakeApi = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== "Bearer test-key") return Response.json({ error: { message: "bad key" } }, { status: 401 });
      if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "fake-chat" }, { id: "fake-reasoner" }] });
      if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
      const body = await req.json() as any;
      requests.push(body);
      const { action, think, text } = scriptFor(body.messages);
      const chunks: unknown[] = [];
      if (think) for (const w of think.split(/(?<= )/)) chunks.push({ choices: [{ delta: { reasoning_content: w } }] });
      if (action) {
        const args = JSON.stringify(action.args);
        chunks.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${requests.length}`, function: { name: action.name, arguments: args.slice(0, 10) } }] } }] });
        chunks.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(10) } }] } }] });
      } else {
        chunks.push({ choices: [{ delta: { content: `done: ${text.slice(0, 40)}` } }] });
      }
      chunks.push({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } });
      return sse(chunks);
    },
  });

  const env = { ...process.env, HOME: tmpDir, MULTIAGENTS_PORT: String(BROKER_PORT), MULTIAGENTS_DB: path.join(tmpDir, "peers.db") };
  brokerProc = Bun.spawn(["bun", new URL("../broker.ts", import.meta.url).pathname], { env, stdout: "ignore", stderr: "ignore" });
  await waitFor(async () => (await fetch(`${BROKER_URL}/health`).catch(() => null))?.ok);
  dashboardProc = Bun.spawn(["bun", new URL("../dashboard/server.ts", import.meta.url).pathname], {
    env: { ...env, MULTIAGENTS_WEB_PORT: String(DASHBOARD_PORT), MULTIAGENTS_NO_OPEN: "1", MULTIAGENTS_NO_DASHBOARD: "1" },
    stdout: "ignore", stderr: Bun.file(path.join(tmpDir, "dashboard.log")),
  });
  await waitFor(async () => (await fetch(DASHBOARD_URL).catch(() => null))?.ok);
}, 30_000);

afterAll(async () => {
  if (process.env.DEBUG_API_AGENT) console.log(fs.readFileSync(path.join(tmpDir, "dashboard.log"), "utf-8").slice(-4000));
  dashboardProc?.kill();
  brokerProc?.kill();
  fakeApi?.stop(true);
  await Bun.sleep(200);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("API providers", () => {
  test("a provider is saved without exposing its key, and lists its models", async () => {
    const saved = await api("providers/save", { name: "Fake AI", base_url: `http://127.0.0.1:${fakeApi!.port}/v1/chat/completions`, api_key: "test-key", default_model: "fake-chat", input_price: 1, output_price: 2 });
    expect(saved.ok).toBe(true);
    // A short key shows nothing of itself
    expect(saved.result.provider).toMatchObject({ id: "fake-ai", base_url: `http://127.0.0.1:${fakeApi!.port}/v1`, api_key_hint: "••••" });
    expect(JSON.stringify((await api("providers/list")).result)).not.toContain("test-key");
    const stored = JSON.parse(fs.readFileSync(path.join(tmpDir, ".multiagents", "providers.json"), "utf-8"));
    expect(stored[0].api_key).toBe("test-key");
    expect(fs.statSync(path.join(tmpDir, ".multiagents", "providers.json")).mode & 0o077).toBe(0);

    const models = await api("providers/models", { id: "fake-ai" });
    expect(models.result.models).toEqual(["fake-chat", "fake-reasoner"]);
    // An update without a key keeps the saved one
    expect((await api("providers/save", { id: "fake-ai", name: "Fake AI", base_url: `http://127.0.0.1:${fakeApi!.port}/v1`, api_key: "", default_model: "fake-chat", input_price: 1, output_price: 2 })).ok).toBe(true);
    expect((await api("providers/models", { id: "fake-ai" })).ok).toBe(true);
    expect((await api("agents/available")).result.api).toBe(true);
  }, 30_000);

  test("an API agent needs a configured provider", async () => {
    const r = await api("team/create", { project_dir: path.join(tmpDir, "nope"), session_name: "Nope", agents: [{ agent_type: "api", provider: "missing", name: "X", role: "Writer" }] });
    expect(r.status).toBe(400);
    expect(r.error).toContain("pick an API provider");
  }, 15_000);
});

describe("an API agent at work", () => {
  let sid = "";
  let slotId = 0;

  test("it thinks, reads a project file, messages the person, and its tokens and cost are counted", async () => {
    const dir = path.join(tmpDir, "proj");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.md"), "cohort: 1024 participants\n");
    const r = await api("team/create", {
      project_dir: dir, session_name: "API Team", goal: "Review the notes",
      agents: [{ agent_type: "api", provider: "fake-ai", name: "Editor", role: "Editor", initial_task: "THINK:read the notes before answering | TOOL:Read:notes.md SAY:notes_look_fine" }],
      workflow: {},
    });
    expect(r.ok).toBe(true);
    sid = r.result.data.session_id;
    const [slot] = await post("/slots/list", { session_id: sid });
    slotId = slot.id;
    expect(slot.agent_type).toBe("api");
    expect(JSON.parse(slot.context_snapshot)).toMatchObject({ provider_id: "fake-ai", provider_name: "Fake AI" });

    const reply = await waitFor(async () => (await post("/message-log", { session_id: sid, limit: 50 })).find((m: any) => m.to_id === "human" && m.from_slot_id === slotId), 20_000);
    expect(reply.text).toBe("notes look fine");

    const steps = await waitFor(async () => {
      const list = await activity(sid);
      return list.some((e) => e.kind === "turn_end") ? list : null;
    });
    expect(steps.some((e) => e.kind === "thinking" && /read the notes/.test(e.detail ?? ""))).toBe(true);
    expect(steps.some((e) => e.title === "Read notes.md")).toBe(true);
    expect(steps.find((e) => e.kind === "tool_result" && /cohort/.test(e.detail ?? ""))).toBeTruthy();

    // Its team-tools process registers under the agent's own type
    const peers = await post("/list-peers", { scope: "machine", cwd: dir, git_root: null, agent_type: "api" });
    expect(peers.some((p: any) => p.slot_id === slotId)).toBe(true);

    // Team tools reach the model under their own names, next to the local ones
    const names = requests[0]!.tools.map((t: any) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(["Read", "Bash", "send_message", "signal_done"]));
    expect(requests[0]!.model).toBe("fake-chat");

    const counted = await waitFor(async () => {
      const s = await post("/slots/get", { id: slotId });
      return s.output_tokens >= 60 ? s : null;
    });
    expect(counted.input_tokens).toBeGreaterThanOrEqual(300);
    expect(counted.cost_usd).toBeGreaterThan(0);
  }, 40_000);

  test("in ask mode a command waits for the person; a denial reaches the model", async () => {
    expect((await api("agents/settings", { session_id: sid, slot_id: slotId, approval_mode: "ask" })).ok).toBe(true);
    await Bun.sleep(3_500); // the next delivery tick applies the mode
    await api("messages/send", { session_id: sid, slot_id: slotId, text: "TOOL:Bash:rm_-rf_build" });
    const pending = await waitFor(async () => {
      const list = await post("/approvals/list", { session_id: sid, status: "pending" });
      return list.length ? list : null;
    });
    expect(pending[0]).toMatchObject({ tool: "Bash", title: "$ rm -rf build", slot_id: slotId });
    expect((await api("approvals/decide", { session_id: sid, approval_id: pending[0].id, decision: "deny", note: "not now" })).ok).toBe(true);
    await waitFor(async () => (await activity(sid)).some((e) => e.kind === "tool_result" && /denied: A person denied this tool call: not now/.test(e.detail ?? "")));
  }, 40_000);

  test("the model can be cleared only when the provider has a default", async () => {
    const base = `http://127.0.0.1:${fakeApi!.port}/v1`;
    await api("providers/save", { id: "fake-ai", name: "Fake AI", base_url: base, default_model: "", input_price: 1, output_price: 2 });
    const refused = await api("agents/settings", { session_id: sid, slot_id: slotId, model: "" });
    expect(refused.status).toBe(400);
    expect(refused.error).toContain("no default model");
    await api("providers/save", { id: "fake-ai", name: "Fake AI", base_url: base, default_model: "fake-chat", input_price: 1, output_price: 2 });
    expect((await api("agents/settings", { session_id: sid, slot_id: slotId, model: "" })).ok).toBe(true);
  });

  test("a model switch applies to the next request", async () => {
    expect((await api("agents/settings", { session_id: sid, slot_id: slotId, model: "fake-reasoner", approval_mode: "bypass" })).ok).toBe(true);
    await Bun.sleep(3_500);
    const before = requests.length;
    await api("messages/send", { session_id: sid, slot_id: slotId, text: "what model are you?" });
    await waitFor(async () => requests.length > before);
    expect(requests.at(-1)!.model).toBe("fake-reasoner");
    expect((await api("session/end", { session_id: sid })).ok).toBe(true);
  }, 30_000);
});

describe("local tools stay in the project", () => {
  test("a new file under a symlinked directory resolves to where it would really land", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "api-root-")));
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "api-outside-")));
    fs.symlinkSync(outside, path.join(root, "link"));
    // Neither link/new nor link/new/file exists: the symlink still decides
    expect(realThroughExistingAncestor(path.join(root, "link", "new", "file.md"))).toBe(path.join(outside, "new", "file.md"));
    expect(realThroughExistingAncestor(path.join(root, "plain", "new.md"))).toBe(path.join(root, "plain", "new.md"));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
});
