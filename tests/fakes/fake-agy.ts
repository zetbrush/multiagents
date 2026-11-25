#!/usr/bin/env bun
/**
 * Fake `agy --input-format stream-json --output-format stream-json` host.
 *
 * Follows the Antigravity CLI headless-mode reference
 * (https://antigravity.google/docs/cli/headless): one `init` event, then per
 * prompt a `user_input` step, `agent_response` steps and one `result` whose
 * usage and num_turns are cumulative. Prompts run one turn at a time; a prompt
 * written mid-turn waits for the running turn. A "SLEEP:<ms>" marker simulates
 * a long tool step. Argv and all stdin lines go to $FAKE_AGY_LOG.
 *
 * With FAKE_AGY_MCP=1 it also hosts multiagents-peer the way agy 1.5.13 hosts
 * stdio servers: from <cwd>/.agents/mcp_config.json or the global
 * $HOME/.gemini/config/mcp_config.json (a same-named global entry wins), as a
 * direct child that inherits its cwd and environment plus the entry's `env`.
 * FAKE_AGY_MCP_ENV=clean passes only PATH and HOME instead. A
 * "CALLTOOL:<tool>" marker then calls that tool after any sleep.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { McpStdioClient } from "../helpers/mcp-stdio-client.ts";

const logPath = process.env.FAKE_AGY_LOG;
const log = (entry: unknown) => { if (logPath) fs.appendFileSync(logPath, JSON.stringify(entry) + "\n"); };
const out = (msg: unknown) => { process.stdout.write(JSON.stringify(msg) + "\n"); };

const args = process.argv.slice(2);
log({ argv: args, pid: process.pid });

if (args[0] === "--version") {
  console.log("1.9.0-fake");
  process.exit(0);
}

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 };

function fail(error: string, code: number, conversationId = ""): never {
  out({ event: "result", result: { conversation_id: conversationId, status: "ERROR", response: "", error, duration_seconds: 0, num_turns: 0, usage: ZERO_USAGE } });
  process.exit(code);
}

if (process.env.FAKE_AGY_UNAUTH === "1") {
  process.stderr.write("error: authentication required: run `agy` once to sign in\n");
  process.exit(1);
}

const modelIdx = args.indexOf("--model");
const model = modelIdx !== -1 ? args[modelIdx + 1] : undefined;
if (model === "does-not-exist-model") {
  fail(`invalid model selection (--model "${model}" --effort ""): model ${model} is not recognized`, 1);
}

// Like the CLI, an unknown --conversation id is reported on stderr and a new conversation starts.
const knownPath = logPath ? `${logPath}.conversations` : null;
const known = knownPath && fs.existsSync(knownPath) ? fs.readFileSync(knownPath, "utf-8").split("\n").filter(Boolean) : [];
const conversationIdx = args.indexOf("--conversation");
const requested = conversationIdx !== -1 ? args[conversationIdx + 1]! : null;
if (requested && !known.includes(requested)) process.stderr.write(`warning: conversation "${requested}" not found\n`);
const conversationId = requested && known.includes(requested) ? requested : `fake-conv-${Math.random().toString(36).slice(2, 8)}`;
if (knownPath && !known.includes(conversationId)) fs.appendFileSync(knownPath, conversationId + "\n");
const permissionMode = args.includes("--dangerously-skip-permissions") ? "always-proceed" : "request-review";

let initSent = false;
function announceInit(): void {
  if (initSent || process.env.FAKE_AGY_NO_INIT === "1") return;
  initSent = true;
  out({
    event: "init",
    conversation_id: conversationId,
    init: { cwd: process.cwd(), tools: ["ask_permission", "run_command", "write_to_file"], permission_mode: permissionMode, ...(model ? { model } : {}) },
  });
}
if (process.env.FAKE_AGY_INIT !== "on-first-message") announceInit();

const MCP_TOOL_ARGS: Record<string, Record<string, unknown>> = {
  set_summary: { summary: "fake agy at work" },
  signal_done: { summary: "fake agy finished" },
};

function mcpEntry(): { command: string; args?: string[]; env?: Record<string, string> } | null {
  const files = [path.join(process.env.HOME ?? "", ".gemini", "config", "mcp_config.json"), path.join(process.cwd(), ".agents", "mcp_config.json")];
  for (const file of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(file, "utf-8")).mcpServers?.["multiagents-peer"];
      if (entry) return entry;
    } catch { /* missing or empty */ }
  }
  return null;
}

let peer: Promise<McpStdioClient | null> = Promise.resolve(null);
if (process.env.FAKE_AGY_MCP === "1") {
  peer = (async () => {
    const entry = mcpEntry();
    if (!entry) return null;
    const inherited = process.env.FAKE_AGY_MCP_ENV === "clean" ? { PATH: process.env.PATH, HOME: process.env.HOME } : process.env;
    const client = await McpStdioClient.spawn([entry.command, ...(entry.args ?? [])], { cwd: process.cwd(), env: { ...inherited, ...(entry.env ?? {}) } });
    log({ mcp_pid: client.pid });
    return client;
  })().catch((err) => {
    log({ mcp_error: String(err) });
    return null;
  });
  process.on("exit", () => { void peer.then((client) => client?.kill()); });
}

const queue: string[] = [];
let inTurn = false;
let ended = false;
let turns = 0;
let stepIndex = 0;
const total = { ...ZERO_USAGE };

function step(fields: Record<string, unknown>): void {
  out({ event: "step_update", step_update: { conversation_id: conversationId, ...fields } });
}

async function runTurn(text: string): Promise<void> {
  inTurn = true;
  turns++;
  // "FAILTURN" rejects the prompt before the model sees it; "FAILTURN:exit" also ends the session, as the CLI does for bad input.
  const failure = text.match(/FAILTURN(:exit)?/);
  if (failure) {
    out({ event: "result", result: { conversation_id: conversationId, status: "ERROR", response: "", error: "turn rejected", duration_seconds: 0, num_turns: turns, usage: { ...total } } });
    if (failure[1]) process.exit(1);
    inTurn = false;
    void pump();
    return;
  }
  step({ step_index: stepIndex++, state: "DONE", step_type: "user_input" });

  const sleep = text.match(/SLEEP:(\d+)/);
  if (sleep) {
    const toolStep = stepIndex++;
    step({ step_index: toolStep, state: "ACTIVE", step_type: "tool", tool_name: "run_command" });
    await new Promise((r) => setTimeout(r, parseInt(sleep[1]!, 10)));
    step({
      step_index: toolStep, state: "DONE", step_type: "tool", tool_name: "run_command", duration_seconds: parseInt(sleep[1]!, 10) / 1000,
      tool_info: { name: "run_command", parameters: { CommandLine: `sleep ${sleep[1]}` }, output: "ok\r\n" },
    });
  }

  for (const [, tool] of text.matchAll(/CALLTOOL:([a-z_]+)/g)) {
    const client = await peer;
    const toolStep = stepIndex++;
    const output = client ? (await client.callTool(tool!, MCP_TOOL_ARGS[tool!] ?? {})).text : "no MCP server";
    log({ tool, output });
    step({ step_index: toolStep, state: "DONE", step_type: "tool", tool_name: "call_mcp_tool", tool_info: { name: "call_mcp_tool", parameters: { ServerName: "multiagents-peer", ToolName: tool }, output } });
  }

  if (process.env.FAKE_AGY_CRASH === "mid-turn") process.exit(3);

  const response = `done: ${text}`;
  const usage = { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 40, total_tokens: 120 };
  for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += usage[key];
  const responseStep = stepIndex++;
  step({ step_index: responseStep, state: "ACTIVE", step_type: "agent_response", text_delta: response });
  step({ step_index: responseStep, state: "DONE", step_type: "agent_response", text_delta: "\n", duration_seconds: 0.01, usage });
  const result = {
    event: "result",
    result: { conversation_id: conversationId, status: "SUCCESS", response: `${response}\n`, duration_seconds: 0.01 * turns, num_turns: turns, usage: { ...total } },
  };
  // "DIEAFTER": the process is gone before its turn's result leaves the pipe (a child still holds stdout).
  if (text.includes("DIEAFTER")) {
    Bun.spawn(["sh", "-c", 'sleep 0.05; printf \'%s\\n\' "$0"', JSON.stringify(result)], { stdout: "inherit", stderr: "ignore", stdin: "ignore" });
    process.exit(4);
  }
  out(result);
  inTurn = false;
  void pump();
}

async function pump(): Promise<void> {
  if (inTurn) return;
  const next = queue.shift();
  if (next !== undefined) {
    await runTurn(next);
  } else if (ended) {
    process.exit(0);
  }
}

function promptText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    if (content.some((block: any) => block?.type !== "text")) fail("unsupported content block type", 1, conversationId);
    return content.map((block: any) => block.text ?? "").join("");
  }
  return "";
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { fail("invalid JSON line on stdin", 1, conversationId); }
    log({ stdin: msg });
    if (typeof msg.event !== "string") fail("stream input message is missing the event field", 1, conversationId);
    if (msg.event === "control_request" || msg.event === "control_response") fail(`${msg.event} is not supported`, 2, conversationId);
    if (msg.event !== "user") {
      process.stderr.write(`warning: ignoring unsupported stream input message event "${msg.event}"\n`);
      continue;
    }
    announceInit();
    if (process.env.FAKE_AGY_CRASH === "after-init") process.exit(3);
    queue.push(promptText(msg.message));
    void pump();
  }
});
process.stdin.on("end", () => {
  ended = true;
  void pump();
});
