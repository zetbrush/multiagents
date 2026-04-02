// ============================================================================
// multiagents — Codex App-Server Driver
// ============================================================================
// Manages a long-running `codex app-server` child process and drives Codex
// turns via the app-server JSON-RPC protocol over stdio.
//
// The app-server protocol (unlike the simpler mcp-server) supports:
//   - thread/start:    create a new conversation thread
//   - turn/start:      begin a new agent turn (returns immediately, streams via notifications)
//   - turn/steer:      inject content mid-turn (between agent loop iterations)
//   - turn/interrupt:  cancel an in-flight turn
//
// This enables mid-turn message injection: when Codex is busy executing a
// multi-minute task, the orchestrator can push teammate messages via
// turn/steer without waiting for the turn to complete.
//
// Data flow:
//   turn/start → turn/started notification (gives turnId)
//   → item/started → item/*/delta → item/completed (streaming work)
//   → turn/completed (final result with usage stats)
// ============================================================================

import type { Subprocess } from "bun";
import { log } from "../shared/utils.ts";

/** Subprocess type with all stdio set to "pipe". */
type PipedSubprocess = Subprocess<"pipe", "pipe", "pipe">;

const LOG_PREFIX = "codex-driver";

/** Result from a Codex turn. */
export interface CodexTurnResult {
  threadId: string;
  content: string;
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

/** Convert a simplified sandbox string to the Codex app-server's serde enum object.
 *  The app-server uses camelCase variant names: workspaceWrite, readOnly, etc. */
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

/**
 * Drives a `codex app-server` child process via JSON-RPC over stdio.
 *
 * Lifecycle:
 *   1. CodexDriver.spawn(cwd, env) — starts server, does handshake
 *   2. driver.startSession({prompt, ...}) — creates a thread, runs first turn
 *   3. driver.reply(threadId, message) — starts a new turn on the thread
 *   4. driver.steer(threadId, text) — injects content mid-turn
 *   5. driver.kill() — graceful shutdown
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
  private _onExitCallbacks: Array<() => void> = [];
  private _notificationListeners: NotificationListener[] = [];
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _lastActivity = Date.now();
  /** Tracks last notification activity (item/completed, turn events).
   *  Unlike _lastActivity, this is NOT updated by heartbeat responses. */
  private _lastNotificationActivity = Date.now();

  // Turn completion tracking: when a turn is in flight, we collect content
  // from streaming notifications and resolve when turn/completed fires.
  private _turnResolvers = new Map<string, {
    resolve: (result: CodexTurnResult) => void;
    reject: (error: Error) => void;
    content: string[];
    usage?: CodexTurnResult["usage"];
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

  private constructor(proc: PipedSubprocess) {
    this.proc = proc;
    this.startReader();
    this.proc.exited.then((code) => {
      this._alive = false;
      this._activeTurnId = null;
      log(LOG_PREFIX, `codex app-server exited with code ${code}`);
      // Reject all pending requests
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(new Error(`codex app-server exited (code ${code})`));
        this.pendingRequests.delete(id);
      }
      // Reject all pending turn completions
      for (const [turnId, resolver] of this._turnResolvers) {
        clearTimeout(resolver.timer);
        resolver.reject(new Error(`codex app-server exited (code ${code}) during turn ${turnId}`));
        this._turnResolvers.delete(turnId);
      }
      for (const cb of this._onExitCallbacks) {
        try { cb(); } catch { /* don't let one callback break others */ }
      }
    });
  }

  /** Register a callback for when the process exits. Multiple callbacks supported. */
  onExit(cb: () => void): void { this._onExitCallbacks.push(cb); }

  /** Register a listener for notifications from the app-server. */
  onNotification(cb: NotificationListener): void { this._notificationListeners.push(cb); }

  /**
   * Spawn a new `codex app-server` process and perform the handshake.
   */
  static async spawn(
    cwd: string,
    env: Record<string, string | undefined>,
    timeoutMs = 30_000,
  ): Promise<CodexDriver> {
    const proc = Bun.spawn(["codex", "app-server"], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });

    const driver = new CodexDriver(proc);
    driver.readStderr();

    // App-server handshake: initialize → response → initialized notification
    const initResult = await driver.sendRequest("initialize", {
      clientInfo: { name: "multiagents-orchestrator", version: "1.0" },
      capabilities: {},
    }, timeoutMs) as { userAgent?: string };

    // Send initialized notification (required before any other requests)
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
   *
   * Creates a thread, then starts a turn with the given prompt.
   * Blocks until the turn completes (can take minutes).
   */
  async startSession(opts: CodexSessionOptions): Promise<CodexTurnResult> {
    log(LOG_PREFIX, `Starting session: ${opts.prompt.slice(0, 100)}...`);

    // Step 1: create a thread
    // thread/start returns { thread: { id: "..." }, ... }
    const threadResult = await this.sendRequest("thread/start", {}, 30_000) as { thread: { id: string } };
    const threadId = threadResult.thread?.id;
    if (!threadId) throw new Error("thread/start did not return a thread ID");
    this._threadId = threadId;

    // Step 2: start the first turn
    const turnInput: Record<string, unknown> = {
      threadId,
      input: [{ type: "text", text: opts.prompt }],
    };
    if (opts.cwd) turnInput.cwd = opts.cwd;
    // Codex app-server expects sandboxPolicy as a serde internally-tagged enum.
    // Convert our simplified string to the full object format.
    if (opts.sandbox) {
      turnInput.sandboxPolicy = sandboxPolicyObject(opts.sandbox, opts.cwd);
    }
    if (opts.developerInstructions) turnInput.developerInstructions = opts.developerInstructions;
    if (opts.model) turnInput.model = opts.model;
    // Enable fully autonomous execution (equivalent to `codex exec -a never`).
    // Without this, MCP tool calls require interactive approval which hangs in headless mode.
    // The schema accepts: "untrusted" | "on-failure" | "on-request" | "never"
    turnInput.approvalPolicy = "never";

    const result = await this.startTurnAndWait(threadId, turnInput);

    log(LOG_PREFIX, `Session started: thread=${result.threadId}, content=${result.content.slice(0, 100)}...`);
    return result;
  }

  /**
   * Send a new turn to an existing thread.
   */
  async reply(threadId: string, prompt: string): Promise<CodexTurnResult> {
    log(LOG_PREFIX, `Reply to thread ${threadId}: ${prompt.slice(0, 100)}...`);

    const result = await this.startTurnAndWait(threadId, {
      threadId,
      input: [{ type: "text", text: prompt }],
      approvalPolicy: "never",
    });

    log(LOG_PREFIX, `Reply complete: content=${result.content.slice(0, 100)}...`);
    return result;
  }

  /**
   * Inject content into an active turn (mid-turn message delivery).
   *
   * This is the key improvement over mcp-server: steer pushes content
   * between agent loop iterations without waiting for the turn to finish.
   * Returns immediately — the agent processes the steered input as part
   * of the ongoing turn.
   *
   * Throws if no turn is active or if the turn rejects the steer.
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
   * Interrupt an active turn.
   */
  async interrupt(threadId: string): Promise<void> {
    const turnId = this._activeTurnId;
    if (!turnId) return;

    log(LOG_PREFIX, `Interrupting turn ${turnId}`);
    await this.sendRequest("turn/interrupt", { threadId, turnId }, 10_000);
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

  /**
   * Start a turn and wait for it to complete via notifications.
   *
   * Sends turn/start, then collects content from item/agentMessage/delta
   * and item/completed notifications. Resolves when turn/completed fires.
   */
  private async startTurnAndWait(
    threadId: string,
    params: Record<string, unknown>,
    timeoutMs = 10 * 60_000,
  ): Promise<CodexTurnResult> {
    // Send the turn/start request — returns immediately with turn metadata
    const turnMeta = await this.sendRequest("turn/start", params, 30_000) as {
      turn?: { id: string; status: string };
    };

    const turnId = turnMeta.turn?.id;
    if (!turnId) {
      throw new Error("turn/start did not return a turn ID");
    }

    this._activeTurnId = turnId;

    // Wait for turn/completed notification
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
        content: [],
        timer,
      });
    });
  }

  // --- Heartbeat ---

  private startHeartbeat(): void {
    this._heartbeatTimer = setInterval(async () => {
      if (!this._alive) { this.stopHeartbeat(); return; }
      if (Date.now() - this._lastActivity < 30_000) return;

      try {
        // Use thread/list as a lightweight health check
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

      this.pendingRequests.set(id, { resolve, reject });

      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      const origResolve = resolve;
      const origReject = reject;
      this.pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timer); origResolve(v); },
        reject: (e) => { clearTimeout(timer); origReject(e); },
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

      // Server-initiated REQUEST (has both "id" AND "method").
      // These are approval requests — the server asks us to approve commands,
      // file changes, MCP tool calls, etc. We must respond or the turn blocks.
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

  /**
   * Handle an app-server notification. Key events:
   *
   * - turn/started:           Active turn ID assigned
   * - turn/completed:         Turn finished (resolve pending promise)
   * - item/agentMessage/delta: Streaming content (collect for final result)
   * - item/completed:         Single item finished (token tracking, activity)
   */
  private handleNotification(method: string, params: Record<string, unknown>): void {
    const turnId = params.turnId as string | undefined;

    // Dispatch to registered external listeners
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

    // --- Internal turn lifecycle tracking ---

    if (method === "turn/started") {
      const id = (params.turn as any)?.id ?? turnId;
      if (id) this._activeTurnId = id;
      return;
    }

    if (method === "turn/completed") {
      this._activeTurnId = null;
      const completedTurnId = turnId ?? (params.turn as any)?.id;
      if (!completedTurnId) return;

      const resolver = this._turnResolvers.get(completedTurnId);
      if (resolver) {
        clearTimeout(resolver.timer);
        this._turnResolvers.delete(completedTurnId);

        // Extract usage from turn/completed params
        const usage = (params.usage ?? (params.turn as any)?.usage) as CodexTurnResult["usage"] | undefined;

        resolver.resolve({
          threadId: this._threadId ?? "",
          content: resolver.content.join(""),
          usage: usage ?? resolver.usage,
        });
      }
      return;
    }

    // Collect streaming agent message content
    if (method === "item/agentMessage/delta") {
      const delta = params.delta as string | undefined;
      if (delta && turnId) {
        const resolver = this._turnResolvers.get(turnId);
        if (resolver) resolver.content.push(delta);
      }
      return;
    }

    // Item completed — extract any content and usage
    if (method === "item/completed") {
      const item = params.item as Record<string, unknown> | undefined;
      if (item?.type === "agentMessage" && item.text && turnId) {
        const resolver = this._turnResolvers.get(turnId);
        if (resolver && resolver.content.length === 0) {
          // If we missed deltas, use the completed item text as fallback
          resolver.content.push(item.text as string);
        }
      }
      // Extract token usage from item
      if (item?.usage && turnId) {
        const resolver = this._turnResolvers.get(turnId);
        if (resolver) resolver.usage = item.usage as CodexTurnResult["usage"];
      }
      return;
    }
  }

  /**
   * Handle a server-initiated JSON-RPC request (has both id and method).
   * These are approval requests — auto-approve all of them for headless operation.
   *
   * Known request types:
   *   - item/commandExecution/requestApproval → approve shell commands
   *   - item/fileChange/requestApproval → approve file writes
   *   - item/applyPatch/requestApproval → approve patches
   *   - mcp/server/elicitationRequest → approve MCP interactions
   *   - item/permissions/requestApproval → approve permission escalations
   */
  private handleServerRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    log(LOG_PREFIX, `Auto-approving server request: ${method} (id=${id})`);

    // Each server request type has its own response schema — must match exactly.
    let result: Record<string, unknown>;

    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      // Schema: { decision: "accept" | "acceptForSession" | "decline" | "cancel" }
      result = { decision: "acceptForSession" };
    } else if (method === "item/applyPatch/requestApproval" || method === "execCommand/requestApproval") {
      // Schema: { decision: "approved" | "approved_for_session" | "denied" | "abort" }
      result = { decision: "approved_for_session" };
    } else if (method.includes("elicitation")) {
      // Schema: { action: "accept" | "decline" | "cancel" }
      result = { action: "accept" };
    } else if (method === "permissions/requestApproval") {
      // Schema: { permissions: { fileSystem: { read: [...], write: [...] }, network: { enabled: true } }, scope: "session" }
      result = {
        permissions: {
          fileSystem: { read: [process.cwd()], write: [process.cwd()] },
          network: { enabled: true },
        },
        scope: "session",
      };
    } else if (method.includes("requestUserInput") || method.includes("toolRequestUserInput")) {
      // Schema: { answers: {} }
      result = { answers: {} };
    } else if (method.includes("requestApproval") || method.includes("approval")) {
      // Fallback for unknown approval types
      result = { decision: "acceptForSession" };
    } else {
      // Unknown server request — try generic approval
      result = { decision: "acceptForSession" };
    }

    try {
      const response = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
      this.proc.stdin.write(response);
      this.proc.stdin.flush();
    } catch (err) {
      log(LOG_PREFIX, `Failed to respond to server request ${method}: ${err}`);
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
