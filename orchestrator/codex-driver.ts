// ============================================================================
// multiagents — Codex App-Server Driver
// ============================================================================
// Manages a long-running `codex app-server` child process and drives Codex
// turns via the app-server v2 JSON-RPC protocol over stdio (shapes verified
// against the schema that `codex app-server generate-json-schema` emits for
// codex-cli 0.156.1).
//
//   thread/start  → creates the thread; carries cwd, sandbox, approvalPolicy,
//                   developerInstructions (turn/start does NOT accept them)
//   turn/start    → returns immediately; progress streams as notifications
//   turn/steer    → appends input to the in-flight turn (needs expectedTurnId)
//   turn/interrupt→ ends the turn with status "interrupted"
//
// Notifications used: turn/started, turn/completed (turn.status, turn.error),
// item/started, item/completed, item/agentMessage/delta,
// thread/tokenUsage/updated (the only source of token usage),
// thread/status/changed (idle/active + waitingOnApproval/waitingOnUserInput).
// ============================================================================

import type { Subprocess } from "bun";
import { log } from "../shared/utils.ts";

/** Subprocess type with all stdio set to "pipe". */
type PipedSubprocess = Subprocess<"pipe", "pipe", "pipe">;

const LOG_PREFIX = "codex-driver";

export type CodexTurnStatus = "completed" | "interrupted";

/** Result from a Codex turn. */
export interface CodexTurnResult {
  threadId: string;
  content: string;
  status: CodexTurnStatus;
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
}

/** Notification event from the app-server. */
export interface CodexNotification {
  method: string;
  threadId?: string;
  turnId?: string;
  params: Record<string, unknown>;
}

/** Callback type for notification listeners. */
export type NotificationListener = (notification: CodexNotification) => void;

/** Options for starting a new Codex session. */
export interface CodexSessionOptions {
  prompt: string;
  cwd?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  baseInstructions?: string;
  developerInstructions?: string;
  model?: string;
}

/** Turn settings that can change between turns. */
export interface CodexTurnSettings {
  /** never | on-request | on-failure | untrusted */
  approvalPolicy: string;
  model?: string;
  /** Reasoning effort: minimal | low | medium | high */
  effort?: string;
  /** Overrides the thread's sandbox for the next turns (Q&A mode: read-only) */
  sandbox?: "read-only";
}

/** A command or file change waiting for approval (item/*\/requestApproval). */
export interface CodexApprovalRequest {
  kind: "command" | "fileChange" | "permissions";
  method: string;
  params: Record<string, unknown>;
}

export type CodexApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export type CodexApprovalHandler = (req: CodexApprovalRequest) => Promise<CodexApprovalDecision>;

export interface CodexSpawnOptions {
  /** Command to run instead of `codex app-server` (tests use a fake). */
  command?: string[];
  /** Handshake timeout. */
  timeoutMs?: number;
}

type TokenUsageBreakdown = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
};

/** Convert a simplified sandbox string to the app-server's turn-level sandboxPolicy object. */
function sandboxPolicyObject(sandbox: string, cwd?: string): Record<string, unknown> {
  switch (sandbox) {
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "read-only":
      return { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: cwd ? [cwd] : [],
        readOnlyAccess: { type: "fullAccess" },
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    default:
      return { type: sandbox };
  }
}

function defaultCommand(): string[] {
  const override = process.env.MULTIAGENTS_CODEX_COMMAND?.trim();
  if (override) return override.split(/\s+/);
  return ["codex", "app-server"];
}

/**
 * Drives a `codex app-server` child process via JSON-RPC over stdio.
 *
 * Lifecycle:
 *   1. CodexDriver.spawn(cwd, env) — starts server, does handshake
 *   2. driver.startSession({prompt, ...}) — creates a thread, runs first turn
 *   3. driver.reply(threadId, message) — starts a new turn on the thread
 *   4. driver.steer(threadId, text) — injects content mid-turn
 *   5. driver.kill() — shutdown
 */
export class CodexDriver {
  private proc: PipedSubprocess;
  private nextId = 1;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private buffer = "";
  private _threadId: string | null = null;
  private _activeTurnId: string | null = null;
  private _alive = true;
  private _exitCode: number | null = null;
  private _onExitCallbacks: Array<(code: number) => void> = [];
  private _notificationListeners: NotificationListener[] = [];
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _lastActivity = Date.now();
  /** Tracks last notification activity (item/completed, turn events).
   *  Unlike _lastActivity, this is NOT updated by heartbeat responses. */
  private _lastNotificationActivity = Date.now();
  private _approvalsReviewer: string | null = null;
  private _approvalHandler: CodexApprovalHandler | null = null;
  /** Applied to every thread/start, thread/resume and turn/start from now on. */
  settings: CodexTurnSettings = { approvalPolicy: "never" };
  private _threadStatus: string = "notLoaded";
  private _activeFlags: string[] = [];
  private _activeItems = 0;
  /** Per-turn usage from thread/tokenUsage/updated (last = this turn's usage). */
  private _turnUsage = new Map<string, TokenUsageBreakdown>();
  /** Notifications that arrived for a turn before its resolver was registered
   *  (the server may stream them in the same chunk as the turn/start response). */
  private _earlyContent = new Map<string, string[]>();
  private _earlyCompletion = new Map<string, Record<string, unknown>>();

  // Turn completion tracking: when a turn is in flight, we collect content
  // from streaming notifications and resolve when turn/completed fires.
  private _turnResolvers = new Map<string, {
    resolve: (result: CodexTurnResult) => void;
    reject: (error: Error) => void;
    content: string[];
    timer: ReturnType<typeof setTimeout>;
  }>();

  get threadId(): string | null { return this._threadId; }
  get alive(): boolean { return this._alive; }
  get pid(): number { return this.proc.pid; }
  get process(): PipedSubprocess { return this.proc; }
  get lastActivity(): number { return this._lastActivity; }
  /** Last time a notification (item/completed, turn event) was received.
   *  Use this for idle detection — not polluted by heartbeat responses. */
  get lastNotificationActivity(): number { return this._lastNotificationActivity; }
  /** The currently in-flight turn ID, or null if no turn is active. */
  get activeTurnId(): string | null { return this._activeTurnId; }
  /** Who answers approvals, as reported by thread/start ("user" means this driver). */
  get approvalsReviewer(): string | null { return this._approvalsReviewer; }
  /** Latest thread/status/changed type: notLoaded | idle | active | systemError. */
  get threadStatus(): string { return this._threadStatus; }
  /** Active flags from thread/status/changed (waitingOnApproval, waitingOnUserInput). */
  get activeFlags(): string[] { return this._activeFlags; }
  /** Items started but not completed (a running command counts as 1). */
  get activeItems(): number { return this._activeItems; }

  private constructor(proc: PipedSubprocess) {
    this.proc = proc;
    this.startReader();
    this.proc.exited.then((code) => {
      this._alive = false;
      this._exitCode = code;
      this._activeTurnId = null;
      this._activeItems = 0;
      log(LOG_PREFIX, `codex app-server exited with code ${code}`);
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(new Error(`codex app-server exited (code ${code})`));
        this.pendingRequests.delete(id);
      }
      for (const [turnId, resolver] of this._turnResolvers) {
        clearTimeout(resolver.timer);
        resolver.reject(new Error(`codex app-server exited (code ${code}) during turn ${turnId}`));
        this._turnResolvers.delete(turnId);
      }
      for (const cb of this._onExitCallbacks) {
        try { cb(code); } catch { /* don't let one callback break others */ }
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
    this._onExitCallbacks.push(cb);
  }

  /** Who answers approval requests; without one they are accepted for the session. */
  onApprovalRequest(handler: CodexApprovalHandler): void { this._approvalHandler = handler; }

  /** Register a listener for notifications from the app-server. */
  onNotification(cb: NotificationListener): void { this._notificationListeners.push(cb); }

  /**
   * Spawn a new `codex app-server` process and perform the handshake.
   */
  static async spawn(
    cwd: string,
    env: Record<string, string | undefined>,
    opts: CodexSpawnOptions = {},
  ): Promise<CodexDriver> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const proc = Bun.spawn(opts.command ?? defaultCommand(), {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });

    const driver = new CodexDriver(proc);
    driver.readStderr();

    const initResult = await driver.sendRequest("initialize", {
      clientInfo: { name: "multiagents-orchestrator", version: "1.0" },
      capabilities: {},
    }, timeoutMs) as { userAgent?: string };

    try {
      driver.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
      driver.proc.stdin.flush();
    } catch { /* best effort */ }

    log(LOG_PREFIX, `Handshake complete: ${initResult.userAgent ?? "codex app-server"}`);

    driver.startHeartbeat();
    return driver;
  }

  /**
   * Start a new Codex session (thread + first turn).
   * Blocks until the turn completes (can take minutes).
   */
  async startSession(opts: CodexSessionOptions): Promise<CodexTurnResult> {
    log(LOG_PREFIX, `Starting session: ${opts.prompt.slice(0, 100)}...`);

    const threadParams: Record<string, unknown> = { approvalPolicy: this.settings.approvalPolicy };
    if (opts.cwd) threadParams.cwd = opts.cwd;
    if (opts.sandbox) threadParams.sandbox = opts.sandbox;
    if (opts.developerInstructions) threadParams.developerInstructions = opts.developerInstructions;
    if (opts.baseInstructions) threadParams.baseInstructions = opts.baseInstructions;
    if (opts.model) threadParams.model = opts.model;

    const threadResult = await this.sendRequest("thread/start", threadParams, 30_000) as {
      thread?: { id: string };
      approvalsReviewer?: string;
    };
    const threadId = threadResult.thread?.id;
    if (!threadId) throw new Error("thread/start did not return a thread ID");
    this._threadId = threadId;
    this._approvalsReviewer = threadResult.approvalsReviewer ?? null;
    if (this._approvalsReviewer && this._approvalsReviewer !== "user") {
      log(LOG_PREFIX, `Warning: approvals are routed to "${this._approvalsReviewer}", not to this driver`);
    }

    const turnInput: Record<string, unknown> = {
      threadId,
      input: [{ type: "text", text: opts.prompt }],
      approvalPolicy: this.settings.approvalPolicy,
    };
    if (opts.cwd) turnInput.cwd = opts.cwd;
    if (opts.sandbox) turnInput.sandboxPolicy = sandboxPolicyObject(opts.sandbox, opts.cwd);
    if (opts.model) turnInput.model = opts.model;

    const result = await this.startTurnAndWait(threadId, turnInput);
    log(LOG_PREFIX, `Session started: thread=${result.threadId}, content=${result.content.slice(0, 100)}...`);
    return result;
  }

  /**
   * Re-attach to a previous thread (full history preserved) so `reply()` can
   * continue it. Throws if the app-server does not know the thread.
   */
  async resumeSession(opts: { threadId: string } & Omit<CodexSessionOptions, "prompt">): Promise<void> {
    const params: Record<string, unknown> = { threadId: opts.threadId, approvalPolicy: this.settings.approvalPolicy };
    if (opts.cwd) params.cwd = opts.cwd;
    if (opts.sandbox) params.sandbox = opts.sandbox;
    if (opts.developerInstructions) params.developerInstructions = opts.developerInstructions;
    if (opts.baseInstructions) params.baseInstructions = opts.baseInstructions;
    if (opts.model) params.model = opts.model;

    const result = await this.sendRequest("thread/resume", params, 30_000) as {
      thread?: { id: string };
      approvalsReviewer?: string;
    };
    this._threadId = result.thread?.id ?? opts.threadId;
    this._approvalsReviewer = result.approvalsReviewer ?? this._approvalsReviewer;
    log(LOG_PREFIX, `Resumed thread ${this._threadId}`);
  }

  /**
   * Send a new turn to an existing thread.
   */
  async reply(threadId: string, prompt: string): Promise<CodexTurnResult> {
    log(LOG_PREFIX, `Reply to thread ${threadId}: ${prompt.slice(0, 100)}...`);

    const result = await this.startTurnAndWait(threadId, {
      threadId,
      input: [{ type: "text", text: prompt }],
      approvalPolicy: this.settings.approvalPolicy,
    });

    log(LOG_PREFIX, `Reply complete: content=${result.content.slice(0, 100)}...`);
    return result;
  }

  /**
   * Inject content into the active turn. Codex delivers it at the next item
   * boundary (instantly on ≥0.163). Throws if no turn is active or the server
   * rejects the steer (e.g. the turn finished in between).
   */
  async steer(threadId: string, text: string): Promise<void> {
    const turnId = this._activeTurnId;
    if (!turnId) {
      throw new Error("Cannot steer: no active turn");
    }

    log(LOG_PREFIX, `Steering turn ${turnId}: ${text.slice(0, 100)}...`);

    await this.sendRequest("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text }],
    }, 30_000);
  }

  /**
   * Interrupt the active turn. A turn that already finished makes the server
   * answer INVALID_REQUEST, which is not an error for the caller.
   */
  async interrupt(threadId: string): Promise<void> {
    const turnId = this._activeTurnId;
    if (!turnId) return;

    log(LOG_PREFIX, `Interrupting turn ${turnId}`);
    try {
      await this.sendRequest("turn/interrupt", { threadId, turnId }, 10_000);
    } catch (err) {
      log(LOG_PREFIX, `Interrupt not applied: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Send any app-server request (account reads and the like) and wait for its result. */
  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    return this.sendRequest(method, params, timeoutMs);
  }

  async kill(): Promise<void> {
    if (!this._alive) return;
    this.stopHeartbeat();
    try {
      this.proc.kill();
    } catch { /* already dead */ }
    this._alive = false;
  }

  // --- Turn lifecycle ---

  private async startTurnAndWait(
    threadId: string,
    params: Record<string, unknown>,
    timeoutMs = 10 * 60_000,
  ): Promise<CodexTurnResult> {
    params = { ...params, approvalPolicy: this.settings.approvalPolicy };
    if (this.settings.model) params.model = this.settings.model;
    if (this.settings.effort) params.effort = this.settings.effort;
    if (this.settings.sandbox) params.sandboxPolicy = sandboxPolicyObject(this.settings.sandbox);
    const turnMeta = await this.sendRequest("turn/start", params, 30_000) as {
      turn?: { id: string; status: string };
    };

    const turnId = turnMeta.turn?.id;
    if (!turnId) {
      throw new Error("turn/start did not return a turn ID");
    }

    const early = this._earlyCompletion.get(turnId);
    if (!early) this._activeTurnId = turnId;

    return new Promise<CodexTurnResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._turnResolvers.delete(turnId);
        this._activeTurnId = null;
        reject(new Error(`Turn ${turnId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this._turnResolvers.set(turnId, {
        resolve: (result) => {
          this._activeTurnId = null;
          resolve(result);
        },
        reject: (err) => {
          this._activeTurnId = null;
          reject(err);
        },
        content: this._earlyContent.get(turnId) ?? [],
        timer,
      });
      this._earlyContent.delete(turnId);

      if (early) {
        this._earlyCompletion.delete(turnId);
        this.completeTurn(turnId, early.turn as { status?: string; error?: { message?: string } } | undefined);
      }
    });
  }

  private completeTurn(turnId: string, turn: { status?: string; error?: { message?: string } } | undefined): void {
    const resolver = this._turnResolvers.get(turnId);
    if (!resolver) return;
    clearTimeout(resolver.timer);
    this._turnResolvers.delete(turnId);

    if (turn?.status === "failed") {
      resolver.reject(new Error(`Turn ${turnId} failed: ${turn.error?.message ?? "unknown error"}`));
      return;
    }
    const last = this._turnUsage.get(turnId);
    this._turnUsage.delete(turnId);
    resolver.resolve({
      threadId: this._threadId ?? "",
      content: resolver.content.join(""),
      status: turn?.status === "interrupted" ? "interrupted" : "completed",
      usage: last ? {
        input_tokens: last.inputTokens,
        output_tokens: last.outputTokens,
        cached_input_tokens: last.cachedInputTokens,
      } : undefined,
    });
  }

  // --- Heartbeat ---

  private startHeartbeat(): void {
    this._heartbeatTimer = setInterval(async () => {
      if (!this._alive) { this.stopHeartbeat(); return; }
      if (Date.now() - this._lastActivity < 30_000) return;

      try {
        await this.sendRequest("thread/list", { limit: 1 }, 30_000);
      } catch (err) {
        log(LOG_PREFIX, `Heartbeat failed: ${err instanceof Error ? err.message : err}`);
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // --- JSON-RPC protocol ---

  private sendRequest(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this._alive) {
        reject(new Error("codex app-server is not alive"));
        return;
      }

      const id = this.nextId++;
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      try {
        this.proc.stdin.write(msg);
        this.proc.stdin.flush();
      } catch (err) {
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(new Error(`Failed to write to codex app-server stdin: ${err}`));
      }
    });
  }

  private writeResponse(id: number | string, body: { result?: unknown; error?: { code: number; message: string } }): void {
    try {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\n");
      this.proc.stdin.flush();
    } catch (err) {
      log(LOG_PREFIX, `Failed to respond to server request ${id}: ${err}`);
    }
  }

  // --- stdio readers ---

  private async startReader(): Promise<void> {
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
          this.handleMessage(trimmed);
        }
      }
    } catch (err) {
      if (this._alive) {
        log(LOG_PREFIX, `stdout reader error: ${err}`);
      }
    }
  }

  private handleMessage(line: string): void {
    try {
      const msg = JSON.parse(line);

      // Server-initiated REQUEST (has both "id" AND "method") — must be answered or the turn blocks.
      if (msg.id !== undefined && msg.id !== null && msg.method) {
        this._lastActivity = Date.now();
        this._lastNotificationActivity = Date.now();
        this.handleServerRequest(msg.id, msg.method, msg.params ?? {});
        return;
      }

      // JSON-RPC response (has "id" but no "method" — reply to our request)
      if (msg.id !== undefined && msg.id !== null) {
        this._lastActivity = Date.now();
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(`JSON-RPC error: ${msg.error.message ?? JSON.stringify(msg.error)}`));
          } else {
            pending.resolve(msg.result);
          }
        }
        return;
      }

      // JSON-RPC notification (no "id" — server-initiated, no response needed)
      if (msg.method) {
        this._lastActivity = Date.now();
        this._lastNotificationActivity = Date.now();
        this.handleNotification(msg.method, msg.params ?? {});
        return;
      }
    } catch {
      // Not JSON — ignore
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    const turnId = params.turnId as string | undefined;

    if (this._notificationListeners.length > 0) {
      const notification: CodexNotification = {
        method,
        threadId: (params.threadId as string) ?? undefined,
        turnId,
        params,
      };
      for (const listener of this._notificationListeners) {
        try { listener(notification); } catch { /* listener errors shouldn't break the reader */ }
      }
    }

    switch (method) {
      case "turn/started": {
        const id = (params.turn as { id?: string } | undefined)?.id ?? turnId;
        if (id) this._activeTurnId = id;
        return;
      }
      case "turn/completed": {
        this._activeTurnId = null;
        this._activeItems = 0;
        const turn = params.turn as { id?: string; status?: string; error?: { message?: string } } | undefined;
        const completedTurnId = turn?.id ?? turnId;
        if (!completedTurnId) return;

        if (!this._turnResolvers.has(completedTurnId)) {
          this._earlyCompletion.set(completedTurnId, params);
          return;
        }
        this.completeTurn(completedTurnId, turn);
        return;
      }
      case "item/agentMessage/delta": {
        const delta = params.delta as string | undefined;
        if (delta && turnId) {
          const resolver = this._turnResolvers.get(turnId);
          if (resolver) resolver.content.push(delta);
          else this._earlyContent.set(turnId, [...(this._earlyContent.get(turnId) ?? []), delta]);
        }
        return;
      }
      case "item/started":
        this._activeItems++;
        return;
      case "item/completed": {
        this._activeItems = Math.max(0, this._activeItems - 1);
        const item = params.item as Record<string, unknown> | undefined;
        if (item?.type === "agentMessage" && item.text && turnId) {
          const resolver = this._turnResolvers.get(turnId);
          const content = resolver ? resolver.content : (this._earlyContent.get(turnId) ?? []);
          // If we missed deltas, use the completed item text as fallback
          if (content.length === 0) content.push(item.text as string);
          if (!resolver) this._earlyContent.set(turnId, content);
        }
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = params.tokenUsage as { last?: TokenUsageBreakdown } | undefined;
        if (turnId && usage?.last) this._turnUsage.set(turnId, usage.last);
        return;
      }
      case "thread/status/changed": {
        const status = params.status as { type?: string; activeFlags?: string[] } | undefined;
        if (status?.type) this._threadStatus = status.type;
        this._activeFlags = status?.activeFlags ?? [];
        return;
      }
    }
  }

  /**
   * Answer a server-initiated request with the shape its response schema
   * requires. Unattended operation approves command/file requests, grants the
   * requested permissions for the session, declines elicitations and user-input
   * questions, and refuses requests this driver cannot fulfil.
   */
  private handleServerRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    log(LOG_PREFIX, `Server request: ${method} (id=${id})`);

    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        if (!this._approvalHandler) return this.writeResponse(id, { result: { decision: "acceptForSession" } });
        void this.askApproval(method === "item/fileChange/requestApproval" ? "fileChange" : "command", method, params)
          .then((decision) => this.writeResponse(id, { result: { decision } }));
        return;
      case "execCommandApproval":
      case "applyPatchApproval": {
        if (!this._approvalHandler) return this.writeResponse(id, { result: { decision: "approved_for_session" } });
        const legacy: Record<CodexApprovalDecision, string> = { accept: "approved", acceptForSession: "approved_for_session", decline: "denied", cancel: "abort" };
        void this.askApproval(method === "applyPatchApproval" ? "fileChange" : "command", method, params)
          .then((decision) => this.writeResponse(id, { result: { decision: legacy[decision] } }));
        return;
      }
      case "item/permissions/requestApproval":
        return this.writeResponse(id, { result: { permissions: params.permissions ?? {}, scope: "session" } });
      case "item/tool/requestUserInput":
        return this.writeResponse(id, { result: { answers: {} } });
      case "mcpServer/elicitation/request":
        return this.writeResponse(id, { result: { action: "decline" } });
      case "item/tool/call":
        return this.writeResponse(id, {
          result: {
            success: false,
            contentItems: [{ type: "inputText", text: "Dynamic tools are not provided by multiagents-orchestrator." }],
          },
        });
      default:
        return this.writeResponse(id, { error: { code: -32601, message: `${method} is not supported by multiagents-orchestrator` } });
    }
  }

  private async askApproval(kind: CodexApprovalRequest["kind"], method: string, params: Record<string, unknown>): Promise<CodexApprovalDecision> {
    try {
      return await this._approvalHandler!({ kind, method, params });
    } catch (err) {
      log(LOG_PREFIX, `Approval handler failed (${err instanceof Error ? err.message : err}) — declining`);
      return "decline";
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
          if (trimmed && /error|fatal|panic/i.test(trimmed)) {
            log(LOG_PREFIX, `stderr: ${trimmed.slice(0, 200)}`);
          }
        }
      }
    } catch {
      // Ignore stderr read errors
    }
  }
}
