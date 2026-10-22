#!/usr/bin/env bun
/**
 * Fake `claude -p --input-format stream-json --output-format stream-json` host.
 *
 * Emits the event kinds the ClaudeDriver relies on (system/init, user echo,
 * assistant, result) with the shapes observed from Claude Code 2.1.241.
 * A "SLEEP:<ms>" marker in a prompt simulates a long tool call; messages that
 * arrive during it are absorbed into the same turn, as Claude Code does with
 * default-priority stream-json input. Argv and all stdin lines go to
 * $FAKE_CLAUDE_LOG for assertions.
 *
 * Control protocol (as the Agent SDK speaks it): "TOOL:<name>:<arg>" in a
 * prompt asks the host for permission with a can_use_tool control_request
 * (unless the session bypasses permissions) and runs the tool only if allowed;
 * "THINK:<text>" emits a thinking block. set_model, set_permission_mode and
 * interrupt requests are answered; a mode in $FAKE_CLAUDE_REJECT_MODES is refused.
 */

import * as fs from "node:fs";

const logPath = process.env.FAKE_CLAUDE_LOG;
const log = (entry: unknown) => { if (logPath) fs.appendFileSync(logPath, JSON.stringify(entry) + "\n"); };
const out = (msg: unknown) => { process.stdout.write(JSON.stringify(msg) + "\n"); };

const args = process.argv.slice(2);
log({ argv: args });

const resumeIdx = args.indexOf("--resume");
const sessionId = resumeIdx !== -1 ? args[resumeIdx + 1]! : `fake-session-${Math.random().toString(36).slice(2, 8)}`;
const replay = args.includes("--replay-user-messages");
const partial = args.includes("--include-partial-messages");
const modelIdx = args.indexOf("--model");
let model = modelIdx !== -1 ? args[modelIdx + 1]! : "fake-haiku";
const modeIdx = args.indexOf("--permission-mode");
let permissionMode = args.includes("--dangerously-skip-permissions") ? "bypassPermissions" : modeIdx !== -1 ? args[modeIdx + 1]! : "default";
const rejectedModes = (process.env.FAKE_CLAUDE_REJECT_MODES ?? "").split(",").filter(Boolean);
let controlSeq = 0;
const controlWaiters = new Map<string, (response: any) => void>();
let interrupted = false;
let mcpServers: Array<{ name: string; status: string }> = [];
const mcpIdx = args.indexOf("--mcp-config");
if (mcpIdx !== -1) {
  try {
    const cfg = JSON.parse(args[mcpIdx + 1]!);
    mcpServers = Object.keys(cfg.mcpServers ?? {}).map((name) => ({ name, status: "connected" }));
  } catch { /* ignore */ }
}

// Like the real host, init is only announced once the first user message arrives.
let initSent = false;
function announceInit(): void {
  if (initSent || process.env.FAKE_CLAUDE_NO_INIT === "1") return;
  initSent = true;
  out({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd(), model, permissionMode, tools: ["Bash"], mcp_servers: mcpServers });
}

const queue: any[] = [];
let absorbed: any[] = [];
let inTurn = false;
let ended = false;
let turns = 0;

function contentText(message: any): string {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b: any) => b.text ?? "").join(" ");
  return "";
}

// Like the real host, a message is echoed when it is read: at the start of the
// turn it begins, or at the next tool-call boundary when it arrived mid-turn.
function echo(msg: any): void {
  if (replay) out({ type: "user", message: msg.message, session_id: sessionId, parent_tool_use_id: null, isReplay: true });
}

async function runTurn(msg: any): Promise<void> {
  inTurn = true;
  turns++;
  echo(msg);
  const text = contentText(msg.message);
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `working on: ${text}` }] } });

  const sleep = text.match(/SLEEP:(\d+)/);
  if (sleep) {
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: `sleep ${sleep[1]}` } }] } });
    await new Promise((r) => setTimeout(r, parseInt(sleep[1]!, 10)));
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] } });
    for (const m of absorbed) echo(m);
  }

  const think = text.match(/THINK:([^|]+)/);
  if (think && partial) {
    // Like the real host with --include-partial-messages: the block streams in word by word first
    const stream = (event: unknown) => out({ type: "stream_event", event, session_id: sessionId, parent_tool_use_id: null });
    stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    for (const word of think[1]!.trim().split(/(?<= )/)) {
      stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: word } });
      await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_DELTA_MS ?? 0)));
    }
    stream({ type: "content_block_stop", index: 0 });
  }
  if (think) out({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: think[1]!.trim() }] } });

  for (const m of text.matchAll(/TOOL:(\w+):([^\s|]+)/g)) {
    const [, toolName, arg] = m;
    const toolUseId = `toolu_${toolName}_${turns}`;
    const input = toolName === "Bash" ? { command: arg } : { file_path: arg };
    let allowed = true, reason = "";
    const needsAsk = permissionMode !== "bypassPermissions" && !(permissionMode === "acceptEdits" && /^(Edit|Write)$/.test(toolName!));
    if (needsAsk) {
      const requestId = `cli_${++controlSeq}`;
      const answer = new Promise<any>((resolve) => controlWaiters.set(requestId, resolve));
      out({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: toolName, input, tool_use_id: toolUseId, permission_suggestions: [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" }] } });
      const response = await answer;
      allowed = response?.behavior === "allow";
      reason = response?.message ?? "";
    }
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: toolName, input }] } });
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: allowed ? `ran ${toolName} ${arg}` : `denied: ${reason}`, is_error: !allowed }] } });
    if (interrupted) break;
  }

  if (interrupted) {
    interrupted = false;
    out({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: turns, session_id: sessionId, result: "interrupted", usage: { input_tokens: 0, output_tokens: 0 } });
    inTurn = false;
    void pump();
    return;
  }

  if (process.env.FAKE_CLAUDE_CRASH === "mid-turn") {
    process.exit(3);
  }

  const summary = `done: ${text}${absorbed.length > 0 ? ` | absorbed:${absorbed.map((m) => contentText(m.message)).join("|")}` : ""}`;
  absorbed = [];
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: summary }] } });
  out({
    type: "result", subtype: "success", is_error: false, num_turns: turns, session_id: sessionId,
    total_cost_usd: 0.001 * turns, duration_ms: 10, result: summary,
    usage: { input_tokens: 100 * turns, output_tokens: 20 * turns, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
  inTurn = false;
  void pump();
}

async function pump(): Promise<void> {
  if (inTurn) return;
  const next = queue.shift();
  if (next) {
    await runTurn(next);
  } else if (ended) {
    process.exit(0);
  }
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { continue; }
    log({ stdin: msg });
    if (msg.type === "control_response") {
      const waiter = controlWaiters.get(msg.response?.request_id);
      controlWaiters.delete(msg.response?.request_id);
      waiter?.(msg.response?.response);
      continue;
    }
    if (msg.type === "control_request") {
      const req = msg.request ?? {};
      const ok = (response: unknown = {}) => out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response } });
      const fail = (error: string) => out({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error } });
      if (req.subtype === "set_model") { model = req.model ?? "fake-haiku"; ok(); }
      else if (req.subtype === "set_permission_mode") {
        if (rejectedModes.includes(req.mode)) fail(`Invalid permission mode: ${req.mode}`);
        else { permissionMode = req.mode; ok(); }
      } else if (req.subtype === "interrupt") {
        interrupted = inTurn;
        for (const [id, w] of controlWaiters) { controlWaiters.delete(id); w({ behavior: "deny", message: "interrupted" }); }
        ok();
      } else if (req.subtype === "get_usage") {
        // FAKE_CLAUDE_USAGE=none: a login without claude.ai plan limits (API key)
        const none = process.env.FAKE_CLAUDE_USAGE === "none";
        ok({
          session: { total_cost_usd: 0 },
          subscription_type: none ? null : "max",
          rate_limits_available: !none,
          rate_limits: none ? null : {
            five_hour: { utilization: 42, resets_at: "2030-01-01T05:00:00Z" },
            seven_day: { utilization: 18.5, resets_at: "2030-01-06T00:00:00Z" },
            seven_day_opus: { utilization: 7, resets_at: "2030-01-06T00:00:00Z" },
            seven_day_sonnet: null,
          },
          behaviors: null,
        });
      } else fail(`unsupported ${req.subtype}`);
      continue;
    }
    if (msg.type !== "user") continue;
    announceInit();
    if (process.env.FAKE_CLAUDE_CRASH === "after-init") process.exit(3);
    if (inTurn) {
      absorbed.push(msg);
    } else {
      queue.push(msg);
      void pump();
    }
  }
});
process.stdin.on("end", () => {
  ended = true;
  void pump();
});
