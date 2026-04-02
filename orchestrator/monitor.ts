// ============================================================================
// multiagents — Process Monitor
// ============================================================================
// Monitors agent process lifecycle: stdout parsing, status updates, crash
// detection.
// ============================================================================

import type { Subprocess } from "bun";
import type { BrokerClient } from "../shared/broker-client.ts";
import type { CodexDriver, CodexNotification } from "./codex-driver.ts";
import { log } from "../shared/utils.ts";

const LOG_PREFIX = "monitor";
type ProcessReadableStream = Exclude<Subprocess["stdout"], number | null | undefined>;

// Track last-seen cumulative tokens per slot (Codex sends cumulative totals)
const lastTokenTotals = new Map<number, { input: number; output: number; cacheRead: number }>();

function isReadableStream(
  stream: Subprocess["stdout"] | Subprocess["stderr"],
): stream is ProcessReadableStream {
  return stream !== undefined && stream !== null && typeof stream !== "number";
}

/** Update token usage for a slot — handles both delta and cumulative formats. */
async function updateTokenUsage(
  slotId: number,
  tokens: { input: number; output: number; cacheRead: number },
  brokerClient: BrokerClient,
): Promise<void> {
  // Codex sends cumulative totals; Claude sends per-result totals.
  // For Codex, we compute the delta from the last seen value.
  // For Claude, each "result" contains the full session usage, so we also delta.
  const last = lastTokenTotals.get(slotId) ?? { input: 0, output: 0, cacheRead: 0 };
  const deltaInput = Math.max(0, tokens.input - last.input);
  const deltaOutput = Math.max(0, tokens.output - last.output);
  const deltaCacheRead = Math.max(0, tokens.cacheRead - last.cacheRead);

  lastTokenTotals.set(slotId, tokens);

  if (deltaInput === 0 && deltaOutput === 0 && deltaCacheRead === 0) return;

  try {
    await brokerClient.updateSlot({
      id: slotId,
      input_tokens: deltaInput,
      output_tokens: deltaOutput,
      cache_read_tokens: deltaCacheRead,
    });
  } catch {
    // Best-effort token tracking
  }
}

/** Event emitted by the process monitor. */
export interface AgentEvent {
  type: string;
  severity: "info" | "warning" | "critical";
  slotId: number;
  sessionId: string;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Monitor an agent subprocess: read stdout for progress signals,
 * update slot status in the broker, and fire events on exit.
 *
 * This function is non-blocking — it starts async readers and returns
 * immediately.
 */
export function monitorProcess(
  proc: Subprocess,
  slotId: number,
  sessionId: string,
  brokerClient: BrokerClient,
  onEvent: (event: AgentEvent) => void,
): void {
  // Read stdout for JSON progress lines
  if (isReadableStream(proc.stdout)) {
    readStream(proc.stdout, slotId, sessionId, brokerClient, onEvent);
  }

  // Read stderr for error output
  if (isReadableStream(proc.stderr)) {
    readStderr(proc.stderr, slotId, sessionId, onEvent);
  }

  // Monitor process exit
  proc.exited.then((exitCode) => {
    handleExit(exitCode, slotId, sessionId, brokerClient, onEvent);
  });
}

/** Read stdout stream, parse JSON lines for progress signals. */
async function readStream(
  stdout: ProcessReadableStream,
  slotId: number,
  sessionId: string,
  brokerClient: BrokerClient,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    const reader = stdout.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        await processLine(trimmed, slotId, sessionId, brokerClient, onEvent);
      }
    }
  } catch (err) {
    log(LOG_PREFIX, `stdout reader error for slot ${slotId}: ${err}`);
  }
}

/** Process a single stdout line, attempting JSON parse for structured signals. */
/** Track which slots have already been transitioned to "working" (avoid repeated broker calls). */
const transitionedToWorking = new Set<number>();

/** Clear all tracking state for a slot (call on release/session end). */
export function clearSlotTracking(slotId: number): void {
  lastTokenTotals.delete(slotId);
  transitionedToWorking.delete(slotId);
}

/** Clear all tracking state (call on full session cleanup). */
export function clearAllTracking(): void {
  lastTokenTotals.clear();
  transitionedToWorking.clear();
}

/** Auto-transition task_state from "idle" to "working" on first detected activity. */
async function autoTransitionToWorking(slotId: number, brokerClient: BrokerClient): Promise<void> {
  if (transitionedToWorking.has(slotId)) return;
  transitionedToWorking.add(slotId);
  try {
    const slot = await brokerClient.getSlot(slotId);
    if (slot.task_state === "idle") {
      await brokerClient.updateSlot({ id: slotId, task_state: "working" });
      log(LOG_PREFIX, `Slot ${slotId} auto-transitioned to "working"`);
    }
  } catch { /* best effort */ }
}

async function processLine(
  line: string,
  slotId: number,
  sessionId: string,
  brokerClient: BrokerClient,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  // Try parsing as JSON (Claude stream-json format)
  try {
    const parsed = JSON.parse(line);

    // Claude stream-json result message (includes final token usage)
    if (parsed.type === "result" && parsed.result) {
      onEvent({
        type: "agent_output",
        severity: "info",
        slotId,
        sessionId,
        message: `Agent produced result`,
        data: { result: parsed.result },
      });

      // Extract token usage from Claude result
      const usage = parsed.result?.usage;
      if (usage) {
        await updateTokenUsage(slotId, {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? usage.cache_creation_input_tokens ?? 0,
        }, brokerClient);
      }
    }

    // Codex token_count message
    if (parsed.msg?.type === "token_count" && parsed.msg?.info?.total_token_usage) {
      const tu = parsed.msg.info.total_token_usage;
      await updateTokenUsage(slotId, {
        input: tu.input_tokens ?? 0,
        output: tu.output_tokens ?? 0,
        cacheRead: tu.cached_input_tokens ?? 0,
      }, brokerClient);
    }

    // Codex JSONL activity events — update context_snapshot so the
    // orchestrator knows the agent is active (prevents false "silent" nudges).
    // Codex `--json` emits JSONL with this structure:
    //   {type:"item.completed", item:{type:"agent_message", text:"..."}}
    //   {type:"item.completed", item:{type:"command_execution", command:"...", aggregated_output:"..."}}
    //   {type:"item.completed", item:{type:"mcp_tool_call", server:"...", tool:"...", result:{...}}}
    // Also handles legacy format: {msg:{type:"message"|"exec_command_output"|"mcp_tool_call",...}}
    const codexItem = parsed.item ?? parsed.msg;
    if (parsed.type === "item.completed" && codexItem) {
      // Auto-transition to "working" on first Codex activity
      await autoTransitionToWorking(slotId, brokerClient);
      const itemType = codexItem.type;

      if (itemType === "agent_message" && codexItem.text) {
        try {
          const summary = codexItem.text.slice(0, 200);
          await brokerClient.updateSlot({
            id: slotId,
            context_snapshot: JSON.stringify({
              last_summary: summary,
              last_status: "working",
              updated_at: Date.now(),
            }),
          });
        } catch {
          // Best-effort snapshot update
        }
      }

      if (itemType === "command_execution") {
        try {
          await brokerClient.updateSlot({
            id: slotId,
            context_snapshot: JSON.stringify({
              last_summary: `Running: ${(codexItem.command ?? "shell command").slice(0, 100)}`,
              last_status: "working",
              updated_at: Date.now(),
            }),
          });
        } catch { /* best-effort */ }
      }

      if (itemType === "mcp_tool_call") {
        try {
          await brokerClient.updateSlot({
            id: slotId,
            context_snapshot: JSON.stringify({
              last_summary: `MCP: ${codexItem.server ?? ""}/${codexItem.tool ?? "unknown"}`.slice(0, 100),
              last_status: "working",
              updated_at: Date.now(),
            }),
          });
        } catch { /* best-effort */ }
      }
    }

    // Legacy Codex format (older versions): {msg:{type:"message"|"exec_command_output",...}}
    if (parsed.msg?.type === "message" && parsed.msg?.role === "assistant") {
      try {
        const content = parsed.msg.content;
        const contentText = Array.isArray(content)
          ? content
              .filter((c: any) => c.type === "output_text")
              .map((c: any) => c.text)
              .join("")
          : typeof content === "string" ? content : "";
        if (contentText) {
          await brokerClient.updateSlot({
            id: slotId,
            context_snapshot: JSON.stringify({
              last_summary: contentText.slice(0, 200),
              last_status: "working",
              updated_at: Date.now(),
            }),
          });
        }
      } catch { /* best-effort */ }
    }
    if (parsed.msg?.type === "exec_command_output" || parsed.msg?.type === "mcp_tool_call") {
      try {
        await brokerClient.updateSlot({
          id: slotId,
          context_snapshot: JSON.stringify({
            last_summary: parsed.msg.type === "exec_command_output"
              ? `Running: ${(parsed.msg.info?.command ?? "shell command").slice(0, 100)}`
              : `MCP tool: ${(parsed.msg.info?.tool_name ?? "unknown").slice(0, 100)}`,
            last_status: "working",
            updated_at: Date.now(),
          }),
        });
      } catch { /* best-effort */ }
    }

    // Claude stream-json assistant message with content
    if (parsed.type === "assistant" && parsed.message?.content) {
      // Auto-transition to "working" on first Claude output
      await autoTransitionToWorking(slotId, brokerClient);
      // Update the slot's context snapshot with latest output
      try {
        const contentText = Array.isArray(parsed.message.content)
          ? parsed.message.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("")
          : String(parsed.message.content);

        const summary = contentText.slice(0, 200);
        await brokerClient.updateSlot({
          id: slotId,
          context_snapshot: JSON.stringify({
            last_summary: summary,
            last_status: "working",
            updated_at: Date.now(),
          }),
        });
      } catch {
        // Best-effort snapshot update
      }
    }

    // Tool use signals progress — auto-transition to "working"
    if (parsed.type === "assistant" && parsed.message?.stop_reason === "tool_use") {
      await autoTransitionToWorking(slotId, brokerClient);
      onEvent({
        type: "agent_progress",
        severity: "info",
        slotId,
        sessionId,
        message: "Agent is using tools",
      });
    }

    return;
  } catch {
    // Not JSON — treat as plain text output, ignore
  }
}

/** Read stderr for error messages. */
async function readStderr(
  stderr: ProcessReadableStream,
  slotId: number,
  sessionId: string,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    const reader = stderr.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Check for error patterns
        if (/error|fatal|panic|exception/i.test(trimmed)) {
          onEvent({
            type: "agent_error",
            severity: "warning",
            slotId,
            sessionId,
            message: `Agent stderr: ${trimmed.slice(0, 200)}`,
          });
        }
      }
    }
  } catch (err) {
    log(LOG_PREFIX, `stderr reader error for slot ${slotId}: ${err}`);
  }
}

/** Handle process exit — update slot and emit event. */
async function handleExit(
  exitCode: number,
  slotId: number,
  sessionId: string,
  brokerClient: BrokerClient,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  // Update slot status to disconnected
  try {
    await brokerClient.updateSlot({
      id: slotId,
      status: "disconnected",
    });
  } catch (err) {
    log(LOG_PREFIX, `Failed to update slot ${slotId} on exit: ${err}`);
  }

  if (exitCode === 0) {
    onEvent({
      type: "agent_completed",
      severity: "info",
      slotId,
      sessionId,
      message: `Agent in slot ${slotId} completed successfully`,
      data: { exit_code: exitCode },
    });
  } else {
    onEvent({
      type: "agent_crashed",
      severity: "critical",
      slotId,
      sessionId,
      message: `Agent in slot ${slotId} exited with code ${exitCode}`,
      data: { exit_code: exitCode },
    });
  }

  log(LOG_PREFIX, `Slot ${slotId} process exited with code ${exitCode}`);
}

/**
 * Monitor a CodexDriver via its notification stream.
 *
 * In MCP server mode, Codex emits JSON-RPC notifications instead of JSONL
 * on stdout. This bridges the gap: it listens to driver notifications and
 * updates slot state (token tracking, activity detection, auto-transition
 * to "working") using the same logic as the stdout-based monitor.
 */
export function monitorCodexDriver(
  driver: CodexDriver,
  slotId: number,
  sessionId: string,
  brokerClient: BrokerClient,
  onEvent: (event: AgentEvent) => void,
): void {
  driver.onNotification((notification: CodexNotification) => {
    handleCodexNotification(notification, slotId, sessionId, brokerClient, onEvent);
  });
}

/** Process a single Codex MCP notification and update slot state. */
async function handleCodexNotification(
  notification: CodexNotification,
  slotId: number,
  sessionId: string,
  brokerClient: BrokerClient,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  const { method, params } = notification;

  // MCP logging notifications — extract error-level logs
  if (method === "notifications/message" || method === "notifications/logging/message") {
    const level = params.level as string | undefined;
    const data = params.data as string | undefined;
    if (level === "error" && data) {
      onEvent({
        type: "agent_error",
        severity: "warning",
        slotId,
        sessionId,
        message: `Codex MCP log: ${String(data).slice(0, 200)}`,
      });
    }
    return;
  }

  // MCP progress notifications
  if (method === "notifications/progress") {
    // Activity detected — auto-transition to working
    await autoTransitionToWorking(slotId, brokerClient);
    return;
  }

  // Codex-specific event notifications (codex/event or similar)
  // These carry item completions, token counts, and activity signals
  const data = params.data as Record<string, unknown> | undefined;
  const eventType = (params.type ?? data?.type) as string | undefined;

  if (!eventType) return;

  // Token usage from turn.completed events
  if (eventType === "turn.completed") {
    const usage = (params.usage ?? data?.usage) as Record<string, number> | undefined;
    if (usage) {
      await updateTokenUsage(slotId, {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cached_input_tokens ?? 0,
      }, brokerClient);
    }
    return;
  }

  // Item completions (agent_message, command_execution, mcp_tool_call)
  if (eventType === "item.completed") {
    await autoTransitionToWorking(slotId, brokerClient);
    const item = (params.item ?? data?.item) as Record<string, unknown> | undefined;
    if (!item) return;

    const itemType = item.type as string | undefined;

    if (itemType === "agent_message" && item.text) {
      try {
        await brokerClient.updateSlot({
          id: slotId,
          context_snapshot: JSON.stringify({
            last_summary: String(item.text).slice(0, 200),
            last_status: "working",
            updated_at: Date.now(),
          }),
        });
      } catch { /* best-effort */ }
    }

    if (itemType === "command_execution") {
      try {
        await brokerClient.updateSlot({
          id: slotId,
          context_snapshot: JSON.stringify({
            last_summary: `Running: ${String(item.command ?? "shell command").slice(0, 100)}`,
            last_status: "working",
            updated_at: Date.now(),
          }),
        });
      } catch { /* best-effort */ }
    }

    if (itemType === "mcp_tool_call") {
      try {
        await brokerClient.updateSlot({
          id: slotId,
          context_snapshot: JSON.stringify({
            last_summary: `MCP: ${String(item.server ?? "")}/${String(item.tool ?? "unknown")}`.slice(0, 100),
            last_status: "working",
            updated_at: Date.now(),
          }),
        });
      } catch { /* best-effort */ }
    }

    onEvent({
      type: "agent_progress",
      severity: "info",
      slotId,
      sessionId,
      message: `Codex ${itemType ?? "activity"} in slot ${slotId}`,
    });
  }
}
