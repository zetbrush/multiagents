#!/usr/bin/env bun
/**
 * CodexAdapter — MCP adapter for Codex CLI instances.
 *
 * Codex has no channel/push capability. Messages are buffered in memory
 * and delivered piggybacked on the next tool response.
 */

import { BaseAdapter } from "./base-adapter.ts";
import type { BufferedMessage } from "../shared/types.ts";

export class CodexAdapter extends BaseAdapter {
  private messageBuffer: BufferedMessage[] = [];

  constructor() {
    super("codex");
  }

  getCapabilities(): Record<string, unknown> {
    return {
      tools: {},
    };
  }

  getSystemPrompt(): string {
    const base = `You are a team member on the multiagents network via Codex CLI. Other agents can see you and message you.

MESSAGE DELIVERY: You do not have push notifications. Messages arrive in two ways:
1. Piggybacked on tool responses — "[PENDING MESSAGES]" at the top of any tool result. Read these FIRST.
2. Via check_messages — call this after EVERY shell command and every 3-5 tool calls.

TOOLS:
- list_peers / check_team_status: See who's on the team, their roles, and status
- send_message / check_messages: Communicate with teammates (check_messages is your lifeline — call it constantly)
- set_summary: Broadcast what you're working on (keep updated as you progress)
- signal_done: Signal your work is complete and ready for review
- submit_feedback / approve: Review teammates' work
- acquire_file / release_file / view_file_locks: Coordinate file edits
- get_plan / update_plan: Track team progress against the plan
- get_history: Review past messages

ON START: Call set_summary, check_messages, and check_team_status immediately. Call get_plan to see your assigned items.

CRITICAL: Call check_messages after EVERY shell command. Teammate messages are only delivered when you use multiagents tools. Missing a message means blocking your team.

QUALITY STANDARD: You produce production-grade code. Plan before coding. Verify before signaling done. Fix root causes, not symptoms. Keep solutions simple and clean.`;

    if (this.roleContext) {
      return `${base}\n\n--- ROLE CONTEXT ---\n${this.roleContext}`;
    }
    return base;
  }

  async deliverMessage(msg: BufferedMessage): Promise<void> {
    this.messageBuffer.push(msg);
  }

  // --- Piggyback delivery ---

  protected wrapToolResult(result: string): string {
    if (this.messageBuffer.length === 0) {
      return result;
    }

    const pending = this.messageBuffer
      .map((m) => this.formatMessage(m))
      .join("\n");
    this.messageBuffer = [];

    return `[PENDING MESSAGES]\n${pending}\n[END PENDING MESSAGES]\n\n${result}`;
  }

  // --- Override all tool handlers to wrap results ---

  protected override async handleListPeers(args: any) {
    const result = await super.handleListPeers(args);
    return this.wrapResult(result);
  }

  protected override async handleSendMessage(args: any) {
    const result = await super.handleSendMessage(args);
    return this.wrapResult(result);
  }

  protected override async handleSetSummary(args: any) {
    const result = await super.handleSetSummary(args);
    return this.wrapResult(result);
  }

  protected override async handleCheckMessages() {
    const result = await super.handleCheckMessages();
    return this.wrapResult(result);
  }

  protected override async handleAssignRole(args: any) {
    const result = await super.handleAssignRole(args);
    return this.wrapResult(result);
  }

  protected override async handleRenamePeer(args: any) {
    const result = await super.handleRenamePeer(args);
    return this.wrapResult(result);
  }

  protected override async handleAcquireFile(args: any) {
    const result = await super.handleAcquireFile(args);
    return this.wrapResult(result);
  }

  protected override async handleReleaseFile(args: any) {
    const result = await super.handleReleaseFile(args);
    return this.wrapResult(result);
  }

  protected override async handleViewFileLocks() {
    const result = await super.handleViewFileLocks();
    return this.wrapResult(result);
  }

  protected override async handleGetHistory(args: any) {
    const result = await super.handleGetHistory(args);
    return this.wrapResult(result);
  }

  // --- Lifecycle tool wrappers (critical for message delivery) ---

  protected override async handleSignalDone(args: any) {
    const result = await super.handleSignalDone(args);
    return this.wrapResult(result);
  }

  protected override async handleSubmitFeedback(args: any) {
    const result = await super.handleSubmitFeedback(args);
    return this.wrapResult(result);
  }

  protected override async handleApprove(args: any) {
    const result = await super.handleApprove(args);
    return this.wrapResult(result);
  }

  protected override async handleCheckTeamStatus() {
    const result = await super.handleCheckTeamStatus();
    return this.wrapResult(result);
  }

  protected override async handleGetPlan() {
    const result = await super.handleGetPlan();
    return this.wrapResult(result);
  }

  protected override async handleUpdatePlan(args: any) {
    const result = await super.handleUpdatePlan(args);
    return this.wrapResult(result);
  }

  // --- Helper to wrap a tool result object ---

  private wrapResult(result: { content: { type: string; text: string }[]; isError?: boolean }) {
    const text = result.content[0]?.text ?? "";
    const wrapped = this.wrapToolResult(text);
    return {
      ...result,
      content: [{ type: "text" as const, text: wrapped }],
    };
  }
}
