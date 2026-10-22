/**
 * CodexDriver against a fake `codex app-server` (tests/fakes/fake-codex-app-server.ts)
 * that speaks the v2 wire protocol of codex-cli 0.156.1 and records every
 * request so the tests can assert what the driver actually sends.
 */

import { test, expect, describe, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodexDriver } from "../orchestrator/codex-driver.ts";

const FAKE = new URL("./fakes/fake-codex-app-server.ts", import.meta.url).pathname;
const drivers: CodexDriver[] = [];

afterEach(async () => {
  for (const d of drivers.splice(0)) await d.kill();
});

async function spawnFake() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-driver-"));
  const logPath = path.join(dir, "fake.log");
  const driver = await CodexDriver.spawn(dir, { ...process.env, FAKE_CODEX_LOG: logPath }, { command: ["bun", FAKE] });
  drivers.push(driver);
  const entries = () => fs.existsSync(logPath)
    ? fs.readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { driver, dir, entries };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timeout waiting for condition");
    await Bun.sleep(25);
  }
}

describe("CodexDriver session start", () => {
  test("sends developerInstructions, cwd, sandbox and approvalPolicy on thread/start", async () => {
    const { driver, dir, entries } = await spawnFake();
    await driver.startSession({ prompt: "hello", cwd: dir, sandbox: "workspace-write", developerInstructions: "You are Alice, reviewer." });

    const threadStart = entries().find((e) => e.request === "thread/start");
    expect(threadStart.params.developerInstructions).toBe("You are Alice, reviewer.");
    expect(threadStart.params.cwd).toBe(dir);
    expect(threadStart.params.sandbox).toBe("workspace-write");
    expect(threadStart.params.approvalPolicy).toBe("never");

    const turnStart = entries().find((e) => e.request === "turn/start");
    expect(turnStart.params.developerInstructions).toBeUndefined();
    expect(turnStart.params.input).toEqual([{ type: "text", text: "hello" }]);
  });

  test("resumeSession sends thread/resume with the thread id and instructions, then turns work", async () => {
    const { driver, dir, entries } = await spawnFake();
    await driver.resumeSession({ threadId: "thr_old_42", cwd: dir, sandbox: "workspace-write", developerInstructions: "You are back." });
    expect(driver.threadId).toBe("thr_old_42");

    const resume = entries().find((e) => e.request === "thread/resume");
    expect(resume.params.threadId).toBe("thr_old_42");
    expect(resume.params.developerInstructions).toBe("You are back.");
    expect(resume.params.cwd).toBe(dir);
    expect(resume.params.approvalPolicy).toBe("never");

    const result = await driver.reply("thr_old_42", "continue");
    expect(result.content).toBe("ack:continue");
  });

  test("records the approvals reviewer reported by thread/start", async () => {
    const { driver, dir } = await spawnFake();
    await driver.startSession({ prompt: "hi", cwd: dir });
    expect(driver.approvalsReviewer).toBe("user");
  });
});

describe("CodexDriver turn results", () => {
  test("a completed turn resolves with content and usage from thread/tokenUsage/updated", async () => {
    const { driver, dir } = await spawnFake();
    const result = await driver.startSession({ prompt: "do the thing", cwd: dir });
    expect(result.content).toBe("ack:do the thing");
    expect(result.status).toBe("completed");
    expect(result.usage).toEqual({ input_tokens: 120, output_tokens: 30, cached_input_tokens: 10 });
  });

  test("a failed turn rejects with the server's error message", async () => {
    const { driver, dir } = await spawnFake();
    const first = await driver.startSession({ prompt: "warm up", cwd: dir });
    await expect(driver.reply(first.threadId, "SCENARIO:fail")).rejects.toThrow(/boom: simulated model error/);
    expect(driver.activeTurnId).toBeNull();
  });

  test("an interrupted turn resolves with status interrupted", async () => {
    const { driver, dir } = await spawnFake();
    const first = await driver.startSession({ prompt: "warm up", cwd: dir });
    const slow = driver.reply(first.threadId, "SCENARIO:slow:8000");
    await waitFor(() => driver.activeTurnId !== null);
    await driver.interrupt(first.threadId);
    const result = await slow;
    expect(result.status).toBe("interrupted");
  });

  test("interrupting when no turn is active is a no-op", async () => {
    const { driver, dir } = await spawnFake();
    const first = await driver.startSession({ prompt: "warm up", cwd: dir });
    await driver.interrupt(first.threadId);
    expect(driver.activeTurnId).toBeNull();
  });
});

describe("CodexDriver steering", () => {
  test("steer during an active turn injects text into that turn", async () => {
    const { driver, dir } = await spawnFake();
    const first = await driver.startSession({ prompt: "warm up", cwd: dir });
    const slow = driver.reply(first.threadId, "SCENARIO:slow:1500");
    await waitFor(() => driver.activeTurnId !== null);
    await driver.steer(first.threadId, "teammate says hi");
    const result = await slow;
    expect(result.content).toContain("steered:teammate says hi");
  });

  test("steer without an active turn rejects", async () => {
    const { driver, dir } = await spawnFake();
    const first = await driver.startSession({ prompt: "warm up", cwd: dir });
    await expect(driver.steer(first.threadId, "late")).rejects.toThrow(/no active turn/);
  });
});

describe("CodexDriver thread status and items", () => {
  test("tracks thread/status/changed and in-flight items", async () => {
    const { driver, dir } = await spawnFake();
    const first = await driver.startSession({ prompt: "warm up", cwd: dir });
    // thread/status/changed is its own notification and may land after turn/completed
    await waitFor(() => driver.threadStatus === "idle");

    const slow = driver.reply(first.threadId, "SCENARIO:slow:1200");
    await waitFor(() => driver.activeItems === 1);
    await waitFor(() => driver.threadStatus === "active");
    await slow;
    expect(driver.activeItems).toBe(0);
    await waitFor(() => driver.threadStatus === "idle");
  });
});

describe("CodexDriver server requests", () => {
  const cases: Array<{ scenario: string; method: string; check: (r: any) => void }> = [
    { scenario: "SCENARIO:command", method: "item/commandExecution/requestApproval", check: (r) => expect(r.result).toEqual({ decision: "acceptForSession" }) },
    { scenario: "SCENARIO:filechange", method: "item/fileChange/requestApproval", check: (r) => expect(r.result).toEqual({ decision: "acceptForSession" }) },
    {
      scenario: "SCENARIO:permissions", method: "item/permissions/requestApproval", check: (r) => {
        expect(r.result.scope).toBe("session");
        expect(r.result.permissions.fileSystem.read).toEqual([{ type: "path", path: "/tmp" }]);
        expect(r.result.permissions.network).toEqual({ enabled: true });
      },
    },
    { scenario: "SCENARIO:userinput", method: "item/tool/requestUserInput", check: (r) => expect(r.result).toEqual({ answers: {} }) },
    { scenario: "SCENARIO:elicitation", method: "mcpServer/elicitation/request", check: (r) => expect(r.result).toEqual({ action: "decline" }) },
    {
      scenario: "SCENARIO:dyntool", method: "item/tool/call", check: (r) => {
        expect(r.result.success).toBe(false);
        expect(r.result.contentItems[0].type).toBe("inputText");
      },
    },
    { scenario: "SCENARIO:auth", method: "account/chatgptAuthTokens/refresh", check: (r) => { expect(r.result).toBeUndefined(); expect(r.error.code).toBe(-32601); } },
    { scenario: "SCENARIO:legacy", method: "execCommandApproval", check: (r) => expect(r.result).toEqual({ decision: "approved_for_session" }) },
  ];

  for (const c of cases) {
    test(`${c.method} gets a schema-valid reply`, async () => {
      const { driver, dir, entries } = await spawnFake();
      const first = await driver.startSession({ prompt: "warm up", cwd: dir });
      await driver.reply(first.threadId, c.scenario);
      const entry = entries().find((e) => e.serverRequest === c.method);
      expect(entry).toBeDefined();
      c.check(entry.response);
    });
  }
});

describe("CodexDriver process lifecycle", () => {
  test("onExit registered after the process already exited fires with the exit code", async () => {
    const { driver } = await spawnFake();
    await driver.kill();
    await driver.process.exited;
    const seen: number[] = [];
    driver.onExit((code) => { seen.push(code); });
    await Bun.sleep(50);
    expect(seen).toHaveLength(1);
    expect(typeof seen[0]).toBe("number");
  });

  test("process exit rejects the in-flight turn and fires onExit", async () => {
    const { driver, dir } = await spawnFake();
    const first = await driver.startSession({ prompt: "warm up", cwd: dir });
    let exited = false;
    driver.onExit(() => { exited = true; });
    const slow = driver.reply(first.threadId, "SCENARIO:slow:8000");
    await waitFor(() => driver.activeTurnId !== null);
    driver.process.kill("SIGKILL");
    await expect(slow).rejects.toThrow(/exited/);
    await waitFor(() => exited);
    expect(driver.alive).toBe(false);
  });
});

describe("CodexDriver approvals and turn settings", () => {
  test("an approval handler decides command and file-change requests", async () => {
    const { driver, dir, entries } = await spawnFake();
    const seen: string[] = [];
    driver.onApprovalRequest(async (req) => {
      seen.push(`${req.kind}:${String(req.params.command ?? req.params.itemId)}`);
      return req.kind === "command" ? "decline" : "acceptForSession";
    });
    const first = await driver.startSession({ prompt: "warm up", cwd: dir });
    await driver.reply(first.threadId, "SCENARIO:command");
    await driver.reply(first.threadId, "SCENARIO:filechange");
    await driver.reply(first.threadId, "SCENARIO:legacy");
    expect(seen).toEqual(["command:rm -rf build", "fileChange:item_fc", "command:ls"]);
    const responses = Object.fromEntries(entries().filter((e) => e.serverRequest).map((e) => [e.serverRequest, e.response.result]));
    expect(responses["item/commandExecution/requestApproval"]).toEqual({ decision: "decline" });
    expect(responses["item/fileChange/requestApproval"]).toEqual({ decision: "acceptForSession" });
    expect(responses["execCommandApproval"]).toEqual({ decision: "denied" });
  });

  test("settings changed between turns apply to the next turn/start", async () => {
    const { driver, dir, entries } = await spawnFake();
    const first = await driver.startSession({ prompt: "warm up", cwd: dir });
    driver.settings = { approvalPolicy: "untrusted", model: "gpt-5", effort: "high" };
    await driver.reply(first.threadId, "next");
    const turns = entries().filter((e) => e.request === "turn/start").map((e) => e.params);
    expect(turns[0].approvalPolicy).toBe("never");
    expect(turns[1]).toMatchObject({ approvalPolicy: "untrusted", model: "gpt-5", effort: "high" });
  });

  test("a read-only sandbox override (Q&A mode) reaches the next turn", async () => {
    const { driver, dir, entries } = await spawnFake();
    const first = await driver.startSession({ prompt: "warm up", cwd: dir });
    driver.settings = { approvalPolicy: "untrusted", sandbox: "read-only" };
    await driver.reply(first.threadId, "what is left?");
    const turns = entries().filter((e) => e.request === "turn/start").map((e) => e.params);
    expect(turns[1].sandboxPolicy).toMatchObject({ type: "readOnly" });
  });
});
