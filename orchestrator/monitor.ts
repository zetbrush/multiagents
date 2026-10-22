// ============================================================================
// multiagents — Process Monitor
// ============================================================================
// Monitors agent process lifecycle: stdout parsing, status updates, crash
// detection.
// ============================================================================

import type { Subprocess } from "bun";
import type { BrokerClient } from "../shared/broker-client.ts";
import type { CodexDriver, CodexNotification } from "./codex-driver.ts";
import type { ClaudeSession, ClaudeEvent } from "./claude-driver.ts";
import { log } from "../shared/utils.ts";

const LOG_PREFIX = "monitor";
type ProcessReadableStream = Exclude<Subprocess["stdout"], number | null | undefined>;

// Last cumulative totals per slot, for sources that report running thread totals
const lastTokenTotals = new Map<number, { input: number; output: number; cacheRead: number }>();
/** Last running cost a Claude session reported, per slot (its result events carry the session total). */
const lastCost = new Map<number, number>();
// Input-side usage already metered from a Claude turn's API calls (keyed by message id), settled by its result event
const claudeTurnInput = new Map<number, { input: number; cacheRead: number; calls: Set<string> }>();

function isReadableStream(
  stream: Subprocess["stdout"] | Subprocess["stderr"],
): stream is ProcessReadableStream {
  return stream !== undefined && stream !== null && typeof stream !== "number";
}

type TokenCounts = { input: number; output: number; cacheRead: number };

/**
 * Add token usage to a slot. Codex reports cumulative thread totals, so only
 * the increase since the last report counts; a Claude result carries that
 * turn's own usage (verified on Claude Code 2.1.241) and is added as is.
 */
async function updateTokenUsage(
  slotId: number,
  tokens: TokenCounts,
  brokerClient: BrokerClient,
  reporting: "per_turn" | "cumulative",
): Promise<void> {
  let delta = tokens;
  if (reporting === "cumulative") {
    const last = lastTokenTotals.get(slotId) ?? { input: 0, output: 0, cacheRead: 0 };
    delta = {
      input: Math.max(0, tokens.input - last.input),
      output: Math.max(0, tokens.output - last.output),
      cacheRead: Math.max(0, tokens.cacheRead - last.cacheRead),
    };
    lastTokenTotals.set(slotId, tokens);
  }

  if (delta.input === 0 && delta.output === 0 && delta.cacheRead === 0) return;

  try {
    await brokerClient.updateSlot({
      id: slotId,
      input_tokens: delta.input,
      output_tokens: delta.output,
      cache_read_tokens: delta.cacheRead,
    });
  } catch {
    // Best-effort token tracking
  }
}

/** Record the agent's latest activity on its slot without touching the other snapshot keys (driver session ids). */
async function patchSummary(slotId: number, summary: string, brokerClient: BrokerClient): Promise<void> {
  try {
    await brokerClient.updateSlot({
      id: slotId,
      context_patch: { last_summary: summary, last_status: "working", updated_at: Date.now() },
    });
  } catch {
    // Best-effort snapshot update
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
  /** Every JSON line the process prints (the activity timeline reads Gemini's stream-json here) */
  onJson?: (parsed: any) => void,
): void {
  // Read stdout for JSON progress lines
  if (isReadableStream(proc.stdout)) {
    readStream(proc.stdout, slotId, sessionId, brokerClient, onEvent, onJson);
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
  onJson?: (parsed: any) => void,
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
        await processLine(trimmed, slotId, sessionId, brokerClient, onEvent, onJson);
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
  lastCost.delete(slotId);
  claudeTurnInput.delete(slotId);
  transitionedToWorking.delete(slotId);
}

/** Clear all tracking state (call on full session cleanup). */
export function clearAllTracking(): void {
  lastTokenTotals.clear();
  lastCost.clear();
  claudeTurnInput.clear();
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
  onJson?: (parsed: any) => void,
): Promise<void> {
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // Not JSON — plain text output, ignore
  }
  try { onJson?.(parsed); } catch { /* the timeline must not break monitoring */ }
  await processEvent(parsed, slotId, sessionId, brokerClient, onEvent);
}

/** Handle one structured stdout event (Claude stream-json or Codex JSONL). */
export async function processEvent(
  parsed: any,
  slotId: number,
  sessionId: string,
  brokerClient: BrokerClient,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  try {
    // Claude stream-json result event: `result` is the final text, `usage` sits at the top level
    if (parsed.type === "result") {
      onEvent({
        type: "agent_output",
        severity: "info",
        slotId,
        sessionId,
        message: `Agent produced result`,
        data: { result: parsed.result, subtype: parsed.subtype },
      });

      // Claude reports the session's running cost; meter the increase (a new process starts over)
      if (typeof parsed.total_cost_usd === "number") {
        const last = lastCost.get(slotId) ?? 0;
        const delta = parsed.total_cost_usd >= last ? parsed.total_cost_usd - last : parsed.total_cost_usd;
        lastCost.set(slotId, parsed.total_cost_usd);
        if (delta > 0) await brokerClient.updateSlot({ id: slotId, cost_usd: delta }).catch(() => {});
      }

      // Gemini stream-json: one run's totals in `stats`
      if (parsed.stats && !parsed.usage) {
        const st = parsed.stats;
        await updateTokenUsage(slotId, {
          input: st.input_tokens ?? st.prompt_tokens ?? 0,
          output: st.output_tokens ?? st.candidates_tokens ?? 0,
          cacheRead: st.cached ?? st.cached_tokens ?? 0,
        }, brokerClient, "per_turn");
      }

      // The turn's usage minus what its assistant events already metered; output is only known here.
      const usage = parsed.usage ?? parsed.result?.usage;
      if (usage) {
        const metered = claudeTurnInput.get(slotId) ?? { input: 0, cacheRead: 0 };
        claudeTurnInput.delete(slotId);
        await updateTokenUsage(slotId, {
          input: Math.max(0, (usage.input_tokens ?? 0) - metered.input),
          output: usage.output_tokens ?? 0,
          cacheRead: Math.max(0, (usage.cache_read_input_tokens ?? usage.cache_creation_input_tokens ?? 0) - metered.cacheRead),
        }, brokerClient, "per_turn");
      }
    }

    // Claude emits one assistant event per content block, each carrying its API call's usage;
    // input and cache counts are final there, output_tokens is a streaming placeholder.
    if (parsed.type === "assistant" && parsed.message?.usage && typeof parsed.message.id === "string") {
      const turn = claudeTurnInput.get(slotId) ?? { input: 0, cacheRead: 0, calls: new Set<string>() };
      if (!turn.calls.has(parsed.message.id)) {
        turn.calls.add(parsed.message.id);
        const call = { input: parsed.message.usage.input_tokens ?? 0, cacheRead: parsed.message.usage.cache_read_input_tokens ?? 0 };
        turn.input += call.input;
        turn.cacheRead += call.cacheRead;
        claudeTurnInput.set(slotId, turn);
        await updateTokenUsage(slotId, { input: call.input, output: 0, cacheRead: call.cacheRead }, brokerClient, "per_turn");
      }
    }

    // Codex token_count message
    if (parsed.msg?.type === "token_count" && parsed.msg?.info?.total_token_usage) {
      const tu = parsed.msg.info.total_token_usage;
      await updateTokenUsage(slotId, {
        input: tu.input_tokens ?? 0,
        output: tu.output_tokens ?? 0,
        cacheRead: tu.cached_input_tokens ?? 0,
      }, brokerClient, "cumulative");
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
        await patchSummary(slotId, codexItem.text.slice(0, 200), brokerClient);
      }

      if (itemType === "command_execution") {
        await patchSummary(slotId, `Running: ${(codexItem.command ?? "shell command").slice(0, 100)}`, brokerClient);
      }

      if (itemType === "mcp_tool_call") {
        await patchSummary(slotId, `MCP: ${codexItem.server ?? ""}/${codexItem.tool ?? "unknown"}`.slice(0, 100), brokerClient);
      }
    }

    // Legacy Codex format (older versions): {msg:{type:"message"|"exec_command_output",...}}
    if (parsed.msg?.type === "message" && parsed.msg?.role === "assistant") {
      const content = parsed.msg.content;
      const contentText = Array.isArray(content)
        ? content
            .filter((c: any) => c.type === "output_text")
            .map((c: any) => c.text)
            .join("")
        : typeof content === "string" ? content : "";
      if (contentText) {
        await patchSummary(slotId, contentText.slice(0, 200), brokerClient);
      }
    }
    if (parsed.msg?.type === "exec_command_output" || parsed.msg?.type === "mcp_tool_call") {
      await patchSummary(slotId, parsed.msg.type === "exec_command_output"
        ? `Running: ${(parsed.msg.info?.command ?? "shell command").slice(0, 100)}`
        : `MCP tool: ${(parsed.msg.info?.tool_name ?? "unknown").slice(0, 100)}`, brokerClient);
    }

    // Claude stream-json assistant message with content
    if (parsed.type === "assistant" && parsed.message?.content) {
      // Auto-transition to "working" on first Claude output
      await autoTransitionToWorking(slotId, brokerClient);
      const contentText = Array.isArray(parsed.message.content)
        ? parsed.message.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("")
        : String(parsed.message.content);
      if (contentText) await patchSummary(slotId, contentText.slice(0, 200), brokerClient);
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
  } catch (err) {
    log(LOG_PREFIX, `event handling error for slot ${slotId}: ${err}`);
  }
}

/**
 * Monitor a ClaudeDriver: its stream-json events feed the same slot tracking
 * as a plain Claude process (summaries, token usage, working transition).
 */
export function monitorClaudeDriver(
  driver: ClaudeSession,
  slotId: number,
  sessionId: string,
  brokerClient: BrokerClient,
  onEvent: (event: AgentEvent) => void,
): void {
  driver.onEvent((event: ClaudeEvent) => {
    void processEvent(event, slotId, sessionId, brokerClient, onEvent);
  });
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
  let taskState: string | undefined;
  try {
    const slot = await brokerClient.getSlot(slotId);
    taskState = slot?.task_state;
  } catch { /* ok */ }

  // An agent whose work completed normally (code 0) in "approved" state remains connected
  // in standby awaiting human review or release — it must not drop offline while the session is active.
  const isStandbyApproved = exitCode === 0 && taskState === "approved";

  if (!isStandbyApproved) {
    // Update slot status to disconnected
    try {
      await brokerClient.updateSlot({
        id: slotId,
        status: "disconnected",
      });
    } catch (err) {
      log(LOG_PREFIX, `Failed to update slot ${slotId} on exit: ${err}`);
    }
  } else {
    log(LOG_PREFIX, `Slot ${slotId} completed (exit 0) with task_state="approved" — keeping slot online (standby for review/release)`);
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
 * Monitor a CodexDriver via its app-server notification stream.
 *
 * The app-server emits rich notifications: turn/started, turn/completed,
 * item/started, item/completed, item/agentMessage/delta, etc. This bridges
 * those into the slot tracking system (token counts, activity summaries,
 * health detection, auto-transition to "working").
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

/** Process a single app-server notification and update slot state. */
async function handleCodexNotification(
  notification: CodexNotification,
  slotId: number,
  sessionId: string,
  brokerClient: BrokerClient,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  const { method, params } = notification;

  // --- Turn lifecycle ---

  if (method === "turn/started") {
    await autoTransitionToWorking(slotId, brokerClient);
    onEvent({
      type: "agent_progress",
      severity: "info",
      slotId,
      sessionId,
      message: `Codex turn started in slot ${slotId}`,
    });
    return;
  }

  if (method === "turn/completed") {
    const turn = params.turn as { status?: string } | undefined;
    onEvent({
      type: "agent_output",
      severity: "info",
      slotId,
      sessionId,
      message: `Codex turn ${turn?.status ?? "completed"} in slot ${slotId}`,
    });
    return;
  }

  // Token usage arrives on its own notification; `total` is cumulative for the thread.
  if (method === "thread/tokenUsage/updated") {
    const total = (params.tokenUsage as { total?: Record<string, number> } | undefined)?.total;
    if (total) {
      await updateTokenUsage(slotId, {
        input: total.inputTokens ?? 0,
        output: total.outputTokens ?? 0,
        cacheRead: total.cachedInputTokens ?? 0,
      }, brokerClient, "cumulative");
    }
    return;
  }

  // --- Item lifecycle ---

  if (method === "item/completed") {
    await autoTransitionToWorking(slotId, brokerClient);
    const item = params.item as Record<string, unknown> | undefined;
    if (!item) return;

    const itemType = item.type as string | undefined;

    if (itemType === "agentMessage" && item.text) {
      await patchSummary(slotId, String(item.text).slice(0, 200), brokerClient);
    }

    if (itemType === "commandExecution") {
      await patchSummary(slotId, `Running: ${String(item.command ?? "shell command").slice(0, 100)}`, brokerClient);
    }

    if (itemType === "mcpToolCall") {
      await patchSummary(slotId, `MCP: ${String(item.serverLabel ?? "")}/${String(item.toolName ?? "unknown")}`.slice(0, 100), brokerClient);
    }

    if (itemType === "fileChange") {
      await patchSummary(slotId, `File: ${String(item.filePath ?? "unknown file").slice(0, 100)}`, brokerClient);
    }

    onEvent({
      type: "agent_progress",
      severity: "info",
      slotId,
      sessionId,
      message: `Codex ${itemType ?? "activity"} in slot ${slotId}`,
    });
    return;
  }

  // --- Streaming deltas → activity heartbeat ---

  if (method === "item/agentMessage/delta" ||
      method === "item/commandExecution/outputDelta" ||
      method === "item/fileChange/outputDelta") {
    // Don't flood slot updates with every delta, but auto-transition
    await autoTransitionToWorking(slotId, brokerClient);
    return;
  }

  // --- Item started → activity signal ---

  if (method === "item/started") {
    await autoTransitionToWorking(slotId, brokerClient);
    return;
  }
}
