// ============================================================================
// multiagents — Antigravity CLI Driver
// ============================================================================
// Runs one long-lived headless Antigravity CLI session
//   agy --input-format stream-json --output-format stream-json ...
// and feeds it prompts over stdin, one JSON object per line:
//   {"event":"user","message":{"content":"..."}}
// Every prompt runs as its own turn; one written while a turn is running waits
// for that turn to finish, so callers hold new prompts back while `busy`.
//
// Events parsed from stdout (one JSON object per line), as documented at
// https://antigravity.google/docs/cli/headless and observed on agy 1.5.13:
//   init                          → conversation id, permission mode; printed
//                                   at startup, before any prompt
//   step_update user_input DONE   → the host read the oldest unread prompt
//                                   (for one written mid-turn: once the
//                                   running turn has ended)
//   step_update (other)           → activity: text deltas, tool steps, usage
//   result                        → turn finished; usage and num_turns are
//                                   cumulative over the conversation
// Closing stdin ends the session after the current turn (exit code 0).
// --conversation with an unknown id prints a warning and starts a new one.
// ============================================================================

import type { Subprocess } from "bun";
import { log } from "../shared/utils.ts";

type PipedSubprocess = Subprocess<"pipe", "pipe", "pipe">;

const LOG_PREFIX = "antigravity-driver";
const STDERR_TAIL_LINES = 5;
const EXIT_DRAIN_MS = 250;
export const EARLY_EVENT_LIMIT = 1000;

export interface AntigravityLaunchOptions {
  model?: string;
  /** Resume a previous conversation instead of starting a fresh one. */
  resumeConversationId?: string;
}

export interface AntigravityDriverOptions extends AntigravityLaunchOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  /** Command to run instead of `agy` (tests use a fake). */
  command?: string[];
  /** How long the session may take to produce its init event. */
  initTimeoutMs?: number;
  /** Sent right after spawning; `spawn` then resolves once the session reports init. */
  firstPrompt?: string;
  /** Runs with the pid before the CLI can start its MCP servers; a returned function runs when the process exits. */
  onSpawn?: (pid: number) => (() => void) | undefined;
}

export interface AntigravityUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
}

export interface AntigravityTurnResult {
  content: string;
  status: string;
  isError: boolean;
  error?: string;
  numTurns: number;
  usage?: AntigravityUsage;
}

export type AntigravityEvent = { event: string; [key: string]: unknown };
export type AntigravityEventListener = (event: AntigravityEvent) => void;

export function buildAntigravityArgs(opts: AntigravityLaunchOptions): string[] {
  const args = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--dangerously-skip-permissions",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.resumeConversationId) args.push("--conversation", opts.resumeConversationId);
  return args;
}

export function antigravityCommand(): string[] {
  const override = process.env.MULTIAGENTS_ANTIGRAVITY_COMMAND?.trim();
  if (override) return override.split(/\s+/);
  return ["agy"];
}

export class AntigravityDriver {
  private proc: PipedSubprocess;
  private readonly initTimeoutMs: number;
  private buffer = "";
  private stderrTail: string[] = [];
  private _alive = true;
  private _initSeen = false;
  private _conversationId: string | null = null;
  private _permissionMode: string | null = null;
  private _openTurns = 0;
  private _turnsCompleted = 0;
  private _lastActivity = Date.now();
  private _lastReadStep: number | null = null;
  private _exitCode: number | null = null;
  private _onExit: Array<(code: number) => void> = [];
  private _listeners: AntigravityEventListener[] = [];
  /** The newest EARLY_EVENT_LIMIT events from before the first listener attached; that listener gets them. */
  private _early: AntigravityEvent[] | null = [];
  private _initWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private _initPromise: Promise<void> | null = null;
  private _turnWaiters: Array<{ resolve: (r: AntigravityTurnResult) => void; reject: (e: Error) => void }> = [];
  /** Prompts written to stdin that the host has not reported as read yet (FIFO). */
  private _unread: Array<(read: boolean) => void> = [];

  get alive(): boolean { return this._alive; }
  get pid(): number { return this.proc.pid; }
  get process(): PipedSubprocess { return this.proc; }
  get conversationId(): string | null { return this._conversationId; }
  get permissionMode(): string | null { return this._permissionMode; }
  /** True while a written prompt has not produced its result event yet. */
  get busy(): boolean { return this._alive && this._openTurns > 0; }
  get turnsCompleted(): number { return this._turnsCompleted; }
  get lastActivity(): number { return this._lastActivity; }
  get exitCode(): number | null { return this._exitCode; }

  private constructor(proc: PipedSubprocess, initTimeoutMs: number) {
    this.proc = proc;
    this.initTimeoutMs = initTimeoutMs;
    const drained = Promise.all([this.readStdout(), this.readStderr()]);
    this.proc.exited.then(async (code) => {
      this._alive = false;
      this._exitCode = code;
      log(LOG_PREFIX, `agy exited with code ${code}`);
      // Events and diagnostics printed right before the exit are still in the pipes;
      // the turn count stays as it is until then so a late result settles only its own prompt.
      await Promise.race([drained, Bun.sleep(EXIT_DRAIN_MS)]);
      this._openTurns = 0;
      const detail = this.stderrTail.length > 0 ? `: ${this.stderrTail.join(" | ")}` : "";
      const err = new Error(`agy exited (code ${code})${this._turnWaiters.length > 0 ? " during a turn" : ""}${detail}`);
      this._initWaiter?.reject(err);
      this._initWaiter = null;
      for (const w of this._turnWaiters.splice(0)) w.reject(err);
      for (const settle of this._unread.splice(0)) settle(false);
      for (const cb of this._onExit.splice(0)) {
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
  onEvent(cb: AntigravityEventListener): void {
    this._listeners.push(cb);
    const early = this._early ?? [];
    this._early = null;
    for (const event of early) this.notify(cb, event);
  }

  private notify(listener: AntigravityEventListener, event: AntigravityEvent): void {
    try { listener(event); } catch { /* listener errors must not break the reader */ }
  }

  /** Spawn the session; with `firstPrompt` this resolves once the session reported init. */
  static async spawn(opts: AntigravityDriverOptions): Promise<AntigravityDriver> {
    const command = opts.command ?? antigravityCommand();
    const proc = Bun.spawn([...command, ...buildAntigravityArgs(opts)], {
      cwd: opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env,
    });
    const driver = new AntigravityDriver(proc, opts.initTimeoutMs ?? 90_000);
    const onExit = opts.onSpawn?.(proc.pid);
    if (onExit) driver.onExit(onExit);
    if (opts.firstPrompt !== undefined) {
      await driver.send(opts.firstPrompt, { awaitEcho: false });
      log(LOG_PREFIX, `Conversation ${driver.conversationId} ready (pid ${proc.pid}, permissions: ${driver.permissionMode ?? "unknown"})`);
    }
    return driver;
  }

  /** One shared wait: every send() issued before init resolves or rejects with it. */
  private waitForInit(): Promise<void> {
    if (this._initSeen) return Promise.resolve();
    if (!this._alive) return Promise.reject(new Error(`agy exited (code ${this._exitCode}) before its init event`));
    this._initPromise ??= new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._initWaiter = null;
        void this.kill();
        reject(new Error(`agy did not emit its init event within ${this.initTimeoutMs}ms`));
      }, this.initTimeoutMs);
      this._initWaiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
    });
    return this._initPromise;
  }

  /**
   * Write a prompt. The first one also waits for the session's init event.
   * Resolves true once the host reported the prompt as read — which for a
   * prompt written mid-turn is when the running turn ends — or false if that
   * did not happen within `echoTimeoutMs` (`Infinity` waits for it or the exit),
   * the host rejected the prompt with a failed result, or it exited first; with
   * `awaitEcho: false` it resolves right after the write. Throws if the process
   * is gone or never initializes.
   */
  async send(text: string, opts: { echoTimeoutMs?: number; awaitEcho?: boolean } = {}): Promise<boolean> {
    if (!this._alive) throw new Error("agy is not alive");

    let settle!: (read: boolean) => void;
    const read = new Promise<boolean>((resolve) => { settle = resolve; });
    this._unread.push(settle);

    this.proc.stdin.write(JSON.stringify({ event: "user", message: { content: text } }) + "\n");
    this.proc.stdin.flush();
    this._openTurns++;
    this._lastActivity = Date.now();

    if (!this._initSeen) await this.waitForInit();

    // A timed-out prompt keeps its place in the queue: reads are matched by order.
    const echoTimeoutMs = opts.echoTimeoutMs ?? 10_000;
    if (Number.isFinite(echoTimeoutMs)) setTimeout(() => settle(false), echoTimeoutMs);
    if (opts.awaitEcho === false) return true;
    return read;
  }

  /** Resolves with the next result event. */
  waitForTurn(timeoutMs = 10 * 60_000): Promise<AntigravityTurnResult> {
    if (!this._alive) return Promise.reject(new Error(`agy exited (code ${this._exitCode})`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._turnWaiters.indexOf(waiter);
        if (idx !== -1) this._turnWaiters.splice(idx, 1);
        reject(new Error(`No result event within ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter = {
        resolve: (r: AntigravityTurnResult) => { clearTimeout(timer); resolve(r); },
        reject: (e: Error) => { clearTimeout(timer); reject(e); },
      };
      this._turnWaiters.push(waiter);
    });
  }

  /** Send a prompt and wait for the next turn to finish. */
  async prompt(text: string, timeoutMs?: number): Promise<AntigravityTurnResult> {
    const result = this.waitForTurn(timeoutMs);
    result.catch(() => { /* surfaced through the awaited promise below */ });
    await this.send(text, { awaitEcho: false });
    return result;
  }

  /** End stdin so the session finishes its current turn and exits; escalates to SIGTERM/SIGKILL. */
  async close(timeoutMs = 15_000): Promise<number> {
    if (!this._alive) return this._exitCode ?? -1;
    try { this.proc.stdin.end(); } catch { /* already closed */ }
    const exited = await Promise.race([this.proc.exited, Bun.sleep(timeoutMs).then(() => null)]);
    if (exited !== null) return exited;
    log(LOG_PREFIX, `agy did not exit ${timeoutMs}ms after stdin closed — sending SIGTERM`);
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

  private noteConversation(id: unknown): void {
    if (typeof id === "string" && id) this._conversationId = id;
  }

  private handleEvent(event: AntigravityEvent): void {
    this._lastActivity = Date.now();
    if (this._early && this._early.push(event) > EARLY_EVENT_LIMIT) this._early.shift();
    for (const listener of this._listeners) this.notify(listener, event);

    switch (event.event) {
      case "init": {
        this.noteConversation(event.conversation_id);
        this._permissionMode = (event.init as { permission_mode?: string } | undefined)?.permission_mode ?? null;
        this._initSeen = true;
        this._initWaiter?.resolve();
        this._initWaiter = null;
        return;
      }
      case "step_update": {
        const step = event.step_update as { conversation_id?: string; step_index?: number; state?: string; step_type?: string } | undefined;
        this.noteConversation(step?.conversation_id);
        if (step?.step_type !== "user_input" || step.state !== "DONE") return;
        if (typeof step.step_index === "number") {
          if (step.step_index === this._lastReadStep) return;
          this._lastReadStep = step.step_index;
        }
        this._unread.shift()?.(true);
        return;
      }
      case "result": {
        const payload = (event.result ?? {}) as {
          conversation_id?: string; status?: string; response?: string; error?: string; num_turns?: number; usage?: AntigravityUsage;
        };
        this.noteConversation(payload.conversation_id);
        this._openTurns = Math.max(0, this._openTurns - 1);
        this._turnsCompleted++;
        const status = payload.status ?? "UNKNOWN";
        // A turn that ended without a user_input step consumed its prompt only if it succeeded.
        while (this._unread.length > this._openTurns) this._unread.shift()!(status === "SUCCESS");
        const result: AntigravityTurnResult = {
          content: typeof payload.response === "string" ? payload.response : "",
          status,
          isError: status !== "SUCCESS",
          error: payload.error,
          numTurns: payload.num_turns ?? 0,
          usage: payload.usage ? {
            input_tokens: payload.usage.input_tokens,
            output_tokens: payload.usage.output_tokens,
            cache_read_tokens: payload.usage.cache_read_tokens,
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
          let event: AntigravityEvent;
          try { event = JSON.parse(trimmed); } catch { continue; }
          if (event && typeof event.event === "string") this.handleEvent(event);
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
    const keep = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      this.stderrTail.push(trimmed.slice(0, 200));
      if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
      if (/error|fatal|denied|authentication/i.test(trimmed)) log(LOG_PREFIX, `stderr: ${trimmed.slice(0, 200)}`);
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) keep(line);
      }
      keep(buf);
    } catch { /* ignore */ }
  }
}
