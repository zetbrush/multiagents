// ============================================================================
// multiagents — Live "what is this agent doing right now"
// ============================================================================
// While an agent's turn runs, its thinking and reply stream in token by token
// (Claude with --include-partial-messages, Codex delta notifications, Gemini
// message deltas). The timeline only gets whole blocks; this keeps the block
// being written, plus the phase (thinking / writing / running a tool), and
// publishes it to the broker a few times a second so every dashboard can show
// a typing indicator with the thinking as it forms.
// ============================================================================

import type { BrokerClient } from "../shared/broker-client.ts";
import type { LiveActivity } from "../shared/types.ts";
import { describeTool } from "./activity.ts";

const PUBLISH_EVERY_MS = 700;
/** Re-sent while busy so a host that died stops showing as busy */
const HEARTBEAT_MS = 15_000;
const TEXT_KEEP = 6_000;

export class LiveTracker {
  private live: LiveActivity = { busy: false, phase: "idle", text: "", tool: null, since: null, updatedAt: Date.now() };
  private dirty = false;
  private lastSent = 0;
  private timer: ReturnType<typeof setInterval>;

  /** `isBusy` is polled: drivers know best whether a turn is running */
  constructor(private sessionId: string, private slotId: number, private broker: BrokerClient, private isBusy?: () => boolean) {
    this.timer = setInterval(() => this.tick(), PUBLISH_EVERY_MS);
  }

  get state(): LiveActivity { return this.live; }

  // --- Claude stream-json ---

  claude(event: Record<string, any>): void {
    if (event.type === "stream_event") {
      const e = event.event ?? {};
      if (e.type === "content_block_start") {
        const block = e.content_block ?? {};
        if (block.type === "thinking") this.phase("thinking", "");
        else if (block.type === "text") this.phase("writing", "");
        else if (block.type === "tool_use") this.phase("tool", "", block.name ?? null);
      } else if (e.type === "content_block_delta") {
        const d = e.delta ?? {};
        if (d.type === "thinking_delta" && typeof d.thinking === "string") this.append(d.thinking, "thinking");
        else if (d.type === "text_delta" && typeof d.text === "string") this.append(d.text, "writing");
      }
      return;
    }
    if (event.type === "assistant") {
      // Whole blocks (also the only source without partial messages)
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_use") this.phase("tool", "", describeTool(block.name, block.input ?? {}));
        else if (block.type === "thinking" && block.thinking && this.live.phase !== "thinking") this.phase("thinking", String(block.thinking));
      }
      return;
    }
    if (event.type === "user" && event.isReplay !== true) {
      // A tool result came back: the model is deciding what to do next
      if (this.live.phase === "tool") this.phase("waiting", "");
      return;
    }
    if (event.type === "result") this.setBusy(false);
  }

  // --- Codex app-server notifications ---

  codex(method: string, params: Record<string, any>): void {
    switch (method) {
      case "turn/started": this.setBusy(true); this.phase("waiting", ""); return;
      case "turn/completed": this.setBusy(false); return;
      case "item/started": {
        const item = params.item ?? {};
        if (item.type === "reasoning") this.phase("thinking", "");
        else if (item.type === "agentMessage") this.phase("writing", "");
        else if (item.type === "commandExecution") this.phase("tool", "", `$ ${Array.isArray(item.command) ? item.command.join(" ") : item.command ?? ""}`.trim());
        else if (item.type === "fileChange") this.phase("tool", "", "Editing files");
        else if (item.type === "mcpToolCall") this.phase("tool", "", describeTool(`mcp__${item.server ?? "mcp"}__${item.tool ?? "tool"}`, item.arguments ?? {}));
        else if (item.type === "webSearch") this.phase("tool", "", describeTool("WebSearch", { query: item.query }));
        return;
      }
      case "item/completed":
        if (this.live.phase === "tool") this.phase("waiting", "");
        return;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        if (typeof params.delta === "string") this.append(params.delta, "thinking");
        return;
      case "item/reasoning/summaryPartAdded":
        if (this.live.text) this.append("\n\n", "thinking");
        return;
      case "item/agentMessage/delta":
        if (typeof params.delta === "string") this.append(params.delta, "writing");
        return;
    }
  }

  // --- Gemini stream-json ---

  gemini(event: Record<string, any>): void {
    switch (event.type) {
      case "init": this.setBusy(true); this.phase("waiting", ""); return;
      case "message":
        if (event.role !== "assistant") return;
        if (event.delta && typeof event.content === "string") this.append(event.content, "writing");
        else if (this.live.phase !== "writing") this.phase("writing", "");
        return;
      case "tool_use": this.phase("tool", "", describeTool(String(event.tool_name ?? "tool"), event.parameters ?? {})); return;
      case "tool_result": this.phase("waiting", ""); return;
      case "result": this.setBusy(false); return;
    }
  }

  setBusy(busy: boolean): void {
    if (busy === this.live.busy) return;
    this.live = busy
      ? { busy: true, phase: "waiting", text: "", tool: null, since: Date.now(), updatedAt: Date.now() }
      : { busy: false, phase: "idle", text: "", tool: null, since: null, updatedAt: Date.now() };
    this.dirty = true;
    this.tick();
  }

  /** Stop publishing and clear the indicator (the agent exited). */
  dispose(): void {
    clearInterval(this.timer);
    this.live = { busy: false, phase: "idle", text: "", tool: null, since: null, updatedAt: Date.now() };
    void this.publish();
  }

  private phase(phase: LiveActivity["phase"], text: string, tool: string | null = null): void {
    if (!this.live.busy) { this.live.busy = true; this.live.since = Date.now(); }
    this.live.phase = phase;
    this.live.text = text.slice(-TEXT_KEEP);
    this.live.tool = tool;
    this.dirty = true;
  }

  /** Add streamed text; a delta of another kind (or the block's start was missed) starts a new block. */
  private append(s: string, kind: "thinking" | "writing"): void {
    if (this.live.phase !== kind) this.phase(kind, "");
    this.live.text = (this.live.text + s).slice(-TEXT_KEEP);
    this.dirty = true;
  }

  private tick(): void {
    if (this.isBusy) {
      const busy = this.isBusy();
      if (busy !== this.live.busy) { this.setBusy(busy); return; }
    }
    const now = Date.now();
    if (this.dirty || (this.live.busy && now - this.lastSent > HEARTBEAT_MS)) void this.publish();
  }

  private async publish(): Promise<void> {
    this.dirty = false;
    this.lastSent = Date.now();
    this.live.updatedAt = this.lastSent;
    try {
      await this.broker.setLiveActivity({ session_id: this.sessionId, slot_id: this.slotId, live: { ...this.live } });
    } catch { /* the next tick retries */ this.dirty = true; }
  }
}
