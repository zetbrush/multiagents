#!/usr/bin/env bun
/**
 * CodexAdapter — MCP adapter for Codex CLI instances.
 *
 * Codex has no channel/push capability. Messages are delivered two ways:
 * 1. Piggybacked on multiagents MCP tool responses
 * 2. Written to a file-based inbox (.multiagents/inbox/<slot>.md) that
 *    Codex reads via native file tools — this is the PRIMARY delivery
 *    mechanism since Codex rarely calls multiagents MCP tools.
 */

import { BaseAdapter } from "./base-adapter.ts";
import type { BufferedMessage } from "../shared/types.ts";
import * as fs from "node:fs";
import * as path from "node:path";

export class CodexAdapter extends BaseAdapter {
  private messageBuffer: BufferedMessage[] = [];
  private inboxPath: string | null = null;
  private hasRunStartup = false;

  constructor() {
    super("codex");
  }

  getCapabilities(): Record<string, unknown> {
    return {
      tools: {},
    };
  }

  getSystemPrompt(): string {
    const inboxHint = this.inboxPath
      ? `\nYour INBOX FILE: ${this.inboxPath}`
      : "\nYour INBOX FILE: .multiagents/inbox/<your-name>.md (created after registration)";

    const base = `You are a team member on the multiagents network. You MUST use the multiagents-peer MCP tools to communicate. Your team CANNOT see your work unless you tell them.

═══ COMMUNICATION IS YOUR #1 PRIORITY ═══

You have MCP tools from the "multiagents-peer" server. USE THEM — not shell commands, not HTTP calls, not CLI scripts. The MCP tools are:
  set_summary, check_messages, send_message, check_team_status, get_plan,
  update_plan, signal_done, submit_feedback, approve, list_peers,
  acquire_file, release_file, view_file_locks, get_history

BEFORE ANY OTHER WORK — call these MCP tools in this exact order:
  1. set_summary → describe your task in one line
  2. check_team_status → see your teammates and their roles
  3. get_plan → see the plan and your assigned items
  4. check_messages → read pending messages from teammates

AFTER EVERY SHELL COMMAND OR FILE WRITE:
  → Call check_messages (teammates may have sent critical updates)
  → Call set_summary with what you just did

AFTER EVERY 2-3 TOOL CALLS:
  → Read your inbox file for real-time messages from teammates${inboxHint}

WHEN YOU FINISH YOUR TASK:
  → Call signal_done with what you built, tested, and results
  → Then call check_messages every 10s waiting for review feedback

WHEN A TEAMMATE MESSAGES YOU:
  → Reply via send_message IMMEDIATELY — they are blocked waiting on you

DO NOT:
  ✗ Work for 1+ minute without calling check_messages
  ✗ Finish without calling signal_done
  ✗ Ignore teammate messages
  ✗ Try to use CLI/HTTP to talk to the broker — use MCP tools only
  ✗ Go silent — if you have nothing to do, call check_team_status and set_summary "Idle, ready to help"

QUALITY: Production-grade code. Plan before coding. Verify before signaling done.`;

    if (this.roleContext) {
      return `${base}\n\n--- ROLE CONTEXT ---\n${this.roleContext}`;
    }
    return base;
  }

  /**
   * Deliver a message by both buffering (for piggyback) and writing to
   * the file-based inbox so Codex sees it via native file reads.
   */
  async deliverMessage(msg: BufferedMessage): Promise<void> {
    this.messageBuffer.push(msg);
    await this.writeToInbox(msg);
  }

  // --- File-based inbox ---

  /**
   * Resolve and ensure the inbox directory exists.
   * Path: <cwd>/.multiagents/inbox/<slot-id>.md
   */
  private ensureInboxPath(): string | null {
    if (this.inboxPath) return this.inboxPath;

    const slotId = this.mySlot?.id;
    const name = this.mySlot?.display_name ?? (slotId ? `slot-${slotId}` : null);
    if (!name) return null;

    const inboxDir = path.join(process.cwd(), ".multiagents", "inbox");
    try {
      if (!fs.existsSync(inboxDir)) {
        fs.mkdirSync(inboxDir, { recursive: true });
      }
    } catch {
      return null;
    }

    // Sanitize name to prevent path traversal (e.g. "../../etc/passwd")
    const safeName = path.basename(name).replace(/[^a-zA-Z0-9_\-. ]/g, "_");
    this.inboxPath = path.join(inboxDir, `${safeName}.md`);

    // Write initial header
    try {
      fs.writeFileSync(this.inboxPath, `# Inbox for ${name}\n\nMessages from teammates appear below. Newest at bottom.\n\n---\n\n`);
    } catch {
      // Best effort
    }

    return this.inboxPath;
  }

  /**
   * Append a message to the file-based inbox.
   * Codex can read this file with native tools at any time.
   */
  private async writeToInbox(msg: BufferedMessage): Promise<void> {
    const inboxPath = this.ensureInboxPath();
    if (!inboxPath) return;

    try {
      const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
      const from = msg.from_display_name ?? msg.from_role ?? msg.from_id;
      const entry = `**[${timestamp}] ${from}** (${msg.msg_type}):\n${msg.text}\n\n---\n\n`;
      fs.appendFileSync(inboxPath, entry);
    } catch {
      // Best effort — don't crash on write failure
    }
  }

  // --- Auto-startup: inject team context on first MCP tool call ---

  /**
   * On the FIRST MCP tool call from Codex, automatically:
   * 1. Set summary from role context
   * 2. Fetch team status
   * 3. Fetch pending messages
   * 4. Fetch plan
   * 5. Prepend all of this to the tool response
   *
   * This solves the timing problem: Codex starts executing 3-4s before MCP
   * tools are ready, so it never calls the startup sequence. By injecting
   * startup context into the first tool response, we guarantee the agent
   * gets team awareness regardless of which tool it calls first.
   */
  private async runAutoStartup(): Promise<string> {
    if (this.hasRunStartup) return "";
    this.hasRunStartup = true;

    const parts: string[] = [
      "╔══════════════════════════════════════════════════════════╗",
      "║  AUTO-STARTUP: Team context injected on first tool call ║",
      "╚══════════════════════════════════════════════════════════╝",
      "",
    ];

    // 1. Auto set_summary
    try {
      const role = this.mySlot?.role ?? "team member";
      const name = this.mySlot?.display_name ?? "agent";
      await this.broker.setSummary(this.myId!, `${name} (${role}) — starting up, reading team context`);
      parts.push(`✓ set_summary: Registered as ${name} (${role})`);
    } catch (e) {
      parts.push(`✗ set_summary failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 2. Team status
    try {
      const teamResult = await this.handleCheckTeamStatus();
      const teamText = teamResult.content[0]?.text ?? "";
      parts.push("", "── TEAM STATUS ──", teamText);
    } catch {
      parts.push("✗ check_team_status failed");
    }

    // 3. Plan
    try {
      const planResult = await this.handleGetPlan();
      const planText = planResult.content[0]?.text ?? "";
      parts.push("", "── YOUR PLAN ──", planText);
    } catch {
      parts.push("✗ get_plan failed");
    }

    // 4. Pending messages
    try {
      const msgResult = await this.handleCheckMessages();
      const msgText = msgResult.content[0]?.text ?? "";
      parts.push("", "── PENDING MESSAGES ──", msgText);
    } catch {
      parts.push("✗ check_messages failed");
    }

    parts.push(
      "",
      "── ACTION REQUIRED ──",
      "You now have full team context. Use multiagents-peer MCP tools to communicate:",
      "  → set_summary after every major action (so teammates see your progress)",
      "  → check_messages after every shell command (teammates may have updates)",
      "  → send_message to reply to teammates (they are waiting on you)",
      "  → signal_done when finished (with proof: test output, build results)",
      "  → update_plan to mark items in_progress/done as you work",
      "DO NOT go 1+ minute without calling check_messages.",
      "════════════════════════════════════════════════════════════",
      "",
    );

    return parts.join("\n");
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

  private async wrapResult(result: { content: { type: string; text: string }[]; isError?: boolean }) {
    const text = result.content[0]?.text ?? "";
    const startupContext = await this.runAutoStartup();
    const wrapped = this.wrapToolResult(text);
    return {
      ...result,
      content: [{ type: "text" as const, text: startupContext + wrapped }],
    };
  }
}
