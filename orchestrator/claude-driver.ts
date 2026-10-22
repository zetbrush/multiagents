// ============================================================================
// multiagents — Claude Code Driver
// ============================================================================
// Runs one long-lived headless Claude Code session
//   claude -p --input-format stream-json --output-format stream-json ...
// and feeds it user messages over stdin. A message written while a turn is
// running is read by Claude in that same turn as soon as the running tool
// call finishes (stream-json default priority), which is the only delivery
// path that reaches a headless session: channel notifications are dropped
// under `-p`.
//
// Events parsed from stdout (one JSON object per line), as observed on
// Claude Code 2.1.241:
//   system/init        → session id, MCP server status; emitted only after
//                        the FIRST user message arrives, so the driver sends
//                        before it waits for init
//   user, isReplay     → echo of a message we sent (--replay-user-messages)
//   assistant          → activity
//   result             → turn finished (usage, cost, subtype)
//   control_request    → the CLI asks the host (subtype can_use_tool: may this
//                        tool call run?); answered with a control_response
//   control_response   → answer to a request the host sent (set_model,
//                        set_permission_mode, interrupt)
// Permission prompts reach the host because the session runs with
// `--permission-prompt-tool stdio`, the Agent SDK's wire protocol.
// Closing stdin ends the session cleanly (exit code 0).
// ============================================================================

import type { Subprocess } from "bun";
import { log } from "../shared/utils.ts";

export type PipedSubprocess = Subprocess<"pipe", "pipe", "pipe">;

const LOG_PREFIX = "claude-driver";

export interface ClaudeLaunchOptions {
  /** Inline MCP config for `--mcp-config` (loaded with `--strict-mcp-config`). */
  mcpConfig: Record<string, unknown>;
  appendSystemPrompt?: string;
  model?: string;
  /** `--effort` level (low, medium, high, xhigh, max). */
  effort?: string;
  /**
   * Launch permission mode. "bypassPermissions" (the default) never asks;
   * "acceptEdits" asks for everything but file edits; "default" asks for every
   * tool. Other modes ("auto", "plan") are set after launch with setPermissionMode.
   */
  permissionMode?: "bypassPermissions" | "acceptEdits" | "default";
  maxTurns?: number;
  /** Resume a previous session instead of starting a fresh one. */
  resumeSessionId?: string;
}

export interface ClaudeDriverOptions extends ClaudeLaunchOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  /** Command to run instead of `claude` (tests use a fake). */
  command?: string[];
  /** How long the first message may take to produce the init event. */
  initTimeoutMs?: number;
  /** Sent right after spawning; `spawn` then resolves once the session reports init. */
  firstPrompt?: string;
}

export interface ClaudeTurnResult {
  content: string;
  subtype: string;
  isError: boolean;
  numTurns: number;
  costUsd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
}

export type ClaudeEvent = { type: string; [key: string]: unknown };
export type ClaudeEventListener = (event: ClaudeEvent) => void;

/**
 * A session that speaks Claude's stream-json dialect: the Claude CLI itself,
 * and the API driver for OpenAI-compatible providers, which emits the same
 * events so the timeline, live view, token accounting and approvals treat
 * both alike.
 */
export interface ClaudeSession {
  readonly alive: boolean;
  readonly busy: boolean;
  readonly pid: number;
  readonly process: PipedSubprocess;
  readonly sessionId: string | null;
  readonly lastActivity: number;
  onExit(cb: (code: number) => void): void;
  onEvent(cb: ClaudeEventListener, opts?: { replay?: boolean }): void;
  onPermissionRequest(handler: ClaudePermissionHandler): void;
  /** Resolves true once the model has read the message, false if the session ended first. */
  send(text: string, opts?: { echoTimeoutMs?: number }): Promise<boolean>;
  interrupt(): Promise<void>;
  setModel(model: string | undefined): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  close(timeoutMs?: number): Promise<number>;
  kill(): Promise<void>;
}

/** A tool call the CLI wants approved (control_request subtype can_use_tool). */
export interface ClaudePermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  /** Suggested rules the CLI would add to "always allow" this call */
  suggestions?: unknown[];
}

export type ClaudePermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; always?: boolean }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type ClaudePermissionHandler = (req: ClaudePermissionRequest) => Promise<ClaudePermissionDecision>;

export function buildClaudeArgs(opts: ClaudeLaunchOptions): string[] {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--replay-user-messages",
    // Thinking and replies stream token by token (stream_event), for the live view
    "--include-partial-messages",
    "--permission-prompt-tool", "stdio",
    ...permissionArgs(opts.permissionMode ?? "bypassPermissions"),
    "--strict-mcp-config",
    "--mcp-config", JSON.stringify(opts.mcpConfig),
  ];
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  return args;
}

/** Bypass skips every check; any other mode keeps bypass available for a later switch to it. */
function permissionArgs(mode: NonNullable<ClaudeLaunchOptions["permissionMode"]>): string[] {
  if (mode === "bypassPermissions") return ["--dangerously-skip-permissions"];
  const args = ["--allow-dangerously-skip-permissions"];
  if (mode === "acceptEdits") args.push("--permission-mode", "acceptEdits");
  return args;
}

function defaultCommand(): string[] {
  const override = process.env.MULTIAGENTS_CLAUDE_COMMAND?.trim();
  if (override) return override.split(/\s+/);
  return ["claude"];
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (block as { text?: string }).text ?? "").join("");
  }
  return "";
}

function hasToolResult(message: unknown): boolean {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) && content.some((block) => (block as { type?: string }).type === "tool_result");
}

export class ClaudeDriver implements ClaudeSession {
  private proc: PipedSubprocess;
  private readonly initTimeoutMs: number;
  private buffer = "";
  private _alive = true;
  private _sessionId: string | null = null;
  private _mcpServers: Array<{ name: string; status: string }> = [];
  private _busy = false;
  private _turnsCompleted = 0;
  private _lastActivity = Date.now();
  private _exitCode: number | null = null;
  private _onExit: Array<(code: number) => void> = [];
  private _listeners: ClaudeEventListener[] = [];
  private _initWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private _turnWaiters: Array<{ resolve: (r: ClaudeTurnResult) => void; reject: (e: Error) => void }> = [];
  /** Texts we wrote to stdin that the host has not echoed back yet (FIFO). */
  private _awaitingEcho: Array<{ text: string; settle: (echoed: boolean) => void }> = [];
  private _permissionHandler: ClaudePermissionHandler | null = null;
  private _controlSeq = 0;
  private _controlWaiters = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private _model: string | null = null;
  /** Events kept for listeners added after spawn (bounded) */
  private _history: ClaudeEvent[] = [];
  private _permissionMode: string;

  get alive(): boolean { return this._alive; }
  get pid(): number { return this.proc.pid; }
  get process(): PipedSubprocess { return this.proc; }
  get sessionId(): string | null { return this._sessionId; }
  get mcpServers(): Array<{ name: string; status: string }> { return this._mcpServers; }
  /** True from the first message of a turn until its result event. */
  get busy(): boolean { return this._busy; }
  get turnsCompleted(): number { return this._turnsCompleted; }
  get lastActivity(): number { return this._lastActivity; }
  get exitCode(): number | null { return this._exitCode; }
  /** Model reported by init or last set with setModel (null until known). */
  get model(): string | null { return this._model; }
  /** Permission mode the session runs under (launch mode or last setPermissionMode). */
  get permissionMode(): string { return this._permissionMode; }

  private constructor(proc: PipedSubprocess, initTimeoutMs: number, permissionMode: string) {
    this.proc = proc;
    this.initTimeoutMs = initTimeoutMs;
    this._permissionMode = permissionMode;
    this.readStdout();
    this.readStderr();
    this.proc.exited.then((code) => {
      this._alive = false;
      this._busy = false;
      this._exitCode = code;
      log(LOG_PREFIX, `claude exited with code ${code}`);
      const err = new Error(`claude exited (code ${code})${this._turnWaiters.length > 0 ? " during a turn" : ""}`);
      this._initWaiter?.reject(err);
      this._initWaiter = null;
      for (const w of this._turnWaiters.splice(0)) w.reject(err);
      for (const e of this._awaitingEcho.splice(0)) e.settle(false);
      for (const w of this._controlWaiters.values()) w.reject(err);
      this._controlWaiters.clear();
      for (const cb of this._onExit) {
        try { cb(code); } catch { /* keep going */ }
      }
    });
  }

  /** Fires with the exit code; a callback registered after the exit fires right away. */
  onExit(cb: (code: number) => void): void {
    if (this._exitCode !== null) {
      const code = this._exitCode;
      queueMicrotask(() => cb(code));
      return;
    }
    this._onExit.push(cb);
  }
  /** With `replay`, the listener first receives the events seen before it was added (the first turn starts at spawn). */
  onEvent(cb: ClaudeEventListener, opts: { replay?: boolean } = {}): void {
    if (opts.replay) for (const e of this._history) { try { cb(e); } catch { /* keep going */ } }
    this._listeners.push(cb);
  }

  /**
   * Who answers the CLI's permission prompts. A prompt that arrives before a
   * handler is set (the first turn runs during spawn) waits for one; without a
   * handler within 30s it is denied.
   */
  onPermissionRequest(handler: ClaudePermissionHandler): void { this._permissionHandler = handler; }

  /** Send a control request to the CLI and wait for its control_response. */
  async control(subtype: string, fields: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<unknown> {
    if (!this._alive) throw new Error("claude is not alive");
    const requestId = `ma_${++this._controlSeq}`;
    const reply = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._controlWaiters.delete(requestId);
        reject(new Error(`No control_response to ${subtype} within ${timeoutMs}ms`));
      }, timeoutMs);
      this._controlWaiters.set(requestId, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
    this.write({ type: "control_request", request_id: requestId, request: { subtype, ...fields } });
    return reply;
  }

  /** Switch the model for the next API call (an alias such as "sonnet", or a full name; undefined = default). */
  async setModel(model: string | undefined): Promise<void> {
    await this.control("set_model", model ? { model } : {});
    this._model = model ?? null;
  }

  /**
   * Switch the permission mode. Newer CLIs call "default" "manual" (and the
   * reverse for older ones), so a rejected name is retried as its alias.
   */
  async setPermissionMode(mode: string): Promise<void> {
    const aliases: Record<string, string> = { default: "manual", manual: "default" };
    try {
      await this.control("set_permission_mode", { mode });
      this._permissionMode = mode;
    } catch (err) {
      const alias = aliases[mode];
      if (!alias) throw err;
      await this.control("set_permission_mode", { mode: alias });
      this._permissionMode = mode;
    }
  }

  /** Stop the running turn (a no-op between turns). */
  async interrupt(): Promise<void> {
    if (!this._busy) return;
    await this.control("interrupt");
  }

  private write(msg: unknown): void {
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
    this.proc.stdin.flush();
  }

  /** Answer a request the CLI sent: tool permissions go to the handler; anything else is refused. */
  private async answerControlRequest(event: ClaudeEvent): Promise<void> {
    const requestId = event.request_id as string | undefined;
    const request = (event.request ?? {}) as Record<string, unknown>;
    if (!requestId) return;
    const respond = (response: Record<string, unknown>) =>
      this._alive && this.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
    if (request.subtype !== "can_use_tool") {
      if (this._alive) this.write({ type: "control_response", response: { subtype: "error", request_id: requestId, error: `${String(request.subtype)} is not supported by multiagents` } });
      return;
    }
    const input = (request.input ?? {}) as Record<string, unknown>;
    for (let waited = 0; !this._permissionHandler && this._alive && waited < 30_000; waited += 100) await Bun.sleep(100);
    let decision: ClaudePermissionDecision = { behavior: "deny", message: "No approver is connected to this agent." };
    if (this._permissionHandler) {
      try {
        decision = await this._permissionHandler({
          toolName: String(request.tool_name ?? "unknown"),
          input,
          toolUseId: request.tool_use_id as string | undefined,
          suggestions: request.permission_suggestions as unknown[] | undefined,
        });
      } catch (err) {
        decision = { behavior: "deny", message: `Approval failed: ${err instanceof Error ? err.message : err}` };
      }
    }
    if (decision.behavior === "allow") {
      const response: Record<string, unknown> = { behavior: "allow", updatedInput: decision.updatedInput ?? input };
      if (decision.always && Array.isArray(request.permission_suggestions)) response.updatedPermissions = request.permission_suggestions;
      respond(response);
    } else {
      respond({ behavior: "deny", message: decision.message, ...(decision.interrupt ? { interrupt: true } : {}) });
    }
  }

  /**
   * Spawn the session. With `firstPrompt`, the prompt is written immediately
   * and this resolves once Claude reports init (it only does so after the
   * first message); without it, init is awaited by the first `send()`.
   */
  static async spawn(opts: ClaudeDriverOptions): Promise<ClaudeDriver> {
    const args = buildClaudeArgs(opts);
    const command = opts.command ?? defaultCommand();
    const proc = Bun.spawn([...command, ...args], {
      cwd: opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env,
    });
    const driver = new ClaudeDriver(proc, opts.initTimeoutMs ?? 90_000, opts.permissionMode ?? "bypassPermissions");
    if (opts.model) driver._model = opts.model;
    if (opts.firstPrompt !== undefined) {
      await driver.send(opts.firstPrompt);
      log(LOG_PREFIX, `Session ${driver.sessionId} ready (pid ${proc.pid}, mcp: ${driver.mcpServers.map((s) => `${s.name}=${s.status}`).join(",") || "none"})`);
    }
    return driver;
  }

  private waitForInit(): Promise<void> {
    if (this._sessionId) return Promise.resolve();
    if (this._initWaiter) return Promise.reject(new Error("init is already being awaited by another send()"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._initWaiter = null;
        void this.kill();
        reject(new Error(`claude did not emit its init event within ${this.initTimeoutMs}ms`));
      }, this.initTimeoutMs);
      this._initWaiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
    });
  }

  /**
   * Write a user message. The first message also waits for the session's init
   * event. Resolves true once the host echoed the message back — Claude echoes
   * it when it reads it, which during a long tool call can be much later — or
   * false if no echo arrived within `echoTimeoutMs` (`Infinity` waits for the
   * echo or the exit) or the host exited first; with `awaitEcho: false` it
   * resolves right after the write. Throws if the process is gone or never
   * initializes.
   */
  async send(text: string, opts: { priority?: "next" | "later" | "now"; echoTimeoutMs?: number; awaitEcho?: boolean } = {}): Promise<boolean> {
    if (!this._alive) throw new Error("claude is not alive");
    const message: Record<string, unknown> = { type: "user", message: { role: "user", content: text } };
    if (opts.priority) message.priority = opts.priority;

    let settle!: (echoed: boolean) => void;
    const echoed = new Promise<boolean>((resolve) => { settle = resolve; });
    const entry = { text, settle };
    this._awaitingEcho.push(entry);

    this.write(message);
    this._busy = true;
    this._lastActivity = Date.now();

    if (!this._sessionId) await this.waitForInit();

    const echoTimeoutMs = opts.echoTimeoutMs ?? 10_000;
    if (Number.isFinite(echoTimeoutMs)) {
      setTimeout(() => {
        const idx = this._awaitingEcho.indexOf(entry);
        if (idx !== -1) {
          this._awaitingEcho.splice(idx, 1);
          settle(false);
        }
      }, echoTimeoutMs);
    }
    if (opts.awaitEcho === false) return true;
    return echoed;
  }

  /** Resolves with the next result event. */
  waitForTurn(timeoutMs = 10 * 60_000): Promise<ClaudeTurnResult> {
    if (!this._alive) return Promise.reject(new Error(`claude exited (code ${this._exitCode})`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._turnWaiters.indexOf(waiter);
        if (idx !== -1) this._turnWaiters.splice(idx, 1);
        reject(new Error(`No result event within ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter = {
        resolve: (r: ClaudeTurnResult) => { clearTimeout(timer); resolve(r); },
        reject: (e: Error) => { clearTimeout(timer); reject(e); },
      };
      this._turnWaiters.push(waiter);
    });
  }

  /** Send a message and wait for the turn it starts (or joins) to finish. */
  async prompt(text: string, timeoutMs?: number): Promise<ClaudeTurnResult> {
    const result = this.waitForTurn(timeoutMs);
    result.catch(() => { /* surfaced through the awaited promise below */ });
    await this.send(text);
    return result;
  }

  /** End stdin so Claude finishes its current turn and exits; escalates to SIGTERM/SIGKILL. */
  async close(timeoutMs = 15_000): Promise<number> {
    if (!this._alive) return this._exitCode ?? -1;
    try { this.proc.stdin.end(); } catch { /* already closed */ }
    const exited = await Promise.race([this.proc.exited, Bun.sleep(timeoutMs).then(() => null)]);
    if (exited !== null) return exited;
    log(LOG_PREFIX, `claude did not exit ${timeoutMs}ms after stdin closed — sending SIGTERM`);
    try { this.proc.kill("SIGTERM"); } catch { /* gone */ }
    const afterTerm = await Promise.race([this.proc.exited, Bun.sleep(3_000).then(() => null)]);
    if (afterTerm !== null) return afterTerm;
    try { this.proc.kill("SIGKILL"); } catch { /* gone */ }
    return this.proc.exited;
  }

  async kill(): Promise<void> {
    if (!this._alive) return;
    try { this.proc.kill("SIGTERM"); } catch { /* already dead */ }
    const exited = await Promise.race([this.proc.exited, Bun.sleep(3_000).then(() => null)]);
    if (exited === null) {
      try { this.proc.kill("SIGKILL"); } catch { /* gone */ }
    }
  }

  // --- stdout events ---

  private handleEvent(event: ClaudeEvent): void {
    this._lastActivity = Date.now();
    // Token deltas are only of interest live; replaying them would crowd out the first turn's steps
    if (this._history.length < 500 && event.type !== "stream_event") this._history.push(event);
    for (const listener of this._listeners) {
      try { listener(event); } catch { /* listener errors must not break the reader */ }
    }

    switch (event.type) {
      case "control_request":
        void this.answerControlRequest(event);
        return;
      case "control_response": {
        const response = (event.response ?? {}) as Record<string, unknown>;
        const waiter = this._controlWaiters.get(response.request_id as string);
        if (!waiter) return;
        this._controlWaiters.delete(response.request_id as string);
        if (response.subtype === "error") waiter.reject(new Error(String(response.error ?? "control request failed")));
        else waiter.resolve(response.response);
        return;
      }
      case "system": {
        if (event.subtype === "init") {
          this._sessionId = (event.session_id as string) ?? null;
          if (typeof event.model === "string") this._model = event.model;
          this._mcpServers = (event.mcp_servers as Array<{ name: string; status: string }>) ?? [];
          this._initWaiter?.resolve();
          this._initWaiter = null;
        }
        return;
      }
      case "user": {
        if (event.isReplay !== true && hasToolResult(event.message)) return;
        const text = textOf(event.message);
        const idx = this._awaitingEcho.findIndex((e) => e.text === text);
        if (idx !== -1) {
          const [entry] = this._awaitingEcho.splice(idx, 1);
          entry!.settle(true);
        }
        return;
      }
      case "result": {
        this._busy = false;
        this._turnsCompleted++;
        const usage = event.usage as ClaudeTurnResult["usage"] | undefined;
        const result: ClaudeTurnResult = {
          content: typeof event.result === "string" ? event.result : "",
          subtype: (event.subtype as string) ?? "unknown",
          isError: event.is_error === true,
          numTurns: (event.num_turns as number) ?? 0,
          costUsd: event.total_cost_usd as number | undefined,
          usage: usage ? {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens,
          } : undefined,
        };
        for (const w of this._turnWaiters.splice(0)) w.resolve(result);
        return;
      }
    }
  }

  private async readStdout(): Promise<void> {
    const decoder = new TextDecoder();
    const reader = this.proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let event: ClaudeEvent;
          try { event = JSON.parse(trimmed); } catch { continue; }
          if (event && typeof event.type === "string") this.handleEvent(event);
        }
      }
    } catch (err) {
      if (this._alive) log(LOG_PREFIX, `stdout reader error: ${err}`);
    }
  }

  private async readStderr(): Promise<void> {
    const decoder = new TextDecoder();
    const reader = this.proc.stderr.getReader();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && /error|fatal|exception/i.test(trimmed)) {
            log(LOG_PREFIX, `stderr: ${trimmed.slice(0, 200)}`);
          }
        }
      }
    } catch { /* ignore */ }
  }
}
