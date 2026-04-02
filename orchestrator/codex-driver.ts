// ============================================================================
// multiagents — Codex MCP Server Driver
// ============================================================================
// Manages a long-running `codex mcp-server` child process and drives Codex
// turns via MCP JSON-RPC protocol over stdio.
//
// Instead of spawning single-shot `codex exec` processes that exit after one
// turn, the driver keeps a persistent `codex mcp-server` alive and uses the
// `codex` (start session) and `codex-reply` (continue session) MCP tools to
// drive multi-turn conversations.
//
// The `codex mcp-server` exposes exactly 2 tools:
//   - "codex":       start a new thread  → returns { threadId, content }
//   - "codex-reply": continue a thread   → returns { threadId, content }
//
// This allows Codex to maintain full conversation history across turns,
// receive teammate messages pushed by the orchestrator, and participate in
// review loops without process restart overhead.
// ============================================================================

import type { Subprocess } from "bun";
import { log } from "../shared/utils.ts";

/** Subprocess type with all stdio set to "pipe" — gives concrete types for stdin/stdout/stderr. */
type PipedSubprocess = Subprocess<"pipe", "pipe", "pipe">;

const LOG_PREFIX = "codex-driver";

/** Result from a Codex turn (start or reply). */
export interface CodexTurnResult {
  threadId: string;
  content: string;
}

/** Notification event emitted by the Codex MCP server. */
export interface CodexNotification {
  method: string;
  /** Thread this notification belongs to (from _meta.threadId). */
  threadId?: string;
  /** Parsed params from the notification. */
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

/**
 * Drives a `codex mcp-server` child process via MCP JSON-RPC over stdio.
 *
 * Lifecycle:
 *   1. CodexDriver.spawn(cwd, env) — starts server, does MCP handshake
 *   2. driver.startSession({prompt, ...}) — creates a thread, runs first turn
 *   3. driver.reply(threadId, message) — pushes a new turn into the thread
 *   4. driver.kill() — graceful shutdown
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
  private _alive = true;
  private _onExitCallbacks: Array<() => void> = [];
  private _notificationListeners: NotificationListener[] = [];
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _lastActivity = Date.now();

  /** The current thread ID (set after startSession). */
  get threadId(): string | null { return this._threadId; }

  /** Whether the underlying process is alive. */
  get alive(): boolean { return this._alive; }

  /** The underlying child process PID. */
  get pid(): number { return this.proc.pid; }

  /** The underlying Subprocess (for process tracking by the orchestrator). */
  get process(): PipedSubprocess { return this.proc; }

  /** Timestamp of last successful communication with the MCP server. */
  get lastActivity(): number { return this._lastActivity; }

  private constructor(proc: PipedSubprocess) {
    this.proc = proc;
    this.startReader();
    this.proc.exited.then((code) => {
      this._alive = false;
      log(LOG_PREFIX, `codex mcp-server exited with code ${code}`);
      // Reject all pending requests
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(new Error(`codex mcp-server exited (code ${code})`));
        this.pendingRequests.delete(id);
      }
      for (const cb of this._onExitCallbacks) {
        try { cb(); } catch { /* don't let one callback break others */ }
      }
    });
  }

  /** Register a callback for when the process exits. Multiple callbacks supported. */
  onExit(cb: () => void): void { this._onExitCallbacks.push(cb); }

  /** Register a listener for MCP notifications from the Codex server. */
  onNotification(cb: NotificationListener): void { this._notificationListeners.push(cb); }

  /**
   * Spawn a new `codex mcp-server` process and perform the MCP handshake.
   *
   * @param cwd - Working directory for Codex
   * @param env - Environment variables (should include MULTIAGENTS_* vars)
   * @param timeoutMs - Handshake timeout (default 30s — MCP init can be slow)
   */
  static async spawn(
    cwd: string,
    env: Record<string, string | undefined>,
    timeoutMs = 30_000,
  ): Promise<CodexDriver> {
    const proc = Bun.spawn(["codex", "mcp-server"], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });

    const driver = new CodexDriver(proc);

    // Read stderr in background (for diagnostics)
    driver.readStderr();

    // MCP initialize handshake
    const initResult = await driver.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "multiagents-orchestrator", version: "1.0" },
    }, timeoutMs) as { serverInfo?: { name: string; version: string } };

    // Per MCP spec: client MUST send `initialized` notification after receiving
    // the initialize response, before making any other requests.
    try {
      driver.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      driver.proc.stdin.flush();
    } catch { /* best effort — handshake already succeeded */ }

    log(LOG_PREFIX, `Handshake complete: ${initResult.serverInfo?.name} v${initResult.serverInfo?.version}`);

    // Start periodic liveness heartbeat — detects hung MCP servers faster
    // than the 10-minute tool call timeout.
    driver.startHeartbeat();

    return driver;
  }

  /**
   * Start a new Codex session (thread). Runs the first turn.
   *
   * This calls the MCP "codex" tool which creates a new thread, executes
   * the prompt, and returns the thread ID + response content. The call
   * blocks until Codex finishes the entire first turn (can take minutes).
   */
  async startSession(opts: CodexSessionOptions): Promise<CodexTurnResult> {
    const args: Record<string, unknown> = {
      prompt: opts.prompt,
    };
    if (opts.cwd) args.cwd = opts.cwd;
    if (opts.sandbox) args.sandbox = opts.sandbox;
    if (opts.baseInstructions) args["base-instructions"] = opts.baseInstructions;
    if (opts.developerInstructions) args["developer-instructions"] = opts.developerInstructions;
    if (opts.model) args.model = opts.model;

    log(LOG_PREFIX, `Starting session: ${opts.prompt.slice(0, 100)}...`);

    // Codex turns can take several minutes — use a generous timeout
    const result = await this.callTool("codex", args, 10 * 60_000) as CodexTurnResult;
    this._threadId = result.threadId;

    log(LOG_PREFIX, `Session started: thread=${result.threadId}, content=${result.content.slice(0, 100)}...`);
    return result;
  }

  /**
   * Send a new turn to an existing thread. Continues the conversation.
   *
   * @param threadId - Thread ID from startSession or a previous reply
   * @param prompt - The new input (e.g., teammate message, orchestrator directive)
   */
  async reply(threadId: string, prompt: string): Promise<CodexTurnResult> {
    log(LOG_PREFIX, `Reply to thread ${threadId}: ${prompt.slice(0, 100)}...`);

    const result = await this.callTool("codex-reply", {
      threadId,
      prompt,
    }, 10 * 60_000) as CodexTurnResult;

    log(LOG_PREFIX, `Reply complete: content=${result.content.slice(0, 100)}...`);
    return result;
  }

  /** Gracefully kill the process. */
  async kill(): Promise<void> {
    if (!this._alive) return;
    this.stopHeartbeat();
    try {
      this.proc.kill();
    } catch { /* already dead */ }
    this._alive = false;
  }

  /**
   * Start a periodic liveness heartbeat using `tools/list` (lightweight, required by MCP spec).
   * If the server fails to respond within 30s, mark the driver as unhealthy.
   */
  private startHeartbeat(): void {
    this._heartbeatTimer = setInterval(async () => {
      if (!this._alive) { this.stopHeartbeat(); return; }

      // Skip heartbeat if there was recent activity (within 30s) — no need to ping
      if (Date.now() - this._lastActivity < 30_000) return;

      try {
        await this.sendRequest("tools/list", {}, 30_000);
        // _lastActivity is updated by handleMessage on successful response
      } catch (err) {
        log(LOG_PREFIX, `Heartbeat failed: ${err instanceof Error ? err.message : err}`);
        // Don't kill here — the orchestrator's crash handler will deal with process exit
      }
    }, 30_000); // Check every 30 seconds
  }

  private stopHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // --- MCP JSON-RPC protocol ---

  /** Send a JSON-RPC request and wait for the response. */
  private sendRequest(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this._alive) {
        reject(new Error("codex mcp-server is not alive"));
        return;
      }

      const id = this.nextId++;
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

      this.pendingRequests.set(id, { resolve, reject });

      // Timeout
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      // Wrap resolve/reject to clear timer
      const origResolve = resolve;
      const origReject = reject;
      this.pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timer); origResolve(v); },
        reject: (e) => { clearTimeout(timer); origReject(e); },
      });

      // Write to stdin (proc.stdin is FileSink when spawned with stdin: "pipe")
      try {
        this.proc.stdin.write(msg);
        this.proc.stdin.flush();
      } catch (err) {
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(new Error(`Failed to write to codex mcp-server stdin: ${err}`));
      }
    });
  }

  /** Call an MCP tool and return the parsed result. */
  private async callTool(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
    const result = await this.sendRequest("tools/call", {
      name,
      arguments: args,
    }, timeoutMs) as {
      content?: Array<{ type: string; text: string }>;
      structuredContent?: { threadId: string; content: string };
      isError?: boolean;
    };

    if (result.isError) {
      const errorText = result.content?.map(c => c.text).join("\n") ?? "Unknown error";
      throw new Error(`Codex tool "${name}" failed: ${errorText}`);
    }

    // Codex returns structured output in `structuredContent` (threadId + content)
    // and plain text in `content[].text`. Prefer structuredContent for thread management.
    if (result.structuredContent?.threadId) {
      return result.structuredContent;
    }

    // Fallback: extract from text content
    const textContent = result.content?.find(c => c.type === "text")?.text ?? "";
    return { threadId: this._threadId ?? "", content: textContent };
  }

  // --- stdio readers ---

  /** Read stdout and dispatch JSON-RPC responses. */
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

  /** Parse and dispatch a JSON-RPC message. */
  private handleMessage(line: string): void {
    try {
      const msg = JSON.parse(line);

      // JSON-RPC response (has "id" field)
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

      // JSON-RPC notification (no "id" — server-initiated)
      // Codex emits codex/event notifications with progress, token usage,
      // and activity data. Parse and forward to registered listeners.
      if (msg.method) {
        this._lastActivity = Date.now();
        if (this._notificationListeners.length > 0) {
          const params = (msg.params ?? {}) as Record<string, unknown>;
          const meta = params._meta as Record<string, unknown> | undefined;
          const notification: CodexNotification = {
            method: msg.method,
            threadId: (meta?.threadId as string) ?? undefined,
            params,
          };
          for (const listener of this._notificationListeners) {
            try { listener(notification); } catch { /* don't let listener errors break the reader */ }
          }
        }
        return;
      }
    } catch {
      // Not JSON — ignore
    }
  }

  /** Read stderr for diagnostic logging. */
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
