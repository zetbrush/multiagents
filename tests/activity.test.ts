/** The activity timeline's view of each CLI's stream, and the usage-limit verdicts. */

import { test, expect, describe } from "bun:test";
import { claudeActivity, codexActivity, describeTool, geminiActivity, isTeamTool, parseApprovalMode } from "../orchestrator/activity.ts";
import { limitVerdict } from "../orchestrator/supervision.ts";

describe("describeTool", () => {
  test("names the file, command or pattern a call works on", () => {
    expect(describeTool("Edit", { file_path: "src/a.ts" })).toBe("Edit src/a.ts");
    expect(describeTool("Bash", { command: "npm test" })).toBe("$ npm test");
    expect(describeTool("Grep", { pattern: "TODO", path: "src" })).toBe('Grep "TODO" in src');
    expect(describeTool("mcp__multiagents-peer__send_message", {})).toBe("Team: send_message");
    expect(describeTool("mcp__github__create_issue", {})).toBe("github · create_issue");
    expect(isTeamTool("mcp__multiagents-peer__check_messages")).toBe(true);
    expect(isTeamTool("Read")).toBe(false);
  });
});

describe("claudeActivity", () => {
  test("thinking, tool calls and their results become steps", () => {
    const tools = new Map();
    const steps = claudeActivity({
      type: "assistant",
      message: { content: [
        { type: "thinking", thinking: "Check the parser first" },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/parser.ts" } },
      ] },
    }, tools);
    expect(steps.map((s) => [s.kind, s.title])).toEqual([["thinking", "Thinking"], ["tool_call", "Read src/parser.ts"]]);
    const result = claudeActivity({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "export const x" }] }] } }, tools);
    expect(result[0]).toMatchObject({ kind: "tool_result", title: "Result · Read src/parser.ts", detail: "export const x" });
    // Replayed user messages (our own prompts echoed back) are not steps
    expect(claudeActivity({ type: "user", isReplay: true, message: { content: [{ type: "tool_result", tool_use_id: "x" }] } }, tools)).toEqual([]);
    expect(claudeActivity({ type: "result", total_cost_usd: 0.0123, usage: {} }, tools)[0]!.title).toBe("Turn finished · $0.0123 so far");
  });
});

describe("codexActivity", () => {
  test("commands carry their output and exit code; file changes their diffs", () => {
    const [cmd] = codexActivity("item/completed", { item: { type: "commandExecution", command: "npm test", aggregatedOutput: "ok", exitCode: 0 } });
    expect(cmd).toMatchObject({ kind: "command", title: "$ npm test", detail: "ok" });
    const [fc] = codexActivity("item/completed", { item: { type: "fileChange", changes: [{ path: "a.ts", kind: { type: "add" }, diff: "+x" }] } });
    expect(fc).toMatchObject({ kind: "file_change", title: "Created a.ts" });
    expect((fc!.data as any).changes).toEqual([{ path: "a.ts", kind: "add", diff: "+x" }]);
    const [think] = codexActivity("item/completed", { item: { type: "reasoning", summary: ["plan it"], content: [] } });
    expect(think).toMatchObject({ kind: "thinking", detail: "plan it" });
    expect(codexActivity("item/started", { item: { type: "commandExecution" } })).toEqual([]);
  });
});

describe("geminiActivity", () => {
  test("tool calls use the same names as Claude's", () => {
    expect(geminiActivity({ type: "tool_use", tool_name: "read_file", parameters: { file_path: "x.md" }, tool_id: "g1" })[0]).toMatchObject({ kind: "tool_call", title: "Read x.md" });
    expect(geminiActivity({ type: "tool_result", tool_id: "g1", status: "error", output: "nope" })[0]).toMatchObject({ kind: "tool_result", title: "Failed" });
  });
});

describe("approval modes", () => {
  test("unknown values fall back to fully autonomous", () => {
    expect(parseApprovalMode("ask")).toBe("ask");
    expect(parseApprovalMode("whatever")).toBe("bypass");
    expect(parseApprovalMode(undefined)).toBe("bypass");
  });
});

describe("limitVerdict", () => {
  const a = { input_tokens: 800, output_tokens: 300, cost_usd: 0.5 };
  const b = { input_tokens: 100, output_tokens: 0, cost_usd: 0 };
  test("an agent's own limit wins over the per-agent default", () => {
    expect(limitVerdict(a, [a, b], { agent_tokens: 5000 })).toBeNull();
    expect(limitVerdict(a, [a, b], { agent_tokens: 5000 }, 1000)).toMatch(/^token limit reached \(1,100 \/ 1,000\)/);
    expect(limitVerdict(a, [a, b], { agent_tokens: 1000 })).toMatch(/^token limit/);
  });
  test("session limits stop every agent", () => {
    expect(limitVerdict(b, [a, b], { session_tokens: 1200 })).toMatch(/^session token limit reached/);
    expect(limitVerdict(b, [a, b], { session_cost_usd: 0.4 })).toMatch(/^session cost limit/);
    expect(limitVerdict(a, [a, b], { agent_cost_usd: 0.5 })).toMatch(/^cost limit/);
    expect(limitVerdict(a, [a, b], {})).toBeNull();
  });
});
