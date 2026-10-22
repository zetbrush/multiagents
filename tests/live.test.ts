/**
 * Live activity: the block an agent is writing right now, from each CLI's stream.
 */
import { describe, test, expect } from "bun:test";
import { LiveTracker } from "../orchestrator/live.ts";
import type { LiveActivity } from "../shared/types.ts";

function fakeBroker() {
  const sent: LiveActivity[] = [];
  return { sent, client: { setLiveActivity: async (req: { live: LiveActivity }) => { sent.push(req.live); return { ok: true }; } } as any };
}

describe("LiveTracker", () => {
  test("Claude: thinking streams in, then a tool step, then the turn ends", async () => {
    const { sent, client } = fakeBroker();
    let busy = true;
    const t = new LiveTracker("s", 1, client, () => busy);
    t.claude({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "thinking" } } });
    t.claude({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Check the " } } });
    t.claude({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "tests first" } } });
    expect(t.state).toMatchObject({ busy: true, phase: "thinking", text: "Check the tests first" });

    t.claude({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }] } });
    expect(t.state).toMatchObject({ phase: "tool", tool: "$ bun test", text: "" });
    t.claude({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } });
    expect(t.state.phase).toBe("waiting");

    await Bun.sleep(800);
    expect(sent.at(-1)).toMatchObject({ busy: true, phase: "waiting" });
    busy = false;
    t.claude({ type: "result" });
    expect(t.state.busy).toBe(false);
    expect(sent.at(-1)!.busy).toBe(false);
    t.dispose();
  });

  test("Codex: reasoning summary and message deltas", () => {
    const { client } = fakeBroker();
    const t = new LiveTracker("s", 2, client);
    t.codex("turn/started", {});
    t.codex("item/started", { item: { type: "reasoning" } });
    t.codex("item/reasoning/summaryTextDelta", { delta: "Plan: " });
    t.codex("item/reasoning/summaryTextDelta", { delta: "read the spec" });
    expect(t.state).toMatchObject({ busy: true, phase: "thinking", text: "Plan: read the spec" });
    t.codex("item/started", { item: { type: "commandExecution", command: "ls -la" } });
    expect(t.state).toMatchObject({ phase: "tool", tool: "$ ls -la" });
    t.codex("item/agentMessage/delta", { delta: "Done" });
    expect(t.state).toMatchObject({ phase: "writing", text: "Done" });
    t.codex("turn/completed", {});
    expect(t.state.busy).toBe(false);
    t.dispose();
  });

  test("Gemini: a run is busy from init to result", () => {
    const { client } = fakeBroker();
    const t = new LiveTracker("s", 3, client);
    t.gemini({ type: "init" });
    t.gemini({ type: "tool_use", tool_name: "read_file", parameters: { file_path: "a.ts" } });
    expect(t.state).toMatchObject({ busy: true, phase: "tool" });
    t.gemini({ type: "message", role: "assistant", delta: true, content: "Hi" });
    expect(t.state).toMatchObject({ phase: "writing", text: "Hi" });
    t.gemini({ type: "result" });
    expect(t.state.busy).toBe(false);
    t.dispose();
  });

  test("long text keeps its tail", () => {
    const { client } = fakeBroker();
    const t = new LiveTracker("s", 4, client);
    t.claude({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } });
    t.claude({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "x".repeat(7000) + "END" } } });
    expect(t.state.text.length).toBe(6000);
    expect(t.state.text.endsWith("END")).toBe(true);
    t.dispose();
  });
});
