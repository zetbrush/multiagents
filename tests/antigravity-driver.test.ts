/**
 * AntigravityDriver against a fake stream-json `agy` host (tests/fakes/fake-agy.ts).
 * The fake records argv and stdin so the tests can assert the launch contract
 * and the one-turn-per-prompt behaviour the driver depends on.
 */

import { test, expect, describe, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AntigravityDriver, buildAntigravityArgs } from "../orchestrator/antigravity-driver.ts";

const FAKE = new URL("./fakes/fake-agy.ts", import.meta.url).pathname;
const drivers: AntigravityDriver[] = [];

afterEach(async () => {
  for (const d of drivers.splice(0)) await d.kill();
});

async function spawnFake(extra: Partial<Parameters<typeof AntigravityDriver.spawn>[0]> = {}, env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-driver-"));
  const logPath = path.join(dir, "fake.log");
  const driver = await AntigravityDriver.spawn({
    cwd: dir,
    env: { ...process.env, FAKE_AGY_LOG: logPath, ...env },
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

describe("AntigravityDriver launch contract", () => {
  test("buildAntigravityArgs produces a long-lived stream-json session that takes prompts from stdin", () => {
    const args = buildAntigravityArgs({ model: "gemini-3.8-flash-medium" });
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args[args.indexOf("--model") + 1]).toBe("gemini-3.8-flash-medium");
    expect(args).not.toContain("--conversation");
    // a prompt given with -p is dropped by the CLI in stream-json input mode
    expect(args).not.toContain("-p");
  });

  test("resumeConversationId is passed as --conversation", () => {
    const args = buildAntigravityArgs({ resumeConversationId: "conv-123" });
    expect(args[args.indexOf("--conversation") + 1]).toBe("conv-123");
    expect(args).not.toContain("--model");
  });

  test("spawn with a first prompt resolves after the init event with the conversation id", async () => {
    const { driver, entries } = await spawnFake({ firstPrompt: "warm up" });
    expect(driver.conversationId).toMatch(/^fake-conv-/);
    expect(driver.permissionMode).toBe("always-proceed");
    expect(driver.alive).toBe(true);
    // init is announced at startup, so the prompt may still be in the pipe
    await waitFor(() => entries().some((e) => e.stdin));
    expect(entries().find((e) => e.stdin)?.stdin).toEqual({ event: "user", message: { content: "warm up" } });
  });

  test("prompts sent before init all wait for it instead of failing", async () => {
    const { driver } = await spawnFake({}, { FAKE_AGY_INIT: "on-first-message" });
    const results = await Promise.all([
      driver.send("first", { echoTimeoutMs: Infinity }),
      driver.send("second", { echoTimeoutMs: Infinity }),
    ]);
    expect(results).toEqual([true, true]);
    await waitFor(() => driver.turnsCompleted === 2);
  });

  test("a host that announces init only after the first prompt is supported too", async () => {
    const { driver } = await spawnFake({ firstPrompt: "warm up" }, { FAKE_AGY_INIT: "on-first-message" });
    expect(driver.conversationId).toMatch(/^fake-conv-/);
  });

  test("a known conversation is resumed under the same id", async () => {
    const first = await spawnFake({ firstPrompt: "warm up" });
    const conversationId = first.driver.conversationId!;
    await first.driver.close();

    // the same log file, so the fake remembers the conversation the way the CLI's store does
    const { driver } = await spawnFake({ resumeConversationId: conversationId, firstPrompt: "back again" }, { FAKE_AGY_LOG: path.join(first.dir, "fake.log") });
    expect(driver.conversationId).toBe(conversationId);
    const argv = first.entries().filter((e) => e.argv).at(-1).argv as string[];
    expect(argv[argv.indexOf("--conversation") + 1]).toBe(conversationId);
  });

  test("an unknown conversation id starts a new conversation, as the CLI does", async () => {
    const { driver } = await spawnFake({ resumeConversationId: "00000000-0000-4000-8000-000000000000", firstPrompt: "hello" });
    expect(driver.conversationId).toMatch(/^fake-conv-/);
    expect(driver.alive).toBe(true);
  });

  test("a session that never reports init is killed and the first send rejects", async () => {
    const { driver } = await spawnFake({ initTimeoutMs: 1500 }, { FAKE_AGY_NO_INIT: "1" });
    await expect(driver.send("hello?")).rejects.toThrow(/init event/);
    await waitFor(() => !driver.alive);
  });

  test("onSpawn runs with the pid as soon as the process exists, and its result runs at exit", async () => {
    const order: string[] = [];
    const { driver, entries } = await spawnFake({
      firstPrompt: "warm up",
      onSpawn: (pid) => {
        order.push(`spawned:${pid}`);
        return () => { order.push("exited"); };
      },
    });
    expect(order).toEqual([`spawned:${driver.pid}`]);
    expect(entries()[0].pid).toBe(driver.pid);
    await driver.close();
    await waitFor(() => order.includes("exited"));
  });

  test("a host that exits at startup rejects spawn with what it printed", async () => {
    await expect(spawnFake({ firstPrompt: "hi" }, { FAKE_AGY_UNAUTH: "1" })).rejects.toThrow(/authentication required/);
  });
});

describe("AntigravityDriver turns", () => {
  test("prompt() returns the turn result with the response and usage", async () => {
    const { driver } = await spawnFake();
    const result = await driver.prompt("hello team");
    expect(result.content).toBe("done: hello team\n");
    expect(result.status).toBe("SUCCESS");
    expect(result.isError).toBe(false);
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 20, cache_read_tokens: 40 });
    expect(result.numTurns).toBe(1);
    expect(driver.busy).toBe(false);
    expect(driver.turnsCompleted).toBe(1);
  });

  test("send() resolves once the host reports the prompt as read", async () => {
    const { driver } = await spawnFake();
    await driver.prompt("warm up");
    const turn = driver.waitForTurn();
    expect(await driver.send("ping")).toBe(true);
    expect((await turn).content).toBe("done: ping\n");
  });

  test("a prompt written mid-turn runs as its own turn after the running one and stays busy until then", async () => {
    const { driver } = await spawnFake();
    const first = driver.prompt("SLEEP:600 first task");
    await waitFor(() => driver.busy);
    let secondRead = false;
    const second = driver.send("SLEEP:400 second task", { echoTimeoutMs: Infinity }).then((read) => { secondRead = read; });
    await Bun.sleep(200);
    expect(secondRead).toBe(false);

    expect((await first).content).toBe("done: SLEEP:600 first task\n");
    expect(driver.busy).toBe(true);
    await second;
    expect(secondRead).toBe(true);
    await waitFor(() => !driver.busy);
    expect(driver.turnsCompleted).toBe(2);
  });

  test("a prompt the host rejected with an ERROR result was not read", async () => {
    const { driver } = await spawnFake();
    await driver.prompt("warm up");
    const turn = driver.waitForTurn();
    expect(await driver.send("FAILTURN", { echoTimeoutMs: Infinity })).toBe(false);
    const result = await turn;
    expect(result.isError).toBe(true);
    expect(result.error).toBe("turn rejected");
    expect(driver.busy).toBe(false);

    // the session is still usable and later reads are matched to the right prompt
    const next = driver.waitForTurn();
    expect(await driver.send("after the failure", { echoTimeoutMs: Infinity })).toBe(true);
    expect((await next).content).toBe("done: after the failure\n");
  });

  test("a result that arrives after the exit settles only its own turn, not the prompts queued behind it", async () => {
    const { driver } = await spawnFake();
    const first = driver.send("SLEEP:300 DIEAFTER", { echoTimeoutMs: Infinity });
    const second = driver.send("never started", { echoTimeoutMs: Infinity });
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(driver.alive).toBe(false);
    expect(driver.busy).toBe(false);
    expect(driver.turnsCompleted).toBe(1);
  });

  test("events are forwarded to listeners", async () => {
    const { driver } = await spawnFake();
    const seen: string[] = [];
    driver.onEvent((event) => { seen.push(event.event); });
    await driver.prompt("hello");
    expect(seen).toContain("step_update");
    expect(seen.at(-1)).toBe("result");
  });
});

describe("AntigravityDriver lifecycle", () => {
  test("close() ends stdin and the host exits cleanly", async () => {
    const { driver } = await spawnFake();
    await driver.prompt("warm up");
    const seen: number[] = [];
    driver.onExit((code) => { seen.push(code); });
    expect(await driver.close()).toBe(0);
    expect(seen).toEqual([0]);
    expect(driver.alive).toBe(false);
  });

  test("a host that dies before reading makes send() resolve false, not true", async () => {
    const { driver } = await spawnFake({}, { FAKE_AGY_CRASH: "after-init" });
    expect(await driver.send("never read")).toBe(false);
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
    const { driver } = await spawnFake({}, { FAKE_AGY_CRASH: "mid-turn" });
    const seen: number[] = [];
    driver.onExit((code) => { seen.push(code); });
    await expect(driver.prompt("SLEEP:200 will crash")).rejects.toThrow(/exited/);
    expect(seen).toEqual([3]);
    expect(driver.alive).toBe(false);
    expect(driver.busy).toBe(false);
  });
});
