/**
 * ClaudeDriver against a fake stream-json `claude` host (tests/fakes/fake-claude.ts).
 * The fake records argv and stdin so the tests can assert the launch contract
 * and the mid-turn injection behaviour the driver depends on.
 */

import { test, expect, describe, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeDriver, buildClaudeArgs } from "../orchestrator/claude-driver.ts";

const FAKE = new URL("./fakes/fake-claude.ts", import.meta.url).pathname;
const drivers: ClaudeDriver[] = [];

afterEach(async () => {
  for (const d of drivers.splice(0)) await d.kill();
});

const MCP = { mcpServers: { "multiagents-peer": { command: "bun", args: ["x"], alwaysLoad: true } } };

async function spawnFake(extra: Partial<Parameters<typeof ClaudeDriver.spawn>[0]> = {}, env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-driver-"));
  const logPath = path.join(dir, "fake.log");
  const driver = await ClaudeDriver.spawn({
    cwd: dir,
    env: { ...process.env, FAKE_CLAUDE_LOG: logPath, ...env },
    mcpConfig: MCP,
    command: ["bun", FAKE],
    ...extra,
  });
  drivers.push(driver);
  const entries = () => fs.readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { driver, dir, entries };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timeout waiting for condition");
    await Bun.sleep(25);
  }
}

describe("ClaudeDriver launch contract", () => {
  test("buildClaudeArgs produces a long-lived stream-json session with the MCP config", () => {
    const args = buildClaudeArgs({ mcpConfig: MCP, appendSystemPrompt: "PROTOCOL", model: "haiku", maxTurns: 50 });
    expect(args[0]).toBe("-p");
    expect(args).toContain("--input-format");
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--replay-user-messages");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--strict-mcp-config");
    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1]!)).toEqual(MCP);
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("PROTOCOL");
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("50");
    expect(args).not.toContain("--resume");
  });

  test("spawn with a first prompt resolves after the init event with the session id and MCP status", async () => {
    const { driver, entries } = await spawnFake({ firstPrompt: "warm up" });
    expect(driver.sessionId).toMatch(/^fake-session-/);
    expect(driver.mcpServers).toEqual([{ name: "multiagents-peer", status: "connected" }]);
    expect(driver.alive).toBe(true);
    expect(entries()[0].argv).toContain("--replay-user-messages");
    expect(entries().find((e) => e.stdin)?.stdin.message.content).toBe("warm up");
  });

  test("resumeSessionId is passed as --resume and reported back as the session id", async () => {
    const { driver, entries } = await spawnFake({ resumeSessionId: "sess-123", firstPrompt: "back again" });
    expect(driver.sessionId).toBe("sess-123");
    const argv = entries()[0].argv as string[];
    expect(argv[argv.indexOf("--resume") + 1]).toBe("sess-123");
  });

  test("a session that never reports init is killed and the first send rejects", async () => {
    const { driver } = await spawnFake({ initTimeoutMs: 1500 }, { FAKE_CLAUDE_NO_INIT: "1" });
    await expect(driver.send("hello?")).rejects.toThrow(/init event/);
    await waitFor(() => !driver.alive);
  });
});

describe("ClaudeDriver turns", () => {
  test("prompt() returns the turn result with content and usage", async () => {
    const { driver } = await spawnFake();
    const result = await driver.prompt("hello team");
    expect(result.content).toBe("done: hello team");
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 });
    expect(result.numTurns).toBe(1);
    expect(driver.busy).toBe(false);
  });

  test("a message sent mid-turn is absorbed into the running turn", async () => {
    const { driver, entries } = await spawnFake();
    const turn = driver.prompt("SLEEP:1200 first task");
    // the fake announces init from the same stdin read that starts the turn
    await waitFor(() => driver.sessionId !== null);
    expect(driver.busy).toBe(true);
    await driver.send("teammate says: use port 8080");
    const result = await turn;
    expect(result.content).toContain("absorbed:teammate says: use port 8080");
    expect(driver.turnsCompleted).toBe(1);
    const sent = entries().filter((e) => e.stdin).map((e) => e.stdin.message.content);
    expect(sent).toEqual(["SLEEP:1200 first task", "teammate says: use port 8080"]);
  });

  test("send() resolves once the host echoes the message back", async () => {
    const { driver } = await spawnFake();
    await driver.prompt("warm up");
    // Register the turn waiter before sending: the echo and the result can arrive in one chunk.
    const turn = driver.waitForTurn();
    const acked = await driver.send("ping");
    expect(acked).toBe(true);
    const result = await turn;
    expect(result.content).toBe("done: ping");
  });
});

describe("ClaudeDriver lifecycle", () => {
  test("close() ends stdin and the host exits cleanly", async () => {
    const { driver } = await spawnFake();
    await driver.prompt("warm up");
    const seen: number[] = [];
    driver.onExit((code) => { seen.push(code); });
    const code = await driver.close();
    expect(code).toBe(0);
    expect(seen).toEqual([0]);
    expect(driver.alive).toBe(false);
  });

  test("a host that dies before echoing makes send() resolve false, not true", async () => {
    const { driver } = await spawnFake({}, { FAKE_CLAUDE_CRASH: "after-init" });
    const echoed = await driver.send("never read");
    expect(echoed).toBe(false);
    expect(driver.alive).toBe(false);
  });

  test("onExit registered after the process already exited fires with the exit code", async () => {
    const { driver } = await spawnFake();
    await driver.prompt("warm up");
    await driver.close();
    const seen: number[] = [];
    driver.onExit((code) => { seen.push(code); });
    await Bun.sleep(50);
    expect(seen).toEqual([0]);
  });

  test("a host crash rejects the pending turn and reports the exit code", async () => {
    const { driver } = await spawnFake({}, { FAKE_CLAUDE_CRASH: "mid-turn" });
    const seen: number[] = [];
    driver.onExit((code) => { seen.push(code); });
    await expect(driver.prompt("SLEEP:200 will crash")).rejects.toThrow(/exited/);
    expect(seen).toEqual([3]);
    expect(driver.alive).toBe(false);
  });
});

describe("ClaudeDriver control protocol", () => {
  test("permission modes: bypass skips checks; other modes route prompts to the host and keep bypass switchable", () => {
    const bypass = buildClaudeArgs({ mcpConfig: MCP });
    expect(bypass[bypass.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");
    expect(bypass).toContain("--dangerously-skip-permissions");

    const edits = buildClaudeArgs({ mcpConfig: MCP, permissionMode: "acceptEdits", effort: "high" });
    expect(edits).not.toContain("--dangerously-skip-permissions");
    expect(edits).toContain("--allow-dangerously-skip-permissions");
    expect(edits[edits.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(edits[edits.indexOf("--effort") + 1]).toBe("high");

    const ask = buildClaudeArgs({ mcpConfig: MCP, permissionMode: "default" });
    expect(ask).not.toContain("--permission-mode");
    expect(ask).not.toContain("--dangerously-skip-permissions");
  });

  test("a tool call waits for the host's decision; a denial reaches the model as a failed tool result", async () => {
    const { driver } = await spawnFake({ permissionMode: "default" });
    const asked: string[] = [];
    driver.onPermissionRequest(async (req) => {
      asked.push(`${req.toolName}:${String(req.input.command ?? req.input.file_path)}`);
      return req.toolName === "Bash" ? { behavior: "deny", message: "not now" } : { behavior: "allow" };
    });
    const results: Array<{ content: string; is_error: boolean }> = [];
    driver.onEvent((e) => {
      if (e.type === "user") for (const b of (e.message as any)?.content ?? []) if (b.type === "tool_result") results.push({ content: b.content, is_error: b.is_error });
    });
    const turn = await driver.prompt("go TOOL:Bash:rm-rf TOOL:Read:notes.md");
    expect(turn.subtype).toBe("success");
    expect(asked).toEqual(["Bash:rm-rf", "Read:notes.md"]);
    expect(results).toEqual([{ content: "denied: not now", is_error: true }, { content: "ran Read notes.md", is_error: false }]);
  });

  test("a prompt that arrives before a handler is set waits for it", async () => {
    const { driver } = await spawnFake({ permissionMode: "default" });
    const turn = driver.prompt("TOOL:Write:a.txt");
    await Bun.sleep(300);
    driver.onPermissionRequest(async () => ({ behavior: "allow" }));
    expect((await turn).subtype).toBe("success");
  });

  test("set_model and set_permission_mode are sent as control requests; a refused mode name falls back to its alias", async () => {
    const { driver, entries } = await spawnFake({ firstPrompt: "hi", model: "haiku" }, { FAKE_CLAUDE_REJECT_MODES: "default" });
    expect(driver.model).toBe("haiku");
    await driver.setModel("opus");
    expect(driver.model).toBe("opus");
    await driver.setPermissionMode("default");
    expect(driver.permissionMode).toBe("default");
    const sent = entries().filter((e) => e.stdin?.type === "control_request").map((e) => e.stdin.request);
    expect(sent).toEqual([
      { subtype: "set_model", model: "opus" },
      { subtype: "set_permission_mode", mode: "default" },
      { subtype: "set_permission_mode", mode: "manual" },
    ]);
  });

  test("interrupt ends the running turn", async () => {
    const { driver } = await spawnFake({ permissionMode: "default" });
    let release!: () => void;
    driver.onPermissionRequest(() => new Promise((resolve) => { release = () => resolve({ behavior: "allow" }); }));
    const turn = driver.prompt("TOOL:Bash:long TOOL:Bash:more");
    await waitFor(() => typeof release === "function");
    await driver.interrupt();
    release();
    const result = await turn;
    expect(result.isError).toBe(true);
  });
});
