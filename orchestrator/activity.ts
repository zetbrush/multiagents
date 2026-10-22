// ============================================================================
// multiagents — Agent activity timeline and tool approvals
// ============================================================================
// Turns what the CLIs stream (Claude stream-json, Codex app-server
// notifications, Gemini stream-json) into one timeline of steps — thinking,
// tool calls with their inputs, command output, file diffs — stored in the
// broker so any dashboard can show it. Tool calls that need a person are
// recorded as approval requests in the broker and waited on until decided.
// ============================================================================

import type { BrokerClient } from "../shared/broker-client.ts";
import type { ActivityKind, ApprovalMode } from "../shared/types.ts";
import { log } from "../shared/utils.ts";

const LOG_PREFIX = "activity";

export interface ActivityItem {
  kind: ActivityKind;
  title: string;
  detail?: string | null;
  data?: unknown;
  ts?: number;
}

/** The team-protocol MCP tools: coordination, not work, so never gated or headlined. */
export function isTeamTool(name: string): boolean {
  return /^mcp__multiagents(-peer)?__/.test(name);
}

function str(v: unknown, max = 400): string {
  const s = typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** A one-line description of a tool call: "Edit src/a.ts", "$ npm test", "Grep "foo" in src". */
export function describeTool(name: string, input: Record<string, unknown> = {}): string {
  const file = (input.file_path ?? input.path ?? input.notebook_path) as string | undefined;
  switch (name) {
    case "Read": return `Read ${file ?? ""}`.trim();
    case "Write": return `Write ${file ?? ""}`.trim();
    case "Edit":
    case "MultiEdit": return `Edit ${file ?? ""}`.trim();
    case "NotebookEdit": return `Edit notebook ${file ?? ""}`.trim();
    case "Bash": return `$ ${str(input.command, 300)}`;
    case "Grep": return `Grep "${str(input.pattern, 80)}"${input.path ? ` in ${str(input.path, 120)}` : ""}`;
    case "Glob": return `Glob ${str(input.pattern, 120)}`;
    case "LS": return `List ${file ?? ""}`.trim();
    case "WebFetch": return `Fetch ${str(input.url, 200)}`;
    case "WebSearch": return `Search "${str(input.query, 120)}"`;
    case "Task":
    case "Agent": return `Subagent: ${str(input.description ?? input.prompt, 120)}`;
    case "TodoWrite": return "Update the todo list";
  }
  if (isTeamTool(name)) return `Team: ${name.replace(/^mcp__multiagents(-peer)?__/, "")}`;
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  if (mcp) return `${mcp[1]} · ${mcp[2]}`;
  return name;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : (c as { text?: string }).text ?? "")).filter(Boolean).join("\n");
  return content === undefined || content === null ? "" : JSON.stringify(content);
}

/** Claude stream-json → timeline entries. `tools` maps tool_use ids to their call, across events. */
export function claudeActivity(event: Record<string, any>, tools: Map<string, { name: string; title: string }>): ActivityItem[] {
  const items: ActivityItem[] = [];
  if (event.type === "system" && event.subtype === "init") {
    items.push({ kind: "status", title: `Session started · ${event.model ?? "default model"}`, data: { model: event.model, permissionMode: event.permissionMode } });
  } else if (event.type === "assistant" && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (block.type === "thinking" && block.thinking) items.push({ kind: "thinking", title: "Thinking", detail: block.thinking });
      else if (block.type === "redacted_thinking") items.push({ kind: "thinking", title: "Thinking (redacted)" });
      else if (block.type === "text" && block.text?.trim()) items.push({ kind: "text", title: "Reply", detail: block.text });
      else if (block.type === "tool_use") {
        const title = describeTool(block.name, block.input ?? {});
        tools.set(block.id, { name: block.name, title });
        items.push({ kind: "tool_call", title, data: { tool: block.name, input: block.input ?? {}, tool_use_id: block.id, team: isTeamTool(block.name) } });
      }
    }
  } else if (event.type === "user" && Array.isArray(event.message?.content) && !event.isReplay) {
    for (const block of event.message.content) {
      if (block.type !== "tool_result") continue;
      const call = tools.get(block.tool_use_id);
      tools.delete(block.tool_use_id);
      items.push({
        kind: "tool_result",
        title: `${block.is_error ? "Failed" : "Result"}${call ? ` · ${call.title}` : ""}`,
        detail: contentText(block.content),
        data: { tool_use_id: block.tool_use_id, tool: call?.name, is_error: block.is_error === true, team: call ? isTeamTool(call.name) : false },
      });
    }
  } else if (event.type === "result") {
    const u = event.usage ?? {};
    items.push({
      kind: "turn_end",
      title: `Turn ${event.is_error ? `ended (${event.subtype})` : "finished"}${typeof event.total_cost_usd === "number" ? ` · $${event.total_cost_usd.toFixed(4)} so far` : ""}`,
      data: { usage: u, cost_usd: event.total_cost_usd, num_turns: event.num_turns },
    });
  }
  return items;
}

/** Codex app-server notification → timeline entries (completed items only, so each step appears once). */
export function codexActivity(method: string, params: Record<string, any>): ActivityItem[] {
  if (method === "turn/completed") {
    const status = params.turn?.status ?? "completed";
    return [{ kind: "turn_end", title: `Turn ${status}`, data: { status, error: params.turn?.error } }];
  }
  if (method === "thread/started") return [{ kind: "status", title: "Thread started", data: { thread: params.thread?.id } }];
  if (method !== "item/completed" || !params.item) return [];
  const item = params.item as Record<string, any>;
  switch (item.type) {
    case "reasoning": {
      const text = [contentText(item.summary), contentText(item.content)].filter(Boolean).join("\n\n");
      return text ? [{ kind: "thinking", title: "Thinking", detail: text }] : [];
    }
    case "agentMessage":
      return item.text ? [{ kind: "text", title: "Reply", detail: item.text }] : [];
    case "commandExecution": {
      const command = Array.isArray(item.command) ? item.command.join(" ") : str(item.command, 2000);
      return [{
        kind: "command",
        title: `$ ${command.slice(0, 300)}`,
        detail: item.aggregatedOutput ?? item.output ?? "",
        data: { command, cwd: item.cwd, exit_code: item.exitCode, status: item.status, duration_ms: item.durationMs },
      }];
    }
    case "fileChange": {
      const changes = (Array.isArray(item.changes) ? item.changes : []).map((c: any) => ({
        path: c.path ?? c.filePath, kind: typeof c.kind === "string" ? c.kind : c.kind?.type, diff: c.diff ?? c.unified_diff ?? "",
      }));
      if (!changes.length && item.filePath) changes.push({ path: item.filePath, kind: "update", diff: "" });
      return [{
        kind: "file_change",
        title: changes.length === 1 ? `${verb(changes[0]!.kind)} ${changes[0]!.path}` : `Changed ${changes.length} files`,
        data: { changes, status: item.status },
      }];
    }
    case "mcpToolCall": {
      const tool = `mcp__${item.server ?? item.serverLabel ?? "mcp"}__${item.tool ?? item.toolName ?? "tool"}`;
      return [{
        kind: "tool_call",
        title: describeTool(tool, item.arguments ?? {}),
        detail: item.result ? contentText(item.result.content ?? item.result) : item.error ? str(item.error, 2000) : null,
        data: { tool, input: item.arguments ?? {}, status: item.status, team: isTeamTool(tool) || item.server === "multiagents-peer" },
      }];
    }
    case "webSearch":
      return [{ kind: "tool_call", title: `Search "${str(item.query, 120)}"`, data: { tool: "web_search", input: { query: item.query } } }];
    case "plan":
    case "todoList":
      return [{ kind: "status", title: "Updated the plan", detail: contentText(item.text ?? item.items) }];
    default:
      return [];
  }
}

function verb(kind: string | undefined): string {
  return kind === "add" ? "Created" : kind === "delete" ? "Deleted" : "Edited";
}

/** Gemini CLI stream-json (`--output-format stream-json`) → timeline entries. */
export function geminiActivity(event: Record<string, any>): ActivityItem[] {
  switch (event.type) {
    case "init":
      return [{ kind: "status", title: `Session started · ${event.model ?? "default model"}`, data: { model: event.model } }];
    case "message":
      return event.role === "assistant" && !event.delta && event.content ? [{ kind: "text", title: "Reply", detail: contentText(event.content) }] : [];
    case "tool_use":
      return [{ kind: "tool_call", title: describeTool(geminiToolName(event.tool_name), event.parameters ?? {}), data: { tool: event.tool_name, input: event.parameters ?? {}, tool_use_id: event.tool_id, team: /multiagents/.test(String(event.tool_name)) } }];
    case "tool_result":
      return [{ kind: "tool_result", title: event.status === "error" ? "Failed" : "Result", detail: contentText(event.output ?? event.error?.message), data: { tool_use_id: event.tool_id, is_error: event.status === "error" } }];
    case "error":
      return [{ kind: "error", title: "Error", detail: contentText(event.message ?? event.error) }];
    case "result":
      return [{ kind: "turn_end", title: `Turn ${event.status ?? "finished"}`, data: { stats: event.stats } }];
    default:
      return [];
  }
}

/** Gemini's built-in tool names, mapped to the Claude names describeTool knows. */
function geminiToolName(name: string): string {
  const map: Record<string, string> = { read_file: "Read", write_file: "Write", replace: "Edit", run_shell_command: "Bash", search_file_content: "Grep", glob: "Glob", list_directory: "LS", web_fetch: "WebFetch", google_web_search: "WebSearch" };
  return map[name] ?? name;
}

/**
 * Buffers one agent's entries and writes them to the broker in batches, so a
 * burst of stream events costs one request.
 */
export class ActivityRecorder {
  private queue: ActivityItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private sessionId: string, private slotId: number, private broker: BrokerClient) {}

  push(...items: ActivityItem[]): void {
    for (const item of items) this.queue.push({ ...item, ts: item.ts ?? Date.now() });
    if (!this.timer && this.queue.length) this.timer = setTimeout(() => void this.flush(), 300);
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const entries = this.queue.splice(0);
    if (!entries.length) return;
    try {
      await this.broker.addActivity({ session_id: this.sessionId, slot_id: this.slotId, entries });
    } catch (err) {
      log(LOG_PREFIX, `Could not record ${entries.length} activity entr${entries.length === 1 ? "y" : "ies"} for slot ${this.slotId}: ${err}`);
    }
  }
}

// --- Approvals ---

export interface ApprovalOutcome {
  allowed: boolean;
  always: boolean;
  note: string | null;
}

/**
 * Record a tool call as waiting for a person and wait for the decision. The
 * request is cancelled (and denied) once `stillWanted` turns false — the agent
 * exited or the request was superseded.
 */
export async function awaitApproval(
  broker: BrokerClient,
  req: { sessionId: string; slotId: number; tool: string; title: string; input: unknown },
  stillWanted: () => boolean,
  pollMs = 600,
): Promise<ApprovalOutcome> {
  const created = await broker.createApproval({ session_id: req.sessionId, slot_id: req.slotId, tool: req.tool, title: req.title, input: req.input });
  while (true) {
    await Bun.sleep(pollMs);
    if (!stillWanted()) {
      await broker.decideApproval({ id: created.id, session_id: req.sessionId, decision: "cancel", decided_by: "orchestrator", note: "The agent stopped" }).catch(() => {});
      return { allowed: false, always: false, note: "cancelled" };
    }
    let row;
    try {
      row = await broker.getApproval(created.id);
    } catch {
      continue; // broker hiccup: keep waiting
    }
    if (row.status === "pending") continue;
    return { allowed: row.status === "allowed", always: row.always === 1, note: row.note };
  }
}

/** What each approval mode means for each CLI. */
export const CLAUDE_PERMISSION_MODE: Record<ApprovalMode, string> = {
  bypass: "bypassPermissions",
  auto: "auto",
  accept_edits: "acceptEdits",
  ask: "default",
};

export const CODEX_APPROVAL_POLICY: Record<ApprovalMode, string> = {
  bypass: "never",
  auto: "on-request",
  accept_edits: "untrusted",
  ask: "untrusted",
};

export function parseApprovalMode(v: unknown): ApprovalMode {
  return v === "auto" || v === "accept_edits" || v === "ask" ? v : "bypass";
}
