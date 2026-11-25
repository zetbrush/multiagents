/**
 * Monitor event parsing — token accounting from the structured events the
 * drivers and processes emit (shapes as observed on Claude Code 2.1.241 and
 * the codex-cli 0.156.1 app-server schema).
 */

import { test, expect, describe } from "bun:test";
import { processEvent, monitorCodexDriver, monitorAntigravityDriver, clearAllTracking } from "../orchestrator/monitor.ts";
import type { CodexNotification } from "../orchestrator/codex-driver.ts";
import type { AntigravityEvent } from "../orchestrator/antigravity-driver.ts";

function fakeBroker() {
  const updates: Array<Record<string, unknown>> = [];
  const broker = {
    updateSlot: async (u: Record<string, unknown>) => { updates.push(u); return {}; },
    getSlot: async () => ({ task_state: "working" }),
  } as any;
  return { broker, updates };
}

async function untilUpdates(updates: unknown[], count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (updates.length < count) {
    if (Date.now() > deadline) throw new Error(`expected ${count} slot update(s), saw ${updates.length}`);
    await Bun.sleep(5);
  }
}

const tokenUpdates = (updates: Array<Record<string, unknown>>) => updates.filter((u) => u.input_tokens !== undefined);

describe("processEvent — Claude stream-json", () => {
  test("records token usage from the top-level `usage` of a result event", async () => {
    const { broker, updates } = fakeBroker();
    await processEvent({
      type: "result", subtype: "success", is_error: false, num_turns: 3, session_id: "s1",
      result: "All done.",
      usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 7, cache_creation_input_tokens: 500 },
      total_cost_usd: 0.01,
    }, 4242, "session-a", broker, () => {});

    const tokens = updates.find((u) => u.input_tokens !== undefined);
    expect(tokens).toEqual({ id: 4242, input_tokens: 120, output_tokens: 40, cache_read_tokens: 7 });
  });

  test("a result's usage covers only its own turn, so consecutive results add up instead of being diffed", async () => {
    const { broker, updates } = fakeBroker();
    const result = (usage: Record<string, number>) => ({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "s1", result: "ok", usage });
    await processEvent(result({ input_tokens: 10, output_tokens: 404, cache_read_input_tokens: 18678 }), 4244, "session-a", broker, () => {});
    await processEvent(result({ input_tokens: 10, output_tokens: 46, cache_read_input_tokens: 31719 }), 4244, "session-a", broker, () => {});

    expect(tokenUpdates(updates)).toEqual([
      { id: 4244, input_tokens: 10, output_tokens: 404, cache_read_tokens: 18678 },
      { id: 4244, input_tokens: 10, output_tokens: 46, cache_read_tokens: 31719 },
    ]);
  });

  test("input tokens are metered per API call from assistant events; the result settles the output", async () => {
    const { broker, updates } = fakeBroker();
    const assistant = (id: string, block: Record<string, unknown>, usage: Record<string, number>) =>
      ({ type: "assistant", message: { id, role: "assistant", content: [block], usage } });
    const call1 = { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 100 };
    await processEvent(assistant("msg_1", { type: "thinking", thinking: "…" }, call1), 4248, "session-a", broker, () => {});
    await processEvent(assistant("msg_1", { type: "tool_use", id: "t1", name: "Bash", input: {} }, call1), 4248, "session-a", broker, () => {});
    await processEvent(assistant("msg_2", { type: "text", text: "done" }, { input_tokens: 8, output_tokens: 2, cache_read_input_tokens: 200 }), 4248, "session-a", broker, () => {});
    await processEvent({ type: "result", subtype: "success", is_error: false, num_turns: 2, session_id: "s1", result: "done", usage: { input_tokens: 18, output_tokens: 328, cache_read_input_tokens: 300 } }, 4248, "session-a", broker, () => {});

    expect(tokenUpdates(updates)).toEqual([
      { id: 4248, input_tokens: 10, output_tokens: 0, cache_read_tokens: 100 },
      { id: 4248, input_tokens: 8, output_tokens: 0, cache_read_tokens: 200 },
      { id: 4248, input_tokens: 0, output_tokens: 328, cache_read_tokens: 0 },
    ]);
  });

  test("an assistant event that only carries tool calls leaves the summary alone", async () => {
    const { broker, updates } = fakeBroker();
    await processEvent({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } }, 4247, "session-a", broker, () => {});
    expect(updates).toEqual([]);
  });

  test("an assistant text event patches the slot summary without replacing the snapshot", async () => {
    const { broker, updates } = fakeBroker();
    await processEvent({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Writing the parser now." }] } }, 4243, "session-a", broker, () => {});
    const patch = updates.find((u) => u.context_patch !== undefined);
    expect((patch!.context_patch as Record<string, unknown>).last_summary).toBe("Writing the parser now.");
    expect(updates.some((u) => u.context_snapshot !== undefined)).toBe(false);
  });
});

describe("monitorCodexDriver — app-server notifications", () => {
  function fakeDriver() {
    let listener: ((n: CodexNotification) => void) | null = null;
    return {
      driver: { onNotification: (cb: (n: CodexNotification) => void) => { listener = cb; } } as any,
      emit: (method: string, params: Record<string, unknown>) => listener!({ method, params }),
    };
  }

  test("thread/tokenUsage/updated totals are cumulative, so only the increase is recorded", async () => {
    const { broker, updates } = fakeBroker();
    const { driver, emit } = fakeDriver();
    monitorCodexDriver(driver, 4245, "session-a", broker, () => {});
    emit("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 50 } } });
    emit("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 1600, outputTokens: 260, cachedInputTokens: 50 } } });
    await untilUpdates(updates, 2);

    expect(tokenUpdates(updates)).toEqual([
      { id: 4245, input_tokens: 1000, output_tokens: 200, cache_read_tokens: 50 },
      { id: 4245, input_tokens: 600, output_tokens: 60, cache_read_tokens: 0 },
    ]);
  });

  test("an agentMessage item patches the slot summary without replacing the snapshot", async () => {
    const { broker, updates } = fakeBroker();
    const { driver, emit } = fakeDriver();
    monitorCodexDriver(driver, 4246, "session-a", broker, () => {});
    emit("item/completed", { item: { type: "agentMessage", text: "Tests are green." } });
    await untilUpdates(updates, 1);

    const patch = updates.find((u) => u.context_patch !== undefined);
    expect((patch!.context_patch as Record<string, unknown>).last_summary).toBe("Tests are green.");
    expect(updates.some((u) => u.context_snapshot !== undefined)).toBe(false);
  });
});

describe("monitorAntigravityDriver — stream-json events", () => {
  function fakeDriver() {
    let listener: ((e: AntigravityEvent) => void) | null = null;
    return {
      driver: { onEvent: (cb: (e: AntigravityEvent) => void) => { listener = cb; } } as any,
      emit: (event: AntigravityEvent) => listener!(event),
    };
  }
  const result = (numTurns: number, usage: Record<string, number>): AntigravityEvent =>
    ({ event: "result", result: { conversation_id: "c1", status: "SUCCESS", response: "ok\n", num_turns: numTurns, usage } });
  const step = (fields: Record<string, unknown>): AntigravityEvent =>
    ({ event: "step_update", step_update: { conversation_id: "c1", ...fields } });

  test("result usage is cumulative over the session, so only the increase is recorded", async () => {
    const { broker, updates } = fakeBroker();
    const { driver, emit } = fakeDriver();
    monitorAntigravityDriver(driver, 4250, "session-a", broker, () => {});
    emit(result(1, { input_tokens: 30384, output_tokens: 4, cache_read_tokens: 0, thinking_tokens: 0, total_tokens: 30388 }));
    emit(result(2, { input_tokens: 30662, output_tokens: 8, cache_read_tokens: 30214, thinking_tokens: 0, total_tokens: 30670 }));
    await untilUpdates(updates, 2);

    expect(tokenUpdates(updates)).toEqual([
      { id: 4250, input_tokens: 30384, output_tokens: 4, cache_read_tokens: 0 },
      { id: 4250, input_tokens: 278, output_tokens: 4, cache_read_tokens: 30214 },
    ]);
  });

  test("a new process in the same slot counts from zero again", async () => {
    const { broker, updates } = fakeBroker();
    const first = fakeDriver();
    monitorAntigravityDriver(first.driver, 4251, "session-a", broker, () => {});
    first.emit(result(1, { input_tokens: 5000, output_tokens: 900, cache_read_tokens: 100 }));
    await untilUpdates(updates, 1);

    const second = fakeDriver();
    monitorAntigravityDriver(second.driver, 4251, "session-a", broker, () => {});
    second.emit(result(1, { input_tokens: 200, output_tokens: 30, cache_read_tokens: 0 }));
    await untilUpdates(updates, 2);

    expect(tokenUpdates(updates).at(-1)).toEqual({ id: 4251, input_tokens: 200, output_tokens: 30, cache_read_tokens: 0 });
  });

  test("clearing another session's tracking does not make a live session's total count again", async () => {
    const { broker, updates } = fakeBroker();
    const { driver, emit } = fakeDriver();
    monitorAntigravityDriver(driver, 4255, "session-a", broker, () => {});
    emit(result(1, { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 0 }));
    await untilUpdates(updates, 1);
    clearAllTracking();
    emit(result(2, { input_tokens: 1200, output_tokens: 130, cache_read_tokens: 0 }));
    await untilUpdates(updates, 2);

    expect(tokenUpdates(updates).at(-1)).toEqual({ id: 4255, input_tokens: 200, output_tokens: 30, cache_read_tokens: 0 });
  });

  test("a resumed conversation's first turn is counted from its steps, later turns from the growth of the totals", async () => {
    const { broker, updates } = fakeBroker();
    const { driver, emit } = fakeDriver();
    monitorAntigravityDriver(driver, 4252, "session-a", broker, () => {});
    // totals as agy 1.5.13 reports them after --conversation: the earlier turns are included
    emit(step({ step_index: 6, state: "DONE", step_type: "user_input" }));
    emit(step({ step_index: 8, state: "DONE", step_type: "agent_response", text_delta: "\n", usage: { input_tokens: 23115, output_tokens: 46, cache_read_tokens: 0 } }));
    emit(result(3, { input_tokens: 50022, output_tokens: 407, cache_read_tokens: 40885 }));
    emit(step({ step_index: 10, state: "DONE", step_type: "agent_response", usage: { input_tokens: 300, output_tokens: 10, cache_read_tokens: 100 } }));
    emit(result(4, { input_tokens: 50322, output_tokens: 417, cache_read_tokens: 40985 }));
    await untilUpdates(tokenUpdates(updates), 2);

    expect(tokenUpdates(updates)).toEqual([
      { id: 4252, input_tokens: 23115, output_tokens: 46, cache_read_tokens: 0 },
      { id: 4252, input_tokens: 300, output_tokens: 10, cache_read_tokens: 100 },
    ]);
  });

  test("an MCP tool step is summarised by server and tool", async () => {
    const { broker, updates } = fakeBroker();
    const { driver, emit } = fakeDriver();
    monitorAntigravityDriver(driver, 4256, "session-a", broker, () => {});
    emit(step({ step_index: 7, state: "DONE", step_type: "tool", tool_name: "call_mcp_tool", tool_info: { name: "call_mcp_tool", parameters: { Arguments: { summary: "ready" }, ServerName: "multiagents-peer", ToolName: "set_summary" }, output: "ok" } }));
    await untilUpdates(updates, 1);

    const patch = updates.find((u) => u.context_patch !== undefined);
    expect((patch!.context_patch as Record<string, unknown>).last_summary).toBe("MCP: multiagents-peer/set_summary");
  });

  test("response text deltas are joined into the slot summary when the step is done", async () => {
    const { broker, updates } = fakeBroker();
    const { driver, emit } = fakeDriver();
    monitorAntigravityDriver(driver, 4253, "session-a", broker, () => {});
    emit(step({ step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "Tests are " }));
    emit(step({ step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "green.\n" }));
    await untilUpdates(updates, 1);

    const patch = updates.find((u) => u.context_patch !== undefined);
    expect((patch!.context_patch as Record<string, unknown>).last_summary).toBe("Tests are green.");
    expect(updates.some((u) => u.context_snapshot !== undefined)).toBe(false);
  });

  test("a finished tool step is recorded as activity and reported as progress", async () => {
    const { broker, updates } = fakeBroker();
    const { driver, emit } = fakeDriver();
    const events: string[] = [];
    monitorAntigravityDriver(driver, 4254, "session-a", broker, (e) => { events.push(e.type); });
    emit(step({ step_index: 4, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "bun test" }, output: "ok" } }));
    await untilUpdates(updates, 1);

    const patch = updates.find((u) => u.context_patch !== undefined);
    expect((patch!.context_patch as Record<string, unknown>).last_summary).toBe("Running: bun test");
    expect(events).toContain("agent_progress");
  });
});
