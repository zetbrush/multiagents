// ============================================================================
// multiagents — Agent driver for OpenAI-compatible APIs ("Other" agents)
// ============================================================================
// Runs an agent on any chat-completions API (DeepSeek, Qwen, Kimi, GLM,
// OpenRouter, Ollama…) with the same reach as the CLI agents:
//   - team tools: the multiagents-peer MCP server is spawned in driver mode and
//     its tools are offered to the model (send_message, signal_done, …);
//   - local tools: Read, Write, Edit, LS, Glob, Grep, Bash, WebFetch, confined
//     to the project directory;
//   - one long conversation; messages that arrive mid-turn are read before the
//     next model call, like Claude reading queued input at a tool boundary.
// It emits Claude's stream-json events (system/init, stream_event deltas,
// assistant blocks, tool results, result with usage and cost), so activity,
// live view, token accounting and approvals reuse the Claude paths, and it
// asks for tool approval the way the Claude CLI does for its permission modes.
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "../shared/utils.ts";
import { authHeaders, type ApiProvider } from "../shared/providers.ts";
import type {
  ClaudeEvent, ClaudeEventListener, ClaudePermissionDecision, ClaudePermissionHandler, ClaudeSession, PipedSubprocess,
} from "./claude-driver.ts";

const LOG_PREFIX = "api-driver";
const TEAM_SERVER = "multiagents-peer";
const MAX_STEPS_PER_TURN = 60;
const DEFAULT_CONTEXT_TOKENS = 64_000;
const TOOL_OUTPUT_MAX = 30_000;
const COMMAND_TIMEOUT_MS = 120_000;

export interface ApiDriverOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  provider: ApiProvider;
  model: string;
  effort?: string;
  /** The team-tools MCP server to run (as for Claude: --driver-mode) */
  mcpServer: { command: string; args: string[]; env?: Record<string, string> };
  systemPrompt: string;
  firstPrompt: string;
  /** Claude permission mode names: bypassPermissions | acceptEdits | default | auto | plan */
  permissionMode?: string;
  /** Overrides fetch (tests) */
  fetch?: typeof fetch;
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; reasoning_content?: string }
  | { role: "tool"; tool_call_id: string; content: string };

interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
interface McpTool { name: string; description?: string; inputSchema?: Record<string, unknown> }

// --- Local tools (Claude's names, so describeTool and the Q&A rules apply) ---

const LOCAL_TOOLS = [
  { name: "Read", description: "Read a text file of the project. Returns numbered lines.", parameters: { type: "object", properties: { file_path: { type: "string", description: "Path relative to the project (or absolute inside it)" }, offset: { type: "integer", description: "First line (1-based)" }, limit: { type: "integer", description: "Number of lines" } }, required: ["file_path"] } },
  { name: "Write", description: "Create or overwrite a file in the project with the given content.", parameters: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } },
  { name: "Edit", description: "Replace exact text in a file. old_string must occur once unless replace_all is true.", parameters: { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["file_path", "old_string", "new_string"] } },
  { name: "LS", description: "List a directory of the project.", parameters: { type: "object", properties: { path: { type: "string", description: "Directory, default the project root" } } } },
  { name: "Glob", description: "Find files by glob pattern, e.g. src/**/*.ts", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } },
  { name: "Grep", description: "Search file contents with a regular expression. Returns matching lines with file and line number.", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string", description: "Only files matching this glob" } }, required: ["pattern"] } },
  { name: "Bash", description: "Run a shell command in the project directory (2 minute timeout). Returns exit code and output.", parameters: { type: "object", properties: { command: { type: "string" }, timeout_ms: { type: "integer" } }, required: ["command"] } },
  { name: "WebFetch", description: "Fetch a web page or URL and return its text.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
] as const;

const READ_ONLY = new Set(["Read", "LS", "Glob", "Grep", "WebFetch"]);
const EDITS = new Set(["Write", "Edit"]);

/** Whether a permission mode asks before this tool runs (the Claude CLI's rules). */
export function needsApproval(mode: string, tool: string): boolean {
  if (READ_ONLY.has(tool) || tool.startsWith(`mcp__${TEAM_SERVER}__`)) return false;
  if (mode === "bypassPermissions") return false;
  if ((mode === "acceptEdits" || mode === "auto") && EDITS.has(tool)) return false;
  return true;
}

export class ApiDriver implements ClaudeSession {
  private proc: PipedSubprocess;
  private opts: ApiDriverOptions;
  private fetchFn: typeof fetch;
  private root: string;
  private messages: ChatMessage[] = [];
  private queue: Array<{ text: string; settle: (read: boolean) => void }> = [];
  private listeners: ClaudeEventListener[] = [];
  private history: ClaudeEvent[] = [];
  private exitCbs: Array<(code: number) => void> = [];
  private permissionHandler: ClaudePermissionHandler | null = null;
  private mcpTools: McpTool[] = [];
  private rpcSeq = 0;
  private rpcWaiters = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private stdoutBuf = "";
  private abort: AbortController | null = null;
  private interrupted = false;
  private _alive = true;
  private _busy = false;
  private _exitCode: number | null = null;
  private _lastActivity = Date.now();
  private _model: string;
  private _mode: string;
  private _sessionId = `api-${randomUUID()}`;
  private totalCost = 0;
  private callSeq = 0;

  get alive(): boolean { return this._alive; }
  get busy(): boolean { return this._busy; }
  get pid(): number { return this.proc.pid; }
  get process(): PipedSubprocess { return this.proc; }
  get sessionId(): string | null { return this._sessionId; }
  get lastActivity(): number { return this._lastActivity; }
  get model(): string { return this._model; }
  get permissionMode(): string { return this._mode; }

  private constructor(proc: PipedSubprocess, opts: ApiDriverOptions) {
    this.proc = proc;
    this.opts = opts;
    this.fetchFn = opts.fetch ?? fetch;
    this.root = fs.realpathSync(opts.cwd);
    this._model = opts.model;
    this._mode = opts.permissionMode ?? "bypassPermissions";
    this.messages.push({ role: "system", content: opts.systemPrompt });
    void this.readStdout();
    void (async () => { for await (const _ of proc.stderr) { /* the MCP server logs here */ } })().catch(() => {});
    proc.exited.then((code) => {
      this._alive = false;
      this._exitCode = code;
      this.abort?.abort();
      for (const w of this.rpcWaiters.values()) w.reject(new Error(`team tools server exited (code ${code})`));
      this.rpcWaiters.clear();
      for (const q of this.queue.splice(0)) q.settle(false);
      log(LOG_PREFIX, `team tools server exited with code ${code}`);
      for (const cb of this.exitCbs) { try { cb(code); } catch { /* keep going */ } }
    });
  }

  /** Start the team-tools server, connect to it and begin the first turn (in the background). */
  static async spawn(opts: ApiDriverOptions): Promise<ApiDriver> {
    const proc = Bun.spawn([opts.mcpServer.command, ...opts.mcpServer.args], {
      cwd: opts.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...opts.env, ...(opts.mcpServer.env ?? {}) },
    });
    const driver = new ApiDriver(proc, opts);
    try {
      await driver.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "multiagents-api-driver", version: "1.0" } }, 30_000);
      driver.notify("notifications/initialized", {});
      const listed = await driver.rpc("tools/list", {}, 30_000) as { tools?: McpTool[] };
      driver.mcpTools = listed.tools ?? [];
    } catch (err) {
      await driver.kill();
      throw new Error(`Could not start the team tools for the API agent: ${err instanceof Error ? err.message : err}`);
    }
    driver.emit({
      type: "system", subtype: "init", session_id: driver._sessionId, model: opts.model, permissionMode: driver._mode,
      mcp_servers: [{ name: TEAM_SERVER, status: "connected" }], tools: driver.toolSpecs().map((t) => t.function.name),
    });
    log(LOG_PREFIX, `${opts.provider.name} agent ready (model ${opts.model}, ${driver.mcpTools.length} team tools)`);
    void driver.send(opts.firstPrompt, { echoTimeoutMs: Infinity });
    return driver;
  }

  // --- ClaudeSession ---

  onExit(cb: (code: number) => void): void {
    if (this._exitCode !== null) { const code = this._exitCode; queueMicrotask(() => cb(code)); return; }
    this.exitCbs.push(cb);
  }

  onEvent(cb: ClaudeEventListener, opts: { replay?: boolean } = {}): void {
    if (opts.replay) for (const e of this.history) { try { cb(e); } catch { /* keep going */ } }
    this.listeners.push(cb);
  }

  onPermissionRequest(handler: ClaudePermissionHandler): void { this.permissionHandler = handler; }

  send(text: string, _opts: { echoTimeoutMs?: number } = {}): Promise<boolean> {
    if (!this._alive) return Promise.resolve(false);
    this._lastActivity = Date.now();
    const read = new Promise<boolean>((settle) => this.queue.push({ text, settle }));
    if (!this._busy) void this.runTurn();
    return read;
  }

  async interrupt(): Promise<void> {
    if (!this._busy) return;
    this.interrupted = true;
    this.abort?.abort();
  }

  async setModel(model: string | undefined): Promise<void> {
    this._model = model || this.opts.provider.default_model || this._model;
  }

  async setPermissionMode(mode: string): Promise<void> {
    this._mode = mode === "manual" ? "default" : mode;
  }

  async close(timeoutMs = 5_000): Promise<number> {
    if (!this._alive) return this._exitCode ?? -1;
    await this.interrupt();
    try { this.proc.stdin.end(); } catch { /* closed */ }
    const code = await Promise.race([this.proc.exited, Bun.sleep(timeoutMs).then(() => null)]);
    if (code !== null) return code;
    await this.kill();
    return this.proc.exited;
  }

  async kill(): Promise<void> {
    this.abort?.abort();
    if (!this._alive) return;
    try { this.proc.kill("SIGTERM"); } catch { /* gone */ }
    const exited = await Promise.race([this.proc.exited, Bun.sleep(3_000).then(() => null)]);
    if (exited === null) { try { this.proc.kill("SIGKILL"); } catch { /* gone */ } }
  }

  // --- The agent loop ---

  private async runTurn(): Promise<void> {
    if (this._busy || !this._alive) return;
    this._busy = true;
    this.interrupted = false;
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    let finalText = "";
    let error: string | null = null;
    let steps = 0;
    try {
      while (this._alive && !this.interrupted && steps++ < MAX_STEPS_PER_TURN) {
        this.takeQueued();
        this.trimContext();
        const reply = await this.complete(usage);
        if (this.interrupted) break;
        this.messages.push({ role: "assistant", content: reply.text || null, ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}) });
        if (reply.text) finalText = reply.text;
        if (!reply.toolCalls.length) {
          // Messages that came in while it answered start the next step of the same turn
          if (this.queue.length) continue;
          break;
        }
        for (const call of reply.toolCalls) {
          if (this.interrupted) break;
          const output = await this.runToolCall(call);
          this.messages.push({ role: "tool", tool_call_id: call.id, content: output.text });
          this.emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: output.text, is_error: output.isError }] } });
        }
      }
      if (steps > MAX_STEPS_PER_TURN) error = `stopped after ${MAX_STEPS_PER_TURN} steps in one turn`;
    } catch (err) {
      if (!this.interrupted) error = err instanceof Error ? err.message : String(err);
    } finally {
      // A tool call without its result would make the next request invalid
      this.closeOpenToolCalls();
      this._busy = false;
      this._lastActivity = Date.now();
      const subtype = this.interrupted ? "error_during_execution" : error ? "error_api" : "success";
      if (error) log(LOG_PREFIX, `turn ended with an error: ${error}`);
      this.emit({
        type: "result", subtype, is_error: subtype !== "success", session_id: this._sessionId,
        result: error ?? finalText, usage, total_cost_usd: this.totalCost,
        ...(error ? { errors: [error] } : {}),
      });
      this.interrupted = false;
      if (this.queue.length && this._alive) void this.runTurn();
    }
  }

  /** Queued messages join the conversation now (the model reads them next). */
  private takeQueued(): void {
    if (!this.queue.length) return;
    const items = this.queue.splice(0);
    const text = items.map((q) => q.text).join("\n\n---\n\n");
    this.messages.push({ role: "user", content: text });
    this.emit({ type: "user", isReplay: true, message: { role: "user", content: text } });
    for (const q of items) q.settle(true);
  }

  private closeOpenToolCalls(): void {
    const answered = new Set(this.messages.filter((m) => m.role === "tool").map((m) => (m as { tool_call_id: string }).tool_call_id));
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!;
      if (m.role !== "assistant" || !m.tool_calls) continue;
      const missing = m.tool_calls.filter((c) => !answered.has(c.id));
      if (!missing.length) break;
      this.messages.push(...missing.map((c) => ({ role: "tool" as const, tool_call_id: c.id, content: "Interrupted before it ran." })));
      break;
    }
  }

  /** Keep the conversation inside the context window: drop the oldest exchanges first. */
  private trimContext(): void {
    const limit = (this.opts.provider.context_tokens ?? DEFAULT_CONTEXT_TOKENS) * 0.75;
    const size = () => this.messages.reduce((n, m) => n + JSON.stringify(m).length / 3, 0);
    let trimmed = false;
    while (size() > limit && this.messages.length > 4) {
      // messages[0] is the system prompt; drop the next exchange (an assistant call and its results go together)
      const first = this.messages[1]!;
      this.messages.splice(1, 1);
      if (first.role === "assistant" && first.tool_calls) {
        while (this.messages[1]?.role === "tool") this.messages.splice(1, 1);
      }
      while (this.messages[1]?.role === "tool") this.messages.splice(1, 1);
      trimmed = true;
    }
    if (trimmed && !(this.messages[1]?.role === "user" && String(this.messages[1].content).startsWith("[Earlier conversation"))) {
      this.messages.splice(1, 0, { role: "user", content: "[Earlier conversation was trimmed to fit the context window. Use get_history / get_plan / check_team_status if you need it again.]" });
    }
  }

  /** One streamed chat completion; text and reasoning arrive as deltas. */
  private async complete(usage: { input_tokens: number; output_tokens: number }): Promise<{ text: string; toolCalls: ToolCall[] }> {
    const p = this.opts.provider;
    const body: Record<string, unknown> = {
      ...(p.extra_body ?? {}),
      model: this._model,
      messages: this.messages,
      tools: this.toolSpecs(),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (this.opts.effort) body.reasoning_effort = this.opts.effort;

    let res: Response | null = null;
    for (let attempt = 0; ; attempt++) {
      this.abort = new AbortController();
      res = await this.fetchFn(`${p.base_url}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(p) },
        body: JSON.stringify(body),
        signal: this.abort.signal,
      });
      if (res.ok) break;
      const detail = (await res.text().catch(() => "")).slice(0, 500);
      // Some servers reject stream_options; retry once without it
      if (res.status === 400 && attempt === 0 && /stream_options/i.test(detail)) { delete body.stream_options; continue; }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) { await Bun.sleep(2_000 * 2 ** attempt); continue; }
      throw new Error(`${p.name}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }

    const msgId = `msg_${++this.callSeq}`;
    let text = "", thinking = "";
    let block: "thinking" | "text" | null = null;
    let index = -1;
    const calls = new Map<number, ToolCall>();
    let callUsage: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null = null;
    const startBlock = (kind: "thinking" | "text") => {
      if (block === kind) return;
      if (block) this.emit({ type: "stream_event", event: { type: "content_block_stop", index } });
      block = kind;
      index++;
      this.emit({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: kind, [kind]: "" } } });
    };

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let chunk: any;
        try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk.error) throw new Error(`${p.name}: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
        if (chunk.usage) callUsage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta ?? {};
        this._lastActivity = Date.now();
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === "string" && reasoning) {
          startBlock("thinking");
          thinking += reasoning;
          this.emit({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: reasoning } } });
        }
        if (typeof delta.content === "string" && delta.content) {
          startBlock("text");
          text += delta.content;
          this.emit({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "text_delta", text: delta.content } } });
        }
        for (const tc of delta.tool_calls ?? []) {
          const i = typeof tc.index === "number" ? tc.index : calls.size;
          const call = calls.get(i) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
          if (tc.id) call.id = tc.id;
          if (tc.function?.name) call.function.name += tc.function.name;
          if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
          calls.set(i, call);
        }
      }
    }
    if (block) this.emit({ type: "stream_event", event: { type: "content_block_stop", index } });

    const toolCalls = [...calls.values()].filter((c) => c.function.name).map((c, i) => ({ ...c, id: c.id || `call_${this.callSeq}_${i}` }));
    const input = callUsage?.prompt_tokens ?? 0;
    const output = callUsage?.completion_tokens ?? 0;
    usage.input_tokens += input;
    usage.output_tokens += output;
    if (p.input_price || p.output_price) this.totalCost += (input * (p.input_price ?? 0) + output * (p.output_price ?? 0)) / 1e6;

    // The whole call as one assistant event (timeline blocks; input tokens are metered per call)
    const content: Array<Record<string, unknown>> = [];
    if (thinking) content.push({ type: "thinking", thinking });
    if (text) content.push({ type: "text", text });
    for (const c of toolCalls) content.push({ type: "tool_use", id: c.id, name: this.eventToolName(c.function.name), input: parseArgs(c.function.arguments) });
    this.emit({
      type: "assistant",
      message: { id: msgId, role: "assistant", model: this._model, content, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: callUsage?.prompt_tokens_details?.cached_tokens ?? 0 } },
    });
    return { text, toolCalls };
  }

  /** Team tools carry their MCP name in events, so isTeamTool / describeTool know them. */
  private eventToolName(name: string): string {
    return this.mcpTools.some((t) => t.name === name) ? `mcp__${TEAM_SERVER}__${name}` : name;
  }

  private toolSpecs(): Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }> {
    const team = this.mcpTools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: (t.description ?? "").slice(0, 1000), parameters: t.inputSchema ?? { type: "object", properties: {} } },
    }));
    const local = LOCAL_TOOLS.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
    return [...local, ...team];
  }

  private async runToolCall(call: ToolCall): Promise<{ text: string; isError: boolean }> {
    const name = call.function.name;
    const input = parseArgs(call.function.arguments);
    if (input === null) return { text: "The arguments were not valid JSON. Call the tool again with a JSON object.", isError: true };
    const eventName = this.eventToolName(name);
    if (needsApproval(this._mode, eventName)) {
      const decision = await this.askPermission(eventName, input, call.id);
      if (decision.behavior === "deny") return { text: `denied: ${decision.message}`, isError: true };
      if (decision.updatedInput) Object.assign(input, decision.updatedInput);
    } else if (this._mode === "plan" && !READ_ONLY.has(name) && !eventName.startsWith("mcp__")) {
      return { text: "Plan mode: only reading is allowed.", isError: true };
    }
    try {
      if (this.mcpTools.some((t) => t.name === name)) return await this.callTeamTool(name, input);
      return await this.runLocalTool(name, input);
    } catch (err) {
      return { text: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }

  private async askPermission(toolName: string, input: Record<string, unknown>, toolUseId: string): Promise<ClaudePermissionDecision> {
    for (let waited = 0; !this.permissionHandler && this._alive && waited < 30_000; waited += 100) await Bun.sleep(100);
    if (!this.permissionHandler) return { behavior: "deny", message: "No approver is connected to this agent." };
    try {
      return await this.permissionHandler({ toolName, input, toolUseId });
    } catch (err) {
      return { behavior: "deny", message: `Approval failed: ${err instanceof Error ? err.message : err}` };
    }
  }

  private async callTeamTool(name: string, input: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const result = await this.rpc("tools/call", { name, arguments: input }, 120_000) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    const text = (result.content ?? []).map((c) => c.text ?? "").join("\n") || "(no output)";
    return { text: clip(text), isError: result.isError === true };
  }

  // --- Local tools, inside the project ---

  private resolve(p: unknown, mustExist = true): string {
    if (typeof p !== "string" || !p.trim()) throw new Error("A path is required");
    const abs = path.resolve(this.root, p);
    let real: string;
    try { real = fs.realpathSync(abs); } catch {
      if (mustExist) throw new Error(`${p} does not exist`);
      real = realThroughExistingAncestor(abs);
    }
    if (real !== this.root && !real.startsWith(this.root + path.sep)) throw new Error(`${p} is outside the project directory`);
    return real;
  }

  private async runLocalTool(name: string, input: Record<string, any>): Promise<{ text: string; isError: boolean }> {
    switch (name) {
      case "Read": {
        const file = this.resolve(input.file_path);
        const lines = (await Bun.file(file).text()).split("\n");
        const start = Math.max(1, Number(input.offset) || 1);
        const count = Math.min(2_000, Math.max(1, Number(input.limit) || 2_000));
        const slice = lines.slice(start - 1, start - 1 + count).map((l, i) => `${String(start + i).padStart(6)}\t${l}`);
        const more = lines.length > start - 1 + count ? `\n… ${lines.length - (start - 1 + count)} more lines (use offset)` : "";
        return { text: clip(slice.join("\n") + more), isError: false };
      }
      case "Write": {
        const file = this.resolve(input.file_path, false);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await Bun.write(file, String(input.content ?? ""));
        return { text: `Wrote ${path.relative(this.root, file)}`, isError: false };
      }
      case "Edit": {
        const file = this.resolve(input.file_path);
        const before = await Bun.file(file).text();
        const oldS = String(input.old_string ?? "");
        if (!oldS) throw new Error("old_string is empty");
        const count = before.split(oldS).length - 1;
        if (count === 0) throw new Error("old_string was not found in the file");
        if (count > 1 && !input.replace_all) throw new Error(`old_string occurs ${count} times; add context or set replace_all`);
        const after = input.replace_all ? before.split(oldS).join(String(input.new_string ?? "")) : before.replace(oldS, () => String(input.new_string ?? ""));
        await Bun.write(file, after);
        return { text: `Edited ${path.relative(this.root, file)} (${input.replace_all ? count : 1} replacement${count > 1 && input.replace_all ? "s" : ""})`, isError: false };
      }
      case "LS": {
        const dir = this.resolve(input.path ?? ".");
        const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== ".git").sort((a, b) => a.name.localeCompare(b.name));
        return { text: entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n") || "(empty)", isError: false };
      }
      case "Glob": {
        const base = this.resolve(input.path ?? ".");
        const out: string[] = [];
        for await (const f of new Bun.Glob(String(input.pattern)).scan({ cwd: base, onlyFiles: true })) {
          if (f.startsWith(".git/") || f.includes("/node_modules/") || f.startsWith("node_modules/")) continue;
          out.push(path.relative(this.root, path.join(base, f)));
          if (out.length >= 500) break;
        }
        return { text: out.join("\n") || "No files matched", isError: false };
      }
      case "Grep": {
        const base = this.resolve(input.path ?? ".");
        let re: RegExp;
        try { re = new RegExp(String(input.pattern)); } catch { throw new Error("The pattern is not a valid regular expression"); }
        const glob = new Bun.Glob(String(input.glob ?? "**/*"));
        const stat = fs.statSync(base);
        const files = stat.isFile() ? [base] : [] as string[];
        if (!stat.isFile()) {
          for await (const f of glob.scan({ cwd: base, onlyFiles: true })) {
            if (f.startsWith(".git/") || f.includes("node_modules/")) continue;
            files.push(path.join(base, f));
            if (files.length >= 5_000) break;
          }
        }
        const hits: string[] = [];
        for (const f of files) {
          let text: string;
          try { if (fs.statSync(f).size > 2_000_000) continue; text = await Bun.file(f).text(); } catch { continue; }
          if (text.includes("\u0000")) continue;
          text.split("\n").forEach((line, i) => { if (hits.length < 300 && re.test(line)) hits.push(`${path.relative(this.root, f)}:${i + 1}: ${line.slice(0, 300)}`); });
          if (hits.length >= 300) break;
        }
        return { text: hits.join("\n") || "No matches", isError: false };
      }
      case "Bash": {
        const timeout = Math.min(600_000, Math.max(1_000, Number(input.timeout_ms) || COMMAND_TIMEOUT_MS));
        const shell = process.platform === "win32" ? ["cmd", "/c", String(input.command)] : ["bash", "-c", String(input.command)];
        const child = Bun.spawn(shell, { cwd: this.root, stdout: "pipe", stderr: "pipe", env: this.opts.env });
        const onAbort = () => { try { child.kill(); } catch { /* gone */ } };
        this.abort?.signal.addEventListener("abort", onAbort);
        const timer = setTimeout(onAbort, timeout);
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        clearTimeout(timer);
        this.abort?.signal.removeEventListener("abort", onAbort);
        const out = [stdout, stderr && `[stderr]\n${stderr}`].filter(Boolean).join("\n");
        return { text: clip(`exit ${code}\n${out}`), isError: code !== 0 };
      }
      case "WebFetch": {
        const url = String(input.url ?? "");
        if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) URLs can be fetched");
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { "User-Agent": "multiagents-api-agent" } });
        const type = res.headers.get("content-type") ?? "";
        let text = await res.text();
        if (/html/i.test(type)) text = htmlToText(text);
        return { text: clip(`HTTP ${res.status} ${url}\n\n${text}`), isError: !res.ok };
      }
      default:
        return { text: `Unknown tool ${name}`, isError: true };
    }
  }

  // --- MCP over stdio (newline-delimited JSON-RPC) ---

  private rpc(method: string, params: unknown, timeoutMs: number): Promise<any> {
    if (!this._alive) return Promise.reject(new Error("team tools server is not running"));
    const id = ++this.rpcSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.rpcWaiters.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.rpcWaiters.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void { this.write({ jsonrpc: "2.0", method, params }); }

  private write(msg: unknown): void {
    try { this.proc.stdin.write(JSON.stringify(msg) + "\n"); this.proc.stdin.flush(); } catch { /* exited */ }
  }

  private async readStdout(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stdout) {
      this.stdoutBuf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
        const line = this.stdoutBuf.slice(0, nl).trim();
        this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
          const w = this.rpcWaiters.get(msg.id);
          if (!w) continue;
          this.rpcWaiters.delete(msg.id);
          if (msg.error) w.reject(new Error(msg.error.message ?? "MCP error"));
          else w.resolve(msg.result);
        } else if (msg.id !== undefined && msg.method) {
          // Server-initiated requests (roots, sampling…) are not supported
          this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported" } });
        }
      }
    }
  }

  private emit(event: ClaudeEvent): void {
    this._lastActivity = Date.now();
    if (this.history.length < 500 && event.type !== "stream_event") this.history.push(event);
    for (const l of this.listeners) { try { l(event); } catch { /* listener errors must not break the loop */ } }
  }
}

/**
 * Where a path that does not exist yet would land: the nearest existing
 * ancestor resolved through its symlinks, plus the missing rest. A symlinked
 * directory higher up cannot smuggle a new file out of the project.
 */
export function realThroughExistingAncestor(abs: string): string {
  const missing: string[] = [];
  let dir = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...missing.reverse());
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return abs;
      missing.push(path.basename(dir));
      dir = parent;
    }
  }
}

function parseArgs(raw: string): Record<string, any> | null {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function clip(s: string): string {
  return s.length > TOOL_OUTPUT_MAX ? `${s.slice(0, TOOL_OUTPUT_MAX)}\n… (${s.length - TOOL_OUTPUT_MAX} more characters)` : s;
}

/** Readable text from an HTML page (scripts, styles and tags dropped). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}
